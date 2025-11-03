// js/network_graph.js
const JSON_PATH = 'data/oa_coauth.json';
const TRANS_DUR = 450;
const SIM_ALPHA = 0.9;
const COOL_TIMEOUT = 900;

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch] || ch));
}

export async function init({ mount }) {
  const root = d3.select(mount);
  const container = root.select('#network-chart');
  const statusEl = root.select('#network-status');
  const filterSummaryEl = root.select('#network-filter-summary');
  const tooltip = root.select('#network-tooltip');
  const toggleBtn = root.select('#network-filter-toggle');
  const drawer = root.select('#network-filter-drawer');
  const shell = root.select('#network-filter-shell');
  const clearBtn = root.select('#network-filter-clear');

  const instSelect = root.select('#network-inst-select');
  const collabSelect = root.select('#network-collab-select');
  const yearToRange = root.select('#network-year-to-range');
  const yearToValue = root.select('#network-year-to-value');
  const edgeSlider = root.select('#network-edge-slider');
  const edgeValue = root.select('#network-edge-value');
  const searchBox = root.select('#network-search');
  const applyBtn = root.select('#network-apply');
  const resetBtn = root.select('#network-reset');
  const filterForm = root.select('#network-filter-form');
  const formatNumber = d3.format(',');

  let defaultFromYear = null;
  let defaultToYear = null;
  let edgeMinValue = +edgeSlider.attr('min') || 0;
  let filterOpen = false;

  if (!filterForm.empty()) {
    filterForm.on('submit', (event) => {
      event.preventDefault();
    });
  }

  function setFilterOpen(open) {
    filterOpen = open;
    drawer.classed('is-open', open);
    shell.classed('is-open', open);
    toggleBtn.attr('aria-expanded', open ? 'true' : 'false');
    toggleBtn.text(open ? 'Filters ▾' : 'Filters ▴');
  }

  const svg = container.append('svg')
    .attr('width', '100%')
    .attr('height', container.node().clientHeight || 720);

  const zoomBehavior = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoomBehavior).on('dblclick.zoom', null);

  const g = svg.append('g');
  const linkG = g.append('g').attr('class', 'links');
  const nodeG = g.append('g').attr('class', 'nodes');

  let simulation = null;
  let linkForce = null;
  let graph = null;
  let adjacency = null;
  let linkWidthFn = null;
  let linkOpacityFn = null;
  let rScaleFn = null;

  try {
    const res = await fetch(JSON_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) {
      throw new Error('JSON missing nodes/links');
    }

    prepareGraph(data);
    graph = data;

    const fromVal = (graph.config && Number.isInteger(graph.config.min_year)) ? graph.config.min_year : graph._computed_min_year;
    defaultFromYear = fromVal ?? 2000;
    defaultToYear = graph._computed_max_year || new Date().getFullYear();
    root.select('#network-from-fixed').text(defaultFromYear);
    yearToRange
      .attr('min', defaultFromYear)
      .attr('max', defaultToYear)
      .property('value', defaultToYear);
    yearToValue.text(defaultToYear);
    edgeMinValue = +edgeSlider.attr('min') || 0;
    edgeSlider.property('value', edgeMinValue);
    edgeValue.text(edgeMinValue);
    instSelect.property('value', 'main');
    collabSelect.property('value', 'main');

    statusEl.text(`Loaded graph — ${graph.nodes.length} nodes, ${graph.linksAll.length} links.`);

    renderGraph();

    yearToRange.on('input', function () {
      const toVal = +this.value;
      yearToValue.text(toVal);
      updateToLive(toVal);
      updateFilterSummary();
    });

    setFilterOpen(false);
    statusEl.text('Click a node to focus. Click background to reset.');
  } catch (err) {
    console.error(err);
    statusEl.text(`Error loading graph: ${err.message}`);
    throw err;
  }

  function prepareGraph(data) {
    data.nodes.forEach((n) => {
      n.pub_count = +(n.pub_count ?? n.pubs ?? 1);
      n.pubs = n.pub_count;
      n.weighted_degree = +(n.weighted_degree ?? 0);
      n.is_local = !!n.is_local;
      n.label = n.label ?? n.id;
      normalizeNodeArrays(n);
    });
    data.links.forEach((l) => normalizeLinkArrays(l));
    data.linksAll = data.links.slice();

    data.nodesById = new Map(data.nodes.map((n) => [n.id, n]));
    const nodesById = data.nodesById;
    data.linksAll.forEach((l) => {
      if (typeof l.source === 'string' || typeof l.source === 'number') {
        const s = nodesById.get(l.source);
        if (s) l.source = s;
      }
      if (typeof l.target === 'string' || typeof l.target === 'number') {
        const t = nodesById.get(l.target);
        if (t) l.target = t;
      }
    });

    let minY = Infinity;
    let maxY = -Infinity;
    if (data.config && Number.isInteger(data.config.min_year) && Number.isInteger(data.config.max_year)) {
      minY = data.config.min_year;
      maxY = data.config.max_year;
    } else {
      data.linksAll.forEach((l) => {
        if (Array.isArray(l.pub_years) && l.pub_years.length) {
          const yrs = l.pub_years.map((y) => +y).filter((y) => !Number.isNaN(y));
          if (yrs.length) {
            minY = Math.min(minY, yrs[0]);
            maxY = Math.max(maxY, yrs[yrs.length - 1]);
          }
        }
        if (l.counts_by_year && typeof l.counts_by_year === 'object') {
          for (const y of Object.keys(l.counts_by_year)) {
            const yy = +y;
            if (!Number.isNaN(yy)) {
              minY = Math.min(minY, yy);
              maxY = Math.max(maxY, yy);
            }
          }
        }
        if (l.role_pair_counts_by_year) {
          Object.values(l.role_pair_counts_by_year).forEach((obj) => {
            if (!obj) return;
            for (const y of Object.keys(obj)) {
              const yy = +y;
              if (!Number.isNaN(yy)) {
                minY = Math.min(minY, yy);
                maxY = Math.max(maxY, yy);
              }
            }
          });
        }
        if (Array.isArray(l.papers)) {
          l.papers.forEach((p) => {
            const yy = +(p.year ?? p.pub_year ?? 0);
            if (!Number.isNaN(yy)) {
              minY = Math.min(minY, yy);
              maxY = Math.max(maxY, yy);
            }
          });
        }
      });
      data.nodes.forEach((n) => {
        if (n.first_year && +n.first_year >= 1800) minY = Math.min(minY, +n.first_year);
        if (n.last_year && +n.last_year >= 1800) maxY = Math.max(maxY, +n.last_year);
      });
      if (!Number.isFinite(minY)) minY = 2000;
      if (!Number.isFinite(maxY)) maxY = new Date().getFullYear();
    }

    data._computed_min_year = minY;
    data._computed_max_year = maxY;

    computeBaselineNodeMaps(data);
  }

  function renderGraph() {
    linkG.selectAll('*').remove();
    nodeG.selectAll('*').remove();

    const nodes = graph.nodes;
    let linksCurrent = graph.linksAll.slice();

    const baselineMaxAny = graph._baselineNodeCumAnyMax || 1;
    const baseRScale = d3.scaleSqrt().domain([0, Math.max(1, baselineMaxAny)]).range([5, 28]);
    rScaleFn = (value) => baseRScale(value);

    const linkWeightValues = graph.linksAll.map((d) => +d._weight);
    let linkWeightExtent = d3.extent(linkWeightValues);
    if (linkWeightExtent[0] === linkWeightExtent[1]) {
      linkWeightExtent[0] = Math.max(0, linkWeightExtent[0] - 1);
      linkWeightExtent[1] = linkWeightExtent[1] + 1;
    }
    const linkWidthScale = d3.scaleSqrt().domain(linkWeightExtent).range([0.6, 6]);
    const linkOpacityScale = d3.scaleLinear().domain([0, 1]).range([0.12, 1]);
    linkWidthFn = (w) => linkWidthScale(w);
    linkOpacityFn = (f) => linkOpacityScale(f);

    const MIN_LINK_DIST = 30;
    const MAX_LINK_DIST = 180;
    const weightToDistance = (w) => {
      const base = Math.sqrt((w || 0) + 1);
      return Math.max(MIN_LINK_DIST, Math.min(MAX_LINK_DIST, Math.round(MAX_LINK_DIST / base)));
    };

    linkG.selectAll('line')
      .data(linksCurrent, (d) => d.id ?? `${(d.source.id || d.source)}|${(d.target.id || d.target)}`)
      .enter()
      .append('line')
      .attr('class', 'link')
      .attr('stroke', '#999')
      .attr('stroke-width', (d) => linkWidthScale(d._weight))
      .style('opacity', (d) => linkOpacityScale(d._w_frac))
      .style('display', (d) => (d._weight >= +edgeSlider.node().value ? null : 'none'));

    const nodeSel = nodeG.selectAll('g')
      .data(nodes, (d) => d.id)
      .enter()
      .append('g')
      .attr('class', 'node')
      .call(d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended));

    nodeSel.append('circle')
      .attr('r', (d) => baseRScale(computeNodeCumulative(d, 'any', graph._computed_min_year, +yearToRange.node().value)))
      .attr('fill', (d) => (d.is_local ? '#1f77b4' : '#ff7f0e'))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.2);

    nodeSel.append('circle')
      .attr('class', 'local-ring')
      .attr('r', (d) => baseRScale(computeNodeCumulative(d, 'any', graph._computed_min_year, +yearToRange.node().value)) + 4)
      .attr('fill', 'none')
      .attr('stroke', (d) => (d.is_local ? '#003f5c' : '#999'))
      .attr('stroke-width', (d) => (d.is_local ? 1.6 : 0.6))
      .attr('stroke-dasharray', (d) => (d.is_local ? '4,2' : '1,0'))
      .style('opacity', (d) => (d.is_local ? 0.9 : 0.1));

    nodeSel.on('mouseover', (event, d) => {
      const toY = +yearToRange.node().value;
      const fromY = defaultFromYear;
      const instFilter = instSelect.node().value;
      const cumulative = computeNodeCumulative(d, instFilter, fromY, toY);
      const labelInst = instFilter === 'main' ? 'Main authorship' : 'Any authorship';
      tooltip
        .style('display', 'block')
        .html(
          `<strong>${escapeHtml(d.label || d.id)}</strong>` +
          `<div>Publications: ${formatNumber(d.pub_count || 0)}</div>` +
          `<div>Weighted degree: ${formatNumber(d.weighted_degree || 0)}</div>` +
          `<div>${labelInst}: ${formatNumber(cumulative)} (to ${toY})</div>`
        )
        .style('left', `${event.pageX + 12}px`)
        .style('top', `${event.pageY + 12}px`);
    })
      .on('mousemove', (event) => {
        tooltip
          .style('left', `${event.pageX + 10}px`)
          .style('top', `${event.pageY + 10}px`);
      })
      .on('mouseout', () => tooltip.style('display', 'none'));

    linkForce = d3.forceLink(linksCurrent).id((d) => d.id).distance((d) => weightToDistance(d._weight)).strength(0.7);
    simulation = d3.forceSimulation(nodes)
      .force('link', linkForce)
      .force('charge', d3.forceManyBody().strength(-160))
      .force('center', d3.forceCenter(container.node().clientWidth / 2, container.node().clientHeight / 2))
      .force('collision', d3.forceCollide().radius((d) => baseRScale(computeNodeCumulative(d, 'any', graph._computed_min_year, +yearToRange.node().value)) + 6))
      .on('tick', ticked);

    function ticked() {
      linkG.selectAll('line')
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);

      nodeG.selectAll('g')
        .attr('transform', (d) => `translate(${d.x},${d.y})`);
    }

    adjacency = buildAdjacency({ nodes, links: graph.linksAll });

    let isStar = false;
    let lastFocused = null;

    nodeG.selectAll('g.node').on('click', (event, d) => {
      event.stopPropagation();
      if (isStar && lastFocused && lastFocused.id === d.id) {
        resetLayout();
        return;
      }
      focusStar(d);
    });

    svg.on('click', () => {
      if (isStar) resetLayout();
    });

    setTimeout(() => {
      simulation.alpha(0.9).restart();
      setTimeout(() => simulation.alphaTarget(0), 1200);
    }, 50);



    edgeSlider.on('input', () => {
      const thr = +edgeSlider.node().value;
      edgeValue.text(thr);
      linkG.selectAll('line').style('display', (d) => ((d._weight_current ?? d._weight) >= thr ? null : 'none'));
      const visibleNodeIds = new Set(
        graph.linksAll
          .filter((l) => ((l._weight_current ?? l._weight) >= thr))
          .flatMap((l) => [
            (typeof l.source === 'object' ? l.source.id : l.source),
            (typeof l.target === 'object' ? l.target.id : l.target)
          ])
      );
      nodeG.selectAll('g.node')
        .transition()
        .duration(160)
        .style('opacity', (d) => (visibleNodeIds.has(d.id) ? 1 : 0.12));
      updateFilterSummary();
    });

    instSelect.on('change', () => updateFilterSummary());
    collabSelect.on('change', () => updateFilterSummary());

    applyBtn.on('click', () => {
      applyFilters();
      setFilterOpen(false);
    });

    searchBox.on('keydown', function (event) {
      if (event.key === 'Enter') {
        const q = this.value.trim().toLowerCase();
        if (!q) return;
        const found = nodes.find((n) => (n.label || '').toLowerCase().includes(q));
        if (found) {
          nodeG.selectAll('g.node').filter((d) => d.id === found.id).dispatch('click');
          setTimeout(() => centerOnNode(found, 1.6), 250);
        } else {
          alert('No match');
        }
      }
    });

    searchBox.on('input', () => updateFilterSummary());

    resetBtn.on('click', () => {
      resetFilters();
      setFilterOpen(false);
    });

    clearBtn.on('click', () => {
      resetFilters();
      setFilterOpen(false);
    });

    toggleBtn.on('click', () => setFilterOpen(!filterOpen));

    applyFilters();

    function focusStar(centerNode) {
      isStar = true;
      lastFocused = centerNode;

      const instFilter = instSelect.node().value;
      const collabFilter = collabSelect.node().value;
      const toY = +yearToRange.node().value;
      const edgeThreshold = +edgeSlider.node().value;

      let previewLinks = graph.linksAll.filter((l) => (l._weight_current || 0) >= edgeThreshold);

      if (instFilter === 'main') {
        previewLinks = previewLinks.filter((l) => {
          const sid = typeof l.source === 'object' ? l.source.id : l.source;
          const tid = typeof l.target === 'object' ? l.target.id : l.target;
          const sNode = graph.nodesById.get(sid);
          const tNode = graph.nodesById.get(tid);
          return (sNode && sNode.is_local) || (tNode && tNode.is_local);
        });
      }

      const centerId = centerNode.id;
      const neighIdsSet = new Set();
      previewLinks.forEach((l) => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        if (sid === centerId) neighIdsSet.add(tid);
        else if (tid === centerId) neighIdsSet.add(sid);
      });
      const neighbors = graph.nodes.filter((n) => neighIdsSet.has(n.id));

      const centerX = container.node().clientWidth / 2;
      const centerY = container.node().clientHeight / 2;
      const innerRadius = Math.max(120, 40 + neighbors.length * 12);
      neighbors.forEach((n, i) => {
        const angle = (i / Math.max(1, neighbors.length)) * 2 * Math.PI;
        n.fx = centerX + Math.cos(angle) * innerRadius;
        n.fy = centerY + Math.sin(angle) * innerRadius;
      });
      centerNode.fx = centerX;
      centerNode.fy = centerY;

      nodeG.selectAll('g.node')
        .transition()
        .duration(TRANS_DUR)
        .style('opacity', (d) => (d.id === centerId || neighIdsSet.has(d.id) ? 1 : 0))
        .on('end', function (d) {
          if (!(d.id === centerId || neighIdsSet.has(d.id))) d3.select(this).style('pointer-events', 'none');
        });

      linkG.selectAll('line').each(function (l) {
        const el = d3.select(this);
        const lw = l._weight_current || l._weight || 0;
        const inPreview = (lw >= edgeThreshold) && previewLinks.some((pl) => {
          const pSid = typeof pl.source === 'object' ? pl.source.id : pl.source;
          const pTid = typeof pl.target === 'object' ? pl.target.id : pl.target;
          const lSid = typeof l.source === 'object' ? l.source.id : l.source;
          const lTid = typeof l.target === 'object' ? l.target.id : l.target;
          return (pSid === lSid && pTid === lTid) || (pSid === lTid && pTid === lSid);
        });

        if (!inPreview) {
          el.style('display', 'none');
          return;
        }
        el.style('display', null);
        el.transition().duration(TRANS_DUR)
          .style('opacity', ((typeof l.source === 'object' ? l.source.id : l.source) === centerId || (typeof l.target === 'object' ? l.target.id : l.target) === centerId) ? 1 : 0.08);
      });

      simulation.alpha(SIM_ALPHA).restart();
      setTimeout(() => simulation.alphaTarget(0), COOL_TIMEOUT);

      statusEl.text(`Focused: ${centerNode.label || centerNode.id} — ${neighbors.length} coauthors`);
      showInfo(centerNode, neighbors.length);
    }

    function resetLayout() {
      isStar = false;
      lastFocused = null;
      nodeG.selectAll('g.node').style('pointer-events', 'auto');
      nodeG.selectAll('g.node').transition().duration(TRANS_DUR).style('opacity', 1);
      linkG.selectAll('line').transition().duration(TRANS_DUR).style('opacity', (d) => (d._w_frac ? linkOpacityFn(d._w_frac) : 1));
      nodes.forEach((n) => { n.fx = null; n.fy = null; });
      simulation.alpha(SIM_ALPHA).restart();
      setTimeout(() => simulation.alphaTarget(0), COOL_TIMEOUT);
      statusEl.text(`Graph reset — ${nodes.length} nodes, ${graph.linksAll.length} links.`);
    }

    function applyFilters() {
      if (!graph) return;
      const instFilter = instSelect.node().value;
      const collabFilter = collabSelect.node().value;
      const defaultFrom = defaultFromYear;
      const defaultTo = +yearToRange.node().value || defaultToYear || new Date().getFullYear();
      const edgeThreshold = +edgeSlider.node().value;

      graph.linksAll.forEach((l) => {
        l._weight_current = computeWeightForLinkCombined(l, instFilter, collabFilter, defaultFrom, defaultTo);
        l._w_frac_current = (l._weight_current && l._weight) ? (l._weight_current / (l._weight || 1)) : (l._weight_current > 0 ? 1 : 0);
      });

      let activeLinksForPhysics = graph.linksAll.filter((l) => l._weight_current > 0);

      if (instFilter === 'main') {
        activeLinksForPhysics = activeLinksForPhysics.filter((l) => {
          const sid = typeof l.source === 'object' ? l.source.id : l.source;
          const tid = typeof l.target === 'object' ? l.target.id : l.target;
          const sNode = graph.nodesById.get(sid);
          const tNode = graph.nodesById.get(tid);
          const sLocal = sNode && sNode.is_local;
          const tLocal = tNode && tNode.is_local;
          return sLocal || tLocal;
        });
      }

      const nodeCumulatives = new Map();
      graph.nodes.forEach((n) => {
        const val = computeNodeCumulative(n, instFilter, defaultFrom, defaultTo);
        nodeCumulatives.set(n.id, val);
      });

      const visibleNodeIdsFromLinks = new Set(
        activeLinksForPhysics
          .filter((l) => (l._weight_current >= edgeThreshold))
          .flatMap((l) => [
            (typeof l.source === 'object' ? l.source.id : l.source),
            (typeof l.target === 'object' ? l.target.id : l.target)
          ])
      );
      const visibleNodeIds = new Set(visibleNodeIdsFromLinks);
      for (const [id, val] of nodeCumulatives.entries()) {
        if (val > 0) visibleNodeIds.add(id);
      }

      if (instFilter === 'main' && collabFilter === 'main') {
        const adj = buildAdjacency({ nodes: graph.nodes, links: activeLinksForPhysics });
        const pruned = new Set();
        visibleNodeIds.forEach((id) => {
          const node = graph.nodesById.get(id);
          if (!node) return;
          if (node.is_local) {
            pruned.add(id);
            return;
          }
          const neigh = adj.get(id) || new Set();
          let hasLocal = false;
          for (const nid of neigh) {
            const n = graph.nodesById.get(nid);
            if (n && n.is_local) { hasLocal = true; break; }
          }
          if (hasLocal) pruned.add(id);
        });
        visibleNodeIds.clear();
        pruned.forEach((x) => visibleNodeIds.add(x));
      }

      const visibleNodes = graph.nodes.filter((n) => visibleNodeIds.has(n.id));

      const visibleNodeSet = new Set(visibleNodes.map((n) => n.id));
      activeLinksForPhysics = activeLinksForPhysics.filter((l) => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return visibleNodeSet.has(sid) && visibleNodeSet.has(tid);
      });

      const linkKey = (d) => d.id ?? `${(typeof d.source === 'object' ? d.source.id : d.source)}|${(typeof d.target === 'object' ? d.target.id : d.target)}`;
      let linkSel = linkG.selectAll('line').data(activeLinksForPhysics, linkKey);
      linkSel.exit().transition().duration(250).style('opacity', 0).remove();
      const linkEnter = linkSel.enter().append('line')
        .attr('class', 'link')
        .style('opacity', 0)
        .attr('stroke-width', (d) => (linkWidthFn ? linkWidthFn(d._weight_current || d._weight || 1) : 1));
      linkSel = linkEnter.merge(linkSel);
      linkSel.transition().duration(350)
        .attr('stroke-width', (d) => (linkWidthFn ? linkWidthFn(d._weight_current || d._weight || 1) : 1))
        .style('opacity', (d) => (linkOpacityFn ? linkOpacityFn(d._w_frac_current ?? d._w_frac ?? 1) : 1))
        .style('display', (d) => ((d._weight_current ?? d._weight) >= edgeThreshold ? null : 'none'));

      let nodeSelFiltered = nodeG.selectAll('g.node').data(visibleNodes, (d) => d.id);
      const nodeExit = nodeSelFiltered.exit();
      nodeExit.select('circle').transition().duration(280).attr('r', 0);
      nodeExit.transition().duration(300).style('opacity', 0).remove();

      const nodeEnter = nodeSelFiltered.enter().append('g')
        .attr('class', 'node')
        .call(d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended));

      nodeEnter.append('circle')
        .attr('r', 0)
        .attr('fill', (d) => (d.is_local ? '#1f77b4' : '#ff7f0e'))
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.2);

      nodeEnter.append('circle')
        .attr('class', 'local-ring')
        .attr('r', 0)
        .attr('fill', 'none')
        .attr('stroke', (d) => (d.is_local ? '#003f5c' : '#999'))
        .attr('stroke-width', (d) => (d.is_local ? 1.6 : 0.6))
        .attr('stroke-dasharray', (d) => (d.is_local ? '4,2' : '1,0'))
        .style('opacity', (d) => (d.is_local ? 0.9 : 0.1));

      nodeEnter.on('mouseover', (event, d) => {
        const toY = +yearToRange.node().value;
        const fromY = defaultFromYear;
        const inst = instSelect.node().value;
        const cumulative = computeNodeCumulative(d, inst, fromY, toY);
        const labelInst = inst === 'main' ? 'Main authorship' : 'Any authorship';
        tooltip
          .style('display', 'block')
          .html(
            `<strong>${escapeHtml(d.label || d.id)}</strong>` +
            `<div>Publications: ${formatNumber(d.pub_count || 0)}</div>` +
            `<div>Weighted degree: ${formatNumber(d.weighted_degree || 0)}</div>` +
            `<div>${labelInst}: ${formatNumber(cumulative)} (to ${toY})</div>`
          )
          .style('left', `${event.pageX + 12}px`)
          .style('top', `${event.pageY + 12}px`);
      })
        .on('mousemove', (event) => {
          tooltip
            .style('left', `${event.pageX + 12}px`)
            .style('top', `${event.pageY + 12}px`);
        })
        .on('mouseout', () => tooltip.style('display', 'none'));

      nodeSelFiltered = nodeEnter.merge(nodeSelFiltered);

      nodeSelFiltered.on('click', (event, d) => {
        event.stopPropagation();
        if (isStar && lastFocused && lastFocused.id === d.id) {
          resetLayout();
          return;
        }
        focusStar(d);
      });

      const baselineMax = (instFilter === 'main' ? graph._baselineNodeCumMainMax : graph._baselineNodeCumAnyMax) || 1;
      const rScale = d3.scaleSqrt().domain([0, Math.max(1, baselineMax)]).range([5, 28]);
      rScaleFn = (value) => rScale(value);

      nodeSelFiltered.select('circle')
        .transition()
        .duration(400)
        .attr('r', (d) => rScale(+(nodeCumulatives.get(d.id) || 0)));
      nodeSelFiltered.select('.local-ring')
        .transition()
        .duration(400)
        .attr('r', (d) => rScale(+(nodeCumulatives.get(d.id) || 0)) + 4);

      const simNodes = visibleNodes;
      simulation.nodes(simNodes);
      try {
        linkForce.links(activeLinksForPhysics);
      } catch (e) {
        linkForce = d3.forceLink(activeLinksForPhysics).id((d) => d.id).distance((d) => 50).strength(0.7);
        simulation.force('link', linkForce);
      }

      linkForce.distance((d) => {
        const w = d._weight_current || d._weight || 1;
        const base = Math.sqrt((w || 0) + 1);
        return Math.max(30, Math.min(180, Math.round(180 / base)));
      });

      const newCollision = d3.forceCollide().radius((d) => {
        const val = +(nodeCumulatives.get(d.id) || 0);
        return rScale(val) + 6;
      });
      simulation.force('collision', newCollision);

      const centerX = container.node().clientWidth / 2;
      const centerY = container.node().clientHeight / 2;
      simulation.force('x', d3.forceX(centerX).strength(0.01));
      simulation.force('y', d3.forceY(centerY).strength(0.01));

      simulation.alpha(0.9).restart();
      setTimeout(() => simulation.alphaTarget(0), 1100);

      statusEl.text(`Visible nodes: ${visibleNodes.length} / ${graph.nodes.length} — visible links: ${activeLinksForPhysics.length}`);
      updateFilterSummary();

      adjacency = buildAdjacency({ nodes: simNodes, links: activeLinksForPhysics });
      graph._adjacencyActive = adjacency;
    }
  }

  function resetFilters() {
    if (!graph) return;
    instSelect.property('value', 'main');
    collabSelect.property('value', 'main');
    const to = defaultToYear || graph._computed_max_year || new Date().getFullYear();
    yearToRange.property('value', to);
    yearToValue.text(to);
    edgeSlider.property('value', edgeMinValue);
    edgeValue.text(edgeMinValue);
    searchBox.property('value', '');
    applyFilters();
    updateToLive(to);
  }

  function prefixSum(arr) {
    const out = [];
    let s = 0;
    for (let i = 0; i < (arr || []).length; i += 1) {
      s += (arr[i] || 0);
      out[i] = s;
    }
    return out;
  }

  function bisectRightLE(arr, x) {
    if (!Array.isArray(arr)) return -1;
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] <= x) {
        ans = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return ans;
  }

  function cumRangeFromCumArrays(yearsArr, cumArr, fromY, toY) {
    if (!Array.isArray(yearsArr) || !Array.isArray(cumArr) || yearsArr.length !== cumArr.length) return 0;
    const iTo = bisectRightLE(yearsArr, toY);
    if (iTo < 0) return 0;
    const iFromPrev = bisectRightLE(yearsArr, fromY - 1);
    const toVal = cumArr[iTo] || 0;
    const fromPrevVal = (iFromPrev >= 0 ? (cumArr[iFromPrev] || 0) : 0);
    return Math.max(0, toVal - fromPrevVal);
  }

  function sumCountsInWindowMap(m, fromY, toY) {
    if (!m || typeof m !== 'object') return 0;
    let s = 0;
    for (const [ys, c] of Object.entries(m)) {
      const y = +ys;
      if (y >= fromY && y <= toY) s += (+c || 0);
    }
    return s;
  }

  function normalizeLinkArrays(l) {
    if (!Array.isArray(l.pub_years)) l.pub_years = Array.isArray(l.pub_years) ? l.pub_years : [];
    if (!Array.isArray(l.counts_by_year) && l.counts_by_year && typeof l.counts_by_year === 'object') {
      const keys = Object.keys(l.counts_by_year).map((s) => +s).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      const yrs = (Array.isArray(l.pub_years) && l.pub_years.length) ? l.pub_years : keys;
      l.pub_years = yrs;
      l.counts_by_year = yrs.map((y) => +(l.counts_by_year[String(y)] || 0));
    } else {
      l.counts_by_year = Array.isArray(l.counts_by_year) ? l.counts_by_year : [];
    }
    l.counts_by_year_cum = (Array.isArray(l.counts_by_year_cum) && l.counts_by_year_cum.length === l.counts_by_year.length) ? l.counts_by_year_cum : prefixSum(l.counts_by_year);

    l.role_pair_counts_by_year_arrays = l.role_pair_counts_by_year_arrays || {};
    l.role_pair_counts_by_year_cum = l.role_pair_counts_by_year_cum || {};
    const roles = ['either_main', 'both_main', 'source_main', 'target_main'];
    roles.forEach((role) => {
      if (Array.isArray(l.role_pair_counts_by_year_cum[role]) && Array.isArray(l.pub_years) && l.role_pair_counts_by_year_cum[role].length === l.pub_years.length) {
        // ok
      } else if (Array.isArray(l.role_pair_counts_by_year_arrays[role]) && Array.isArray(l.pub_years) && l.role_pair_counts_by_year_arrays[role].length === l.pub_years.length) {
        l.role_pair_counts_by_year_cum[role] = prefixSum(l.role_pair_counts_by_year_arrays[role]);
      } else if (l.role_pair_counts_by_year && l.role_pair_counts_by_year[role] && typeof l.role_pair_counts_by_year[role] === 'object') {
        const yrs = (Array.isArray(l.pub_years) && l.pub_years.length) ? l.pub_years : Object.keys(l.role_pair_counts_by_year[role]).map((s) => +s).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
        const arr = yrs.map((y) => +(l.role_pair_counts_by_year[role][String(y)] || 0));
        l.role_pair_counts_by_year_arrays[role] = arr;
        l.role_pair_counts_by_year_cum[role] = prefixSum(arr);
        if (!Array.isArray(l.pub_years) || l.pub_years.length === 0) l.pub_years = yrs;
      } else {
        l.role_pair_counts_by_year_arrays[role] = Array.isArray(l.role_pair_counts_by_year_arrays[role]) ? l.role_pair_counts_by_year_arrays[role] : (Array.isArray(l.pub_years) ? l.pub_years.map(() => 0) : []);
        l.role_pair_counts_by_year_cum[role] = prefixSum(l.role_pair_counts_by_year_arrays[role]);
      }
    });

    l._weight = +(l.weight_full ?? l.papers_count ?? l._weight ?? 0);
    l._w_frac = +(l.weight_fractional ?? l._w_frac ?? (l._weight > 0 ? 1 : 0));
  }

  function normalizeNodeArrays(n) {
    n.pub_years = Array.isArray(n.pub_years) ? n.pub_years : [];
    if (Array.isArray(n.main_pubs_by_year) && n.pub_years.length === n.main_pubs_by_year.length) {
      n.main_pubs_by_year_cum = Array.isArray(n.main_pubs_by_year_cum) && n.main_pubs_by_year_cum.length === n.pub_years.length ? n.main_pubs_by_year_cum : prefixSum(n.main_pubs_by_year);
    } else if (n.main_pubs_by_year && typeof n.main_pubs_by_year === 'object') {
      const yrs = (Array.isArray(n.pub_years) && n.pub_years.length) ? n.pub_years : Object.keys(n.main_pubs_by_year).map((s) => +s).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      n.pub_years = yrs;
      n.main_pubs_by_year = yrs.map((y) => +(n.main_pubs_by_year[String(y)] || 0));
      n.main_pubs_by_year_cum = prefixSum(n.main_pubs_by_year);
    } else {
      if (!Array.isArray(n.main_pubs_by_year)) n.main_pubs_by_year = (Array.isArray(n.pub_years) ? n.pub_years.map(() => 0) : []);
      if (!Array.isArray(n.main_pubs_by_year_cum) || n.main_pubs_by_year_cum.length !== n.pub_years.length) n.main_pubs_by_year_cum = prefixSum(n.main_pubs_by_year);
    }

    if (!Array.isArray(n.counts_by_year) && n.counts_by_year && typeof n.counts_by_year === 'object') {
      const keys = Object.keys(n.counts_by_year).map((s) => +s).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      const yrs = (Array.isArray(n.pub_years) && n.pub_years.length) ? n.pub_years : keys;
      n.pub_years = yrs;
      n.counts_by_year = yrs.map((y) => +(n.counts_by_year[String(y)] || 0));
    } else {
      n.counts_by_year = Array.isArray(n.counts_by_year) ? n.counts_by_year : [];
    }
    n.counts_by_year_cum = (Array.isArray(n.counts_by_year_cum) && n.counts_by_year_cum.length === n.counts_by_year.length) ? n.counts_by_year_cum : prefixSum(n.counts_by_year);
  }

  function computeNodeCumulative(node, instFilter, fromY, toY) {
    if (!node) return 0;
    if (instFilter === 'main') {
      if (Array.isArray(node.pub_years) && Array.isArray(node.main_pubs_by_year_cum) && node.pub_years.length === node.main_pubs_by_year_cum.length) {
        return cumRangeFromCumArrays(node.pub_years, node.main_pubs_by_year_cum, fromY, toY);
      }
      if (node.main_pubs_by_year && typeof node.main_pubs_by_year === 'object') return sumCountsInWindowMap(node.main_pubs_by_year, fromY, toY);
    }
    if (Array.isArray(node.pub_years) && Array.isArray(node.counts_by_year_cum) && node.pub_years.length === node.counts_by_year_cum.length) {
      return cumRangeFromCumArrays(node.pub_years, node.counts_by_year_cum, fromY, toY);
    }
    if (node.counts_by_year && typeof node.counts_by_year === 'object') return sumCountsInWindowMap(node.counts_by_year, fromY, toY);
    return +(node.pub_count || node.pubs || 0);
  }

  function computeCombinedRoleKey(instFilter, collabFilter) {
    if (instFilter === 'any' && collabFilter === 'any') return 'counts_by_year';
    if (instFilter === 'main' && collabFilter === 'any') return 'source_main';
    if (instFilter === 'any' && collabFilter === 'main') return 'target_main';
    if (instFilter === 'main' && collabFilter === 'main') return 'both_main';
    return 'counts_by_year';
  }

  function computeWeightForLinkCombined(l, instFilter, collabFilter, fromY, toY) {
    const key = computeCombinedRoleKey(instFilter, collabFilter);

    if (key === 'counts_by_year') {
      if (Array.isArray(l.pub_years) && Array.isArray(l.counts_by_year_cum) && l.pub_years.length === l.counts_by_year_cum.length) {
        return cumRangeFromCumArrays(l.pub_years, l.counts_by_year_cum, fromY, toY);
      }
      if (l.counts_by_year && typeof l.counts_by_year === 'object') return sumCountsInWindowMap(l.counts_by_year, fromY, toY);
    } else {
      if (l.role_pair_counts_by_year_cum && Array.isArray(l.role_pair_counts_by_year_cum[key]) && Array.isArray(l.pub_years) && l.role_pair_counts_by_year_cum[key].length === l.pub_years.length) {
        return cumRangeFromCumArrays(l.pub_years, l.role_pair_counts_by_year_cum[key], fromY, toY);
      }
      if (l.role_pair_counts_by_year_arrays && Array.isArray(l.role_pair_counts_by_year_arrays[key]) && Array.isArray(l.pub_years) && l.role_pair_counts_by_year_arrays[key].length === l.pub_years.length) {
        const cum = prefixSum(l.role_pair_counts_by_year_arrays[key]);
        return cumRangeFromCumArrays(l.pub_years, cum, fromY, toY);
      }
      if (l.role_pair_counts_by_year && l.role_pair_counts_by_year[key] && typeof l.role_pair_counts_by_year[key] === 'object') {
        return sumCountsInWindowMap(l.role_pair_counts_by_year[key], fromY, toY);
      }
      if (l.role_pair_totals && typeof l.role_pair_totals[key] !== 'undefined') return +l.role_pair_totals[key];
    }

    if (Array.isArray(l.papers) && l.papers.length) {
      let s = 0;
      for (const p of l.papers) {
        const y = +(p.year ?? p.pub_year ?? p.year_published ?? 0);
        if (Number.isNaN(y) || y < fromY || y > toY) continue;
        const srcMain = (p.source_pos === 'first' || p.source_pos === 'last');
        const tgtMain = (p.target_pos === 'first' || p.target_pos === 'last');
        if (key === 'counts_by_year') s += 1;
        else if (key === 'source_main' && srcMain) s += 1;
        else if (key === 'target_main' && tgtMain) s += 1;
        else if (key === 'both_main' && srcMain && tgtMain) s += 1;
      }
      return s;
    }

    return +(l._weight || 0);
  }

  function computeBaselineNodeMaps(g) {
    if (!g) return;
    const defaultFrom = (g.config && Number.isInteger(g.config.min_year)) ? g.config.min_year : g._computed_min_year || 2000;
    const defaultTo = (g.config && Number.isInteger(g.config.max_year)) ? g.config.max_year : g._computed_max_year || new Date().getFullYear();

    const mapAny = new Map();
    const mapMain = new Map();
    g.nodes.forEach((n) => {
      const vAny = computeNodeCumulative(n, 'any', defaultFrom, defaultTo);
      const vMain = computeNodeCumulative(n, 'main', defaultFrom, defaultTo);
      mapAny.set(n.id, vAny);
      mapMain.set(n.id, vMain);
      n._cum_full_any = vAny;
      n._cum_full_main = vMain;
    });
    g._baselineNodeCumAnyMap = mapAny;
    g._baselineNodeCumMainMap = mapMain;
    g._baselineNodeCumAnyMax = d3.max(Array.from(mapAny.values())) || 1;
    g._baselineNodeCumMainMax = d3.max(Array.from(mapMain.values())) || 1;
  }

  function updateToLive(toY) {
    if (!graph) return;
    const fromY = defaultFromYear;
    const instFilter = instSelect.node().value;
    const collabFilter = collabSelect.node().value;
    const edgeThreshold = +edgeSlider.node().value;

    graph.linksAll.forEach((l) => {
      l._weight_current = computeWeightForLinkCombined(l, instFilter, collabFilter, fromY, toY);
      l._w_frac_current = (l._weight_current && l._weight) ? (l._weight_current / (l._weight || 1)) : (l._weight_current > 0 ? 1 : 0);
    });

    linkG.selectAll('line').each(function (d) {
      const el = d3.select(this);
      const w = d._weight_current ?? d._weight ?? 0;
      if (w < edgeThreshold) el.style('display', 'none');
      else {
        el.style('display', null);
        if (linkWidthFn) el.transition().duration(170).attr('stroke-width', linkWidthFn(w));
        if (linkOpacityFn) el.transition().duration(170).style('opacity', linkOpacityFn(d._w_frac_current ?? d._w_frac ?? 1));
      }
    });

    const baselineMax = (instFilter === 'main' ? graph._baselineNodeCumMainMax : graph._baselineNodeCumAnyMax) || 1;
    const rScaleLive = d3.scaleSqrt().domain([0, Math.max(1, baselineMax)]).range([5, 28]);
    rScaleFn = (value) => rScaleLive(value);

    nodeG.selectAll('g.node').select('circle').each(function (d) {
      const el = d3.select(this);
      const nodeVal = computeNodeCumulative(d, instFilter, fromY, toY);
      el.transition().duration(200).attr('r', rScaleLive(nodeVal));
      const ring = d3.select(this.parentNode).select('.local-ring');
      if (ring.size()) ring.transition().duration(200).attr('r', rScaleLive(nodeVal) + 4);
    });

    let previewLinks = graph.linksAll.filter((l) => l._weight_current > 0);
    if (instFilter === 'main') {
      previewLinks = previewLinks.filter((l) => {
        const sid = (typeof l.source === 'object') ? l.source.id : l.source;
        const tid = (typeof l.target === 'object') ? l.target.id : l.target;
        const sNode = graph.nodesById.get(sid);
        const tNode = graph.nodesById.get(tid);
        return (sNode && sNode.is_local) || (tNode && tNode.is_local);
      });
    }
    const previewAdj = buildAdjacency({ nodes: graph.nodes, links: previewLinks });

    const nodePreviewMap = new Map();
    graph.nodes.forEach((n) => { nodePreviewMap.set(n.id, computeNodeCumulative(n, instFilter, fromY, toY)); });

    const visibleNodeIdsFromLinks = new Set();
    previewLinks.forEach((l) => {
      if ((l._weight_current || 0) >= edgeThreshold) {
        const sid = (typeof l.source === 'object') ? l.source.id : l.source;
        const tid = (typeof l.target === 'object') ? l.target.id : l.target;
        if (sid) visibleNodeIdsFromLinks.add(sid);
        if (tid) visibleNodeIdsFromLinks.add(tid);
      }
    });

    const visibleNodeIds = new Set(visibleNodeIdsFromLinks);
    for (const [id, val] of nodePreviewMap.entries()) {
      if (val > 0) visibleNodeIds.add(id);
    }

    if (instFilter === 'main' && collabFilter === 'main') {
      const pruned = new Set();
      visibleNodeIds.forEach((id) => {
        const node = graph.nodesById.get(id);
        if (!node) return;
        if (node.is_local) {
          pruned.add(id);
          return;
        }
        const neigh = previewAdj.get(id) || new Set();
        let hasLocalNeighbor = false;
        for (const nid of neigh) {
          const n = graph.nodesById.get(nid);
          if (n && n.is_local) { hasLocalNeighbor = true; break; }
        }
        if (hasLocalNeighbor) pruned.add(id);
      });
      visibleNodeIds.clear();
      pruned.forEach((x) => visibleNodeIds.add(x));
    }

    nodeG.selectAll('g.node')
      .transition()
      .duration(120)
      .style('opacity', (d) => (visibleNodeIds.has(d.id) ? 1 : 0.12))
      .style('pointer-events', (d) => (visibleNodeIds.has(d.id) ? 'auto' : 'none'));

    updateFilterSummary();
  }

  function buildAdjacency(arg1, arg2) {
    let nodes = null;
    let links = null;
    if (Array.isArray(arg1) && Array.isArray(arg2)) { nodes = arg1; links = arg2; }
    else if (arg1 && typeof arg1 === 'object') {
      if (Array.isArray(arg1.nodes)) nodes = arg1.nodes;
      if (Array.isArray(arg1.links)) links = arg1.links;
      if (!links && Array.isArray(arg1.linksAll)) links = arg1.linksAll;
      if (!nodes && Array.isArray(links)) {
        const ids = new Set();
        links.forEach((l) => {
          const s = (typeof l.source === 'object') ? l.source.id : l.source;
          const t = (typeof l.target === 'object') ? l.target.id : l.target;
          if (s) ids.add(s);
          if (t) ids.add(t);
        });
        nodes = Array.from(ids).map((id) => ({ id }));
      }
    }
    nodes = Array.isArray(nodes) ? nodes : [];
    links = Array.isArray(links) ? links : [];
    const adj = new Map();
    nodes.forEach((n) => adj.set(n.id, new Set()));
    links.forEach((l) => {
      const s = (typeof l.source === 'object') ? l.source.id : l.source;
      const t = (typeof l.target === 'object') ? l.target.id : l.target;
      if (!s || !t) return;
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s).add(t);
      adj.get(t).add(s);
    });
    return adj;
  }

  function centerOnNode(d, zoom = 1.6) {
    const svgW = container.node().clientWidth;
    const svgH = container.node().clientHeight;
    const { x, y } = d;
    const transform = d3.zoomIdentity.translate(svgW / 2 - x * zoom, svgH / 2 - y * zoom).scale(zoom);
    svg.transition().duration(600).call(zoomBehavior.transform, transform);
  }

  function showInfo(centerNode, nNeigh) {
    if (!centerNode) {
      statusEl.text('Click a node to focus. Click background to reset.');
      return;
    }
    statusEl.text(`${centerNode.label || centerNode.id} — publications: ${formatNumber(centerNode.pubs || 0)} — collaborators: ${formatNumber(nNeigh)}`);
  }

  function dragstarted(event, d) {
    if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active && simulation) simulation.alphaTarget(0);
  }

  function updateFilterSummary() {
    if (!graph) return;
    const inst = instSelect.node().value;
    const coll = collabSelect.node().value;
    const from = defaultFromYear;
    const to = +yearToRange.node().value;
    const thr = +edgeSlider.node().value;
    const searchTerm = (searchBox.node().value || '').trim();

    const chips = [];
    const instLabel = inst === 'main' ? 'Institutional: Main authorship' : 'Institutional: Any authorship';
    const collLabel = coll === 'main' ? 'Collaborators: Main authorship' : 'Collaborators: Any authorship';
    chips.push(`<span class="network-filter-chip">${escapeHtml(instLabel)}</span>`);
    chips.push(`<span class="network-filter-chip">${escapeHtml(collLabel)}</span>`);
    chips.push(`<span class="network-filter-chip">Years: ${escapeHtml(from)}–${escapeHtml(to)}</span>`);
    chips.push(`<span class="network-filter-chip">Edge ≥ ${escapeHtml(thr)}</span>`);
    if (searchTerm) {
      chips.push(`<span class="network-filter-chip">Search: ${escapeHtml(searchTerm)}</span>`);
    }

    filterSummaryEl.html(`<span class="network-summary-label">Filters:</span> ${chips.join(' ')}`);

    const isDefault = inst === 'main'
      && coll === 'main'
      && to === (defaultToYear || to)
      && thr === edgeMinValue
      && !searchTerm;
    clearBtn.property('hidden', isDefault);
  }

  updateFilterSummary();

  return () => {
    if (simulation) simulation.stop();
  };
}
