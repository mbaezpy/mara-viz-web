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
  const zoomInBtn = root.select('#network-zoom-in');
  const zoomOutBtn = root.select('#network-zoom-out');
  const zoomFitBtn = root.select('#network-zoom-fit');
  const zoomControls = root.select('.network-zoom-controls');
  const filterForm = root.select('#network-filter-form');
  const formatNumber = d3.format(',');
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 4;
  const ZOOM_IN_FACTOR = 1.2;
  const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
  const DRAWER_TRANSITION_MS = 320;

  let defaultFromYear = null;
  let defaultToYear = null;
  let edgeMinValue = +edgeSlider.attr('min') || 0;
  let filterOpen = false;
  let zoomOffsetTimer = null;

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
    queueZoomOffsetUpdate();
  }

  const svg = container.append('svg')
    .attr('width', '100%')
    .attr('height', container.node().clientHeight || 720);

  let currentTransform = d3.zoomIdentity;
  const zoomBehavior = d3.zoom().scaleExtent([ZOOM_MIN, ZOOM_MAX]).on('zoom', (e) => {
    currentTransform = e.transform;
    g.attr('transform', e.transform);
  });
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
    updateZoomControlOffset();
  }

  function renderGraph() {
    linkG.selectAll('*').remove();
    nodeG.selectAll('*').remove();

    const nodes = graph.nodes;
    let linksCurrent = graph.linksAll.slice();

    const baselineMaxAny = graph._baselineNodeCumAnyMax || 1;
    const baseRScale = d3.scaleSqrt().domain([0, Math.max(1, baselineMaxAny)]).range([5, 28]);
    rScaleFn = (value) => baseRScale(value);

    const rawWeightValues = graph.linksAll
      .map((d) => +((d && d._weight_current) ?? d._weight ?? 0))
      .filter((v) => Number.isFinite(v) && v >= 0);
    const maxWeight = d3.max(rawWeightValues) || 1;
    const sortedWeights = rawWeightValues.slice().sort((a, b) => a - b);
    const q95 = d3.quantileSorted(sortedWeights, 0.95) ?? maxWeight;
    const q99 = d3.quantileSorted(sortedWeights, 0.99) ?? maxWeight;
    const MIN_LINK_WIDTH = 0.1;
    const MAX_LINK_WIDTH = 6;
    const MIN_OPACITY = 0.05;
    const MAX_OPACITY = 1;

    const widthScale = d3.scalePow().exponent(0.5).domain([0, maxWeight]).range([MIN_LINK_WIDTH, MAX_LINK_WIDTH]);
    const opacityScale = (weight) => {
      if (!Number.isFinite(weight) || weight <= 0) return MIN_OPACITY;
      const norm = Math.log(1 + weight) / Math.log(1 + maxWeight);
      return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * Math.pow(norm, 0.9)));
    };
    linkWidthFn = (weight) => {
      const baseWidth = widthScale(Math.max(0, weight || 0));
      if (weight >= q99) return Math.min(MAX_LINK_WIDTH, baseWidth * 1.25);
      if (weight >= q95) return Math.min(MAX_LINK_WIDTH, baseWidth * 1.08);
      return baseWidth;
    };
    linkOpacityFn = (weight) => {
      let op = opacityScale(Math.max(0, weight || 0));
      if (weight >= q99) op = Math.min(1, op * 1.2);
      else if (weight >= q95) op = Math.min(1, op * 1.08);
      return op;
    };

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
      .attr('stroke-width', (d) => linkWidthFn(d._weight))
      .style('opacity', (d) => linkOpacityFn(d._weight))
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
      logNodeDiagnostics(d);
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
    updateZoomControlOffset();



    function applyEdgeThreshold(thr, animate = true) {
      if (!graph) return;
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
      const nodeSelAll = nodeG.selectAll('g.node');
      const target = animate ? nodeSelAll.transition().duration(160) : nodeSelAll;
      target.style('opacity', (d) => (visibleNodeIds.has(d.id) ? 1 : 0.12));
      updateFilterSummary();
    }

    edgeSlider.on('input', () => {
      const thr = +edgeSlider.node().value;
      applyEdgeThreshold(thr, true);
    });

    instSelect.on('change', () => updateFilterSummary());
    collabSelect.on('change', () => updateFilterSummary());

    applyBtn.on('click', () => {
      applyFilters();
      setFilterOpen(false);
    });

    if (!zoomInBtn.empty()) {
      zoomInBtn.on('click', () => zoomByFactor(ZOOM_IN_FACTOR));
    }
    if (!zoomOutBtn.empty()) {
      zoomOutBtn.on('click', () => zoomByFactor(ZOOM_OUT_FACTOR));
    }
    if (!zoomFitBtn.empty()) {
      zoomFitBtn.on('click', () => fitGraphToView());
    }
    if (!zoomControls.empty()) {
      window.addEventListener('resize', () => queueZoomOffsetUpdate(16));
      const drawerNode = drawer.node();
      if (drawerNode) {
        drawerNode.addEventListener('transitionend', () => queueZoomOffsetUpdate(0));
      }
    }

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
        if (!(val > 0)) continue;
        const node = graph.nodesById.get(id);
        if (!node) continue;
        if (node.is_local) {
          visibleNodeIds.add(id);
        } else if (visibleNodeIdsFromLinks.has(id)) {
          visibleNodeIds.add(id);
        }
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
      graph._activeLinksCurrent = activeLinksForPhysics;
      graph._filters = {
        instFilter,
        collabFilter,
        edgeThreshold,
        fromYear: defaultFrom,
        toYear: defaultTo,
      };

      let linkSel = linkG.selectAll('line').data(activeLinksForPhysics, (d) => edgeKey(d));
      linkSel.exit().each(function () {
        this.__edgeHidden = true;
      }).transition().duration(250).style('opacity', 0).remove();
      const linkEnter = linkSel.enter().append('line')
        .attr('class', 'link')
        .attr('stroke', '#999')
        .property('__edgeEdgeData', (d) => d)
        .style('opacity', 0)
        .attr('stroke-width', (d) => (linkWidthFn ? linkWidthFn(d._weight_current || d._weight || 1) : 1));
      linkSel = linkEnter.merge(linkSel);
      linkSel.attr('stroke', '#999');
      linkSel.sort((a, b) => {
        const wa = a ? (a._weight_current ?? a._weight ?? 0) : 0;
        const wb = b ? (b._weight_current ?? b._weight ?? 0) : 0;
        return wa - wb;
      });

      linkSel.transition().duration(350)
        .attr('stroke-width', (d) => linkWidthFn ? linkWidthFn(d._weight_current || d._weight || 0) : 1)
        .style('opacity', (d) => linkOpacityFn ? linkOpacityFn(d._weight_current || d._weight || 0) : 1)
        .style('display', (d) => ((d._weight_current ?? d._weight) >= edgeThreshold ? null : 'none'));
      linkSel.each(function (d) {
        this.__edgeEdgeData = d;
        this.__edgeHidden = ((d._weight_current ?? d._weight) < edgeThreshold);
      });

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
        logNodeDiagnostics(d);
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

    function resetFilters() {
      if (!graph) return;
      const prevInst = instSelect.property('value');
      const prevCollab = collabSelect.property('value');
      instSelect.property('value', 'main');
      collabSelect.property('value', 'main');
      const to = defaultToYear || graph._computed_max_year || new Date().getFullYear();
      yearToRange.property('value', to);
      yearToValue.text(to);
      edgeSlider.property('value', edgeMinValue);
      searchBox.property('value', '');
      applyFilters();
      applyEdgeThreshold(edgeMinValue, false);
      queueZoomOffsetUpdate();
    }
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
    if (instFilter === 'main' && collabFilter === 'main') return 'both_main';
    return null;
  }

  function weightFromCounts(edge, fromY, toY) {
    if (Array.isArray(edge.pub_years) && Array.isArray(edge.counts_by_year_cum) && edge.pub_years.length === edge.counts_by_year_cum.length) {
      return cumRangeFromCumArrays(edge.pub_years, edge.counts_by_year_cum, fromY, toY);
    }
    if (edge.counts_by_year && typeof edge.counts_by_year === 'object') {
      return sumCountsInWindowMap(edge.counts_by_year, fromY, toY);
    }
    return +(edge._weight || 0);
  }

  function weightFromRole(edge, roleKey, fromY, toY) {
    if (!roleKey) return 0;
    const years = Array.isArray(edge.pub_years) ? edge.pub_years : [];
    const cumArr = edge.role_pair_counts_by_year_cum && edge.role_pair_counts_by_year_cum[roleKey];
    if (Array.isArray(cumArr) && years.length === cumArr.length) {
      return cumRangeFromCumArrays(years, cumArr, fromY, toY);
    }
    const arr = edge.role_pair_counts_by_year_arrays && edge.role_pair_counts_by_year_arrays[roleKey];
    if (Array.isArray(arr) && years.length === arr.length) {
      const cum = prefixSum(arr);
      edge.role_pair_counts_by_year_cum = edge.role_pair_counts_by_year_cum || {};
      edge.role_pair_counts_by_year_cum[roleKey] = cum;
      return cumRangeFromCumArrays(years, cum, fromY, toY);
    }
    const map = edge.role_pair_counts_by_year && edge.role_pair_counts_by_year[roleKey];
    if (map && typeof map === 'object') {
      return sumCountsInWindowMap(map, fromY, toY);
    }
    if (edge.role_pair_totals && typeof edge.role_pair_totals[roleKey] === 'number') {
      return edge.role_pair_totals[roleKey];
    }
    return 0;
  }

  function computeWeightForLinkCombined(edge, instFilter, collabFilter, fromY, toY) {
    const baseKey = computeCombinedRoleKey(instFilter, collabFilter);
    if (baseKey === 'counts_by_year') {
      return weightFromCounts(edge, fromY, toY);
    }
    if (baseKey === 'both_main') {
      return weightFromRole(edge, 'both_main', fromY, toY);
    }

    const sourceId = (typeof edge.source === 'object') ? edge.source.id : edge.source;
    const targetId = (typeof edge.target === 'object') ? edge.target.id : edge.target;
    const sourceNode = graph.nodesById.get(sourceId);
    const targetNode = graph.nodesById.get(targetId);
    const sourceIsLocal = !!(sourceNode && sourceNode.is_local);
    const targetIsLocal = !!(targetNode && targetNode.is_local);

    if (instFilter === 'main' && collabFilter === 'any') {
      if (sourceIsLocal && targetIsLocal) return weightFromRole(edge, 'either_main', fromY, toY);
      if (sourceIsLocal) return weightFromRole(edge, 'source_main', fromY, toY);
      if (targetIsLocal) return weightFromRole(edge, 'target_main', fromY, toY);
      return 0;
    }

    if (instFilter === 'any' && collabFilter === 'main') {
      if (sourceIsLocal && targetIsLocal) return weightFromRole(edge, 'either_main', fromY, toY);
      if (!sourceIsLocal && targetIsLocal) return weightFromRole(edge, 'source_main', fromY, toY);
      if (sourceIsLocal && !targetIsLocal) return weightFromRole(edge, 'target_main', fromY, toY);
      return weightFromRole(edge, 'either_main', fromY, toY);
    }

    return weightFromCounts(edge, fromY, toY);
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

  function edgeInvolves(edge, nodeId) {
    if (!edge) return false;
    const sid = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
    return sid === nodeId || tid === nodeId;
  }

  function gatherEdgesForNode(nodeId, edges) {
    if (!nodeId || !Array.isArray(edges)) return [];
    return edges.filter((edge) => edgeInvolves(edge, nodeId));
  }

  function shouldLogEdgeDiagnostics(node) {
    if (!graph || !node) return false;
    const allEdges = gatherEdgesForNode(node.id, graph.linksAll);
    if (!allEdges.length) return false;
    const visibleEdges = gatherEdgesForNode(node.id, graph._activeLinksCurrent || []);
    return visibleEdges.length === 0;
  }

  function describeEdgeForNode(edge, nodeId, filters) {
    const sid = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
    const neighborId = sid === nodeId ? tid : sid;
    const neighbor = graph.nodesById.get(neighborId);
    const weightCurrent = edge._weight_current ?? edge._weight ?? 0;
    const threshold = filters.edgeThreshold ?? (+edgeSlider.node().value || 0);
    return {
      neighborId,
      neighborLabel: neighbor ? (neighbor.label || neighbor.id) : undefined,
      neighborIsLocal: neighbor ? !!neighbor.is_local : undefined,
      weightCurrent,
      weightFull: edge.weight_full,
      weightFractional: edge.weight_fractional,
      passesThreshold: weightCurrent >= threshold,
      hasPositiveWeight: weightCurrent > 0,
      roleTotals: edge.role_pair_totals,
      roleCountsByYear: edge.role_pair_counts_by_year,
      linkObject: edge,
      visual: getEdgeVisualInfo(edge),
    };
  }

  function logNodeDiagnostics(node) {
    if (!graph || !node) return;
    const filters = graph._filters || {};
    const allEdges = gatherEdgesForNode(node.id, graph.linksAll);
    const visibleEdges = gatherEdgesForNode(node.id, graph._activeLinksCurrent || []);
    console.groupCollapsed(
      `[network-debug] Node ${node.label || node.id} — ${allEdges.length} total edges / ${visibleEdges.length} visible`,
    );
    console.log('Node info', {
      id: node.id,
      label: node.label,
      isLocal: node.is_local,
      filters,
    });
    console.log('All adjacent edges', allEdges.map((edge) => describeEdgeForNode(edge, node.id, filters)));
    console.log('Visible edges (after filters)', visibleEdges.map((edge) => describeEdgeForNode(edge, node.id, filters)));
    console.groupEnd();
  }

  function edgeKey(edge) {
    if (!edge) return '';
    if (edge.id) return edge.id;
    const sid = typeof edge.source === 'object' ? edge.source.id : edge.source;
    const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
    return `${sid}|${tid}`;
  }

  function getEdgeVisualInfo(edge) {
    const targetKey = edgeKey(edge);
    let info = {
      present: false,
      stroke: null,
      strokeWidth: null,
      opacity: null,
      display: null,
      hiddenByThreshold: null,
    };
    linkG.selectAll('line').each(function (d) {
      if (edgeKey(d) !== targetKey || info.present) return;
      const el = d3.select(this);
      info = {
        present: true,
        stroke: el.attr('stroke'),
        strokeWidth: parseFloat(el.attr('stroke-width')),
        opacity: parseFloat(el.style('opacity')),
        display: el.style('display') || null,
        hiddenByThreshold: !!this.__edgeHidden,
      };
    });
    return info;
  }

  function updateZoomControlOffset() {
    if (zoomControls.empty()) return;
    const shellEl = shell.node();
    const height = shellEl ? shellEl.offsetHeight : 0;
    zoomControls.style('bottom', `${height + 16}px`);
  }

  function queueZoomOffsetUpdate(delay = DRAWER_TRANSITION_MS) {
    if (zoomControls.empty()) return;
    updateZoomControlOffset();
    if (zoomOffsetTimer) {
      clearTimeout(zoomOffsetTimer);
    }
    zoomOffsetTimer = window.setTimeout(() => {
      zoomOffsetTimer = null;
      updateZoomControlOffset();
    }, delay);
  }

  function zoomByFactor(factor) {
    if (!graph) return;
    const svgNode = svg.node();
    if (!svgNode) return;
    const rect = svgNode.getBoundingClientRect();
    const point = [rect.width / 2, rect.height / 2];
    svg.transition().duration(250).call(zoomBehavior.scaleBy, factor, point);
  }

  function fitGraphToView() {
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasPosition = false;
    graph.nodes.forEach((node) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      hasPosition = true;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    });
    if (!hasPosition) return;
    const padding = 80;
    const width = Math.max(10, maxX - minX);
    const height = Math.max(10, maxY - minY);
    const svgNode = svg.node();
    const rect = svgNode
      ? svgNode.getBoundingClientRect()
      : { width: container.node().clientWidth || 1, height: container.node().clientHeight || 1 };
    const scaleFit = 0.9 * Math.min(rect.width / (width + padding), rect.height / (height + padding));
    const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scaleFit || 1));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const transform = d3.zoomIdentity
      .translate(rect.width / 2 - centerX * scale, rect.height / 2 - centerY * scale)
      .scale(scale);
    svg.transition().duration(600).call(zoomBehavior.transform, transform);
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
      if (w < edgeThreshold) {
        el.style('display', 'none');
        this.__edgeHidden = true;
      } else {
        el.style('display', null);
        if (linkWidthFn) el.transition().duration(170).attr('stroke-width', linkWidthFn(w));
      if (linkOpacityFn) el.transition().duration(170).style('opacity', linkOpacityFn(d._weight_current ?? d._weight ?? 0));
        this.__edgeHidden = false;
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
