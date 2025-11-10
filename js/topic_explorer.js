// js/topic_explorer.js
// Uses global d3 (UMD). Ensure <script src="https://d3js.org/d3.v7.min.js"></script>
// is loaded before your module loader.
import {
  buildTopicColorMapFromTopicIds,
  colorForTopicId as resolveTopicColor,
} from "./topic_colors.js";

let root = null;
let focus = null;
let view = null;
let lookupCache = null;
let lookupPromise = null;
let selectedEl = null;
let abortController = null;
let navigateFn = null;
let pendingTopicId = null;
let applyRouteTopic = null;
let setSelectedNode = () => {};
let zoomToNodeRef = () => {};
let topicColorMap = Object.freeze({});
const TOPIC_COLOR_FALLBACK = "#94a3b8";

function collectTopLevelTopicIds(data) {
  if (!data || !Array.isArray(data.children)) return [];
  return data.children
    .map(child => child && (child.topic_id || child.name || null))
    .filter(Boolean);
}

export async function init({ mount, route = {}, navigate } = {}) {
  if (!mount) throw new Error('topic_explorer.init requires { mount } DOM element');

  // scoped selections (operate only inside this mount)
  const $mount = d3.select(mount);
  const svg = $mount.select('#viz');
  const tooltip = $mount.select('#tooltip');
  const panel = $mount.select('#panel-content') || $mount.select('#panel');
  const crumbs = $mount.select('#breadcrumbs');

  // ensure a clean svg container
  svg.selectAll('*').remove();

  // groups we will append (so cleanup can remove them)
  const gNodes = svg.append('g');
  const gLabels = svg.append('g').attr('class','labels');

  const width = 932, height = 932;
  const depthColors = ['#d0ece7','#80cbc4','#4db6ac','#ffffff'];

  const pack = data => d3.pack().size([width, height]).padding(3)(
    d3.hierarchy(data).sum(d => d.size || 0).sort((a,b) => b.value - a.value)
  );

  // reset state
  root = null;
  focus = null;
  view = null;
  lookupCache = null;
  lookupPromise = null;
  selectedEl = null;
  applyRouteTopic = null;
  setSelectedNode = () => {};
  abortController = new AbortController();
  navigateFn = typeof navigate === 'function' ? navigate : null;
  pendingTopicId = typeof route.topic === 'string' && route.topic ? route.topic : null;

  // Load lookup data (with abort support)
function loadLookupOnce(){
    if(lookupPromise) return lookupPromise;
    const signal = abortController.signal;
    lookupPromise = fetch('data/topics_lookup.json', { signal })
      .then(resp => {
        if(!resp.ok) throw new Error(`Failed to load topics_lookup.json: ${resp.status}`);
        return resp.json();
      })
      .then(payload => {
        lookupCache = {
          papers: payload.papers || {},
          authors: payload.authors || {},
          journals: payload.journals || {}
        };
        return lookupCache;
      })
      .catch(err => {
        if (err.name === 'AbortError') return { papers:{}, authors:{}, journals:{} };
        console.warn(err);
        lookupCache = { papers:{}, authors:{}, journals:{} };
        return lookupCache;
      });
    return lookupPromise;
  }

  function escapeHTML(s){
    return (s==null?'' : String(s)).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function topicColor(id) {
    return resolveTopicColor(id, topicColorMap) || TOPIC_COLOR_FALLBACK;
  }

  function setCrumbs(node){
    const path = node.ancestors().reverse();
    const html = path.map((n,i)=>{
      if(i === path.length-1){
        return `<span class="crumb"><strong>${escapeHTML(n.data.name || 'Root')}</strong></span>`;
      }
      return `<span class="crumb"><a href="#" data-crumb-index="${i}">${escapeHTML(n.data.name || 'Root')}</a><span>›</span></span>`;
    }).join('');
    crumbs.html(html);
    crumbs.selectAll('a').on('click', (event) => {
      const idx = +event.currentTarget.getAttribute('data-crumb-index');
      const target = path[idx];
      zoomToNodeRef(target);
      if (target === root) {
        setSelectedNode(null);
      } else {
        setSelectedNode(target);
      }
      showDetails(target);
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function formatAuthorList(authorRefs, authorsLookup, limit = 4){
    if(!Array.isArray(authorRefs)) return '';
    const names = [];
    for(const ref of authorRefs){
      const authorId = typeof ref === 'string' ? ref : ref && ref.id;
      if(!authorId) continue;
      const author = authorsLookup[authorId];
      const name = author && author.display_name;
      if(name) names.push(name);
      if(names.length >= limit) break;
    }
    return names.join(', ');
  }

  function buildAuthorEntries(topAuthors, lookup){
    const authorsLookup = lookup.authors || {};
    return (topAuthors || []).map(author => {
      const details = authorsLookup[author.id] || {};
      return {
        id: author.id,
        name: author.display_name || details.display_name || 'Unknown author',
        paper_count: author.paper_count ?? details.paper_count ?? 0,
        orcid: author.orcid || details.orcid || null,
        currently_local: details.currently_local ?? false,
        current_affiliation: (() => {
          const aff = details.current_affiliation;
          if (!aff) return null;
          if (typeof aff === 'string') return aff;
          return aff.display_name || aff.id || null;
        })()
      };
    });
  }

  function buildJournalEntries(topJournals, lookup){
    const journalsLookup = lookup.journals || {};
    return (topJournals || []).map(journal => {
      const details = journalsLookup[journal.id] || {};
      return {
        id: journal.id,
        name: journal.display_name || details.display_name || 'Unknown journal',
        paper_count: journal.paper_count ?? details.paper_count ?? 0,
        issn_l: details.issn_l || null
      };
    });
  }

  function buildPaperEntries(topPapers, lookup){
    const papersLookup = lookup.papers || {};
    const authorsLookup = lookup.authors || {};
    const journalsLookup = lookup.journals || {};

    return (topPapers || []).map(paper => {
      const details = papersLookup[paper.id] || {};
      const doi = paper.doi || details.doi || null;
      const authorRefs = Array.isArray(details.author_ids) ? details.author_ids : [];
      const journalId = details.journal_id;
      const journal = journalId ? journalsLookup[journalId] : null;
      return {
        id: paper.id,
        title: paper.title || details.title || 'Untitled',
        year: paper.publication_year || details.publication_year || '',
        cited_by_count: paper.cited_by_count ?? details.cited_by_count ?? null,
        doi,
        href: doi ? `https://doi.org/${doi}` : null,
        authors: formatAuthorList(authorRefs, authorsLookup),
        journal: journal ? journal.display_name : null
      };
    });
  }

  function showDetails(node, options = {}){
    const data = node.data || {};
    const docCount = data.doc_count ?? data.size ?? 0;
    const docDirect = data.doc_count_direct ?? docCount;
    const keywords = Array.isArray(data.top_keywords) ? data.top_keywords : [];

    const isRoot = !node.parent;

    if (isRoot) {
      panel.html(`
        <h2>${escapeHTML(data.name || 'Research Topics')}</h2>
        <p class="meta">Our institution is carrying out research in the following topics:</p>
        <ul class="list compact" id="root-topic-list"></ul>
        <p class="meta">Click on the topic visualization to learn more about each topic.</p>
      `);
      panel.select('#root-topic-list')
        .selectAll('li')
        .data((data.children || []).map(child => ({
          id: child.topic_id || child.name || "",
          name: child.name,
          count: child.doc_count ?? child.size ?? 0,
        })))
        .join('li')
        .html(topic => {
          const badge = topic.count ? `<span class="badge">${topic.count}</span>` : '';
          const color = escapeHTML(topicColor(topic.id));
          return `<div class="line1">
            <a href="#/topic_explorer?topic=${encodeURIComponent(topic.id)}"><span class="topic-color-dot" style="--topic-color:${color}" aria-hidden="true"></span>
            ${escapeHTML(topic.name)}</a>${badge}
          </div>`;
        });
      if (!options.suppressRoute) {
        updateRoute(null);
      }
      return;
    }

    panel.html(`
      <h2>${escapeHTML(data.name || 'Untitled')}</h2>
      <div class="meta">${node.children ? 'Cluster' : 'Topic'}${docCount ? ` • ${docCount} documents` : ''}${docDirect !== docCount ? ` • ${docDirect} direct` : ''}</div>
      ${data.description ? `<section><h3>Description</h3><div class="desc">${escapeHTML(data.description)}</div></section>`: ''}
      ${keywords.length ? `
        <section id="keywords-section">
          <h3>Top Keywords</h3>
          <div class="chips">
            ${keywords.map(k => `<span class="chip">${escapeHTML(k.display_name || k.id || k)}</span>`).join('')}
          </div>
        </section>
      ` : ''}
      <section id="authors-section"><h3>Top Authors</h3><div class="skeleton" style="height:48px"></div></section>
      <section id="journals-section"><h3>Top Journals</h3><div class="skeleton" style="height:56px"></div></section>
      <section id="pubs-section"><h3>Top Publications</h3><div class="skeleton" style="height:96px"></div></section>
    `);

    loadLookupOnce().then(lookup => {
      const authorsData = buildAuthorEntries(data.top_authors, lookup).filter(author => author.currently_local);
      const journalsData = buildJournalEntries(data.top_journals, lookup);
      const papersData = buildPaperEntries(data.top_papers, lookup);

      const aWrap = panel.select('#authors-section');
      if(authorsData.length){
        aWrap.html('<h3>Top Authors</h3>');
        const list = aWrap.append('ul').attr('class','list compact');
        list.selectAll('li')
          .data(authorsData.slice(0,12))
          .join('li')
          .html(author => {
            const suffix = author.paper_count ? `<span class="badge">${author.paper_count}</span>` : '';
            const affiliation = author.current_affiliation ? `<small>${escapeHTML(author.current_affiliation)}</small>` : '';
            const orcid = author.orcid ? `<small>ORCID: <a href="${author.orcid}" target="_blank" rel="noopener">${escapeHTML(author.orcid.replace('https://orcid.org/', ''))}</a></small>` : '';
            return [
              `<div class="line1">${escapeHTML(author.name)}${suffix}</div>`,
              affiliation,
              orcid
            ].filter(Boolean).join('');
          });
      } else {
        aWrap.html('<h3>Top Authors</h3><p class="meta">No authors available for this topic.</p>');
      }

      const jWrap = panel.select('#journals-section');
      if(journalsData.length){
        jWrap.html('<h3>Top Journals</h3>');
        const ulJ = jWrap.append('ul').attr('class','list compact');
        ulJ.selectAll('li')
          .data(journalsData.slice(0,10))
          .join('li')
          .html(journal => {
            const badge = journal.paper_count ? `<span class="badge">${journal.paper_count}</span>` : '';
            const issn = journal.issn_l ? `<small>ISSN-L ${escapeHTML(journal.issn_l)}</small>` : '';
            return `<div class="line1">${escapeHTML(journal.name)}${badge}</div>${issn}`;
          });
      } else {
        jWrap.html('<h3>Top Journals</h3><p class="meta">No journals available for this topic.</p>');
      }

      const pWrap = panel.select('#pubs-section');
      if(papersData.length){
        pWrap.html('<h3>Top Publications</h3>');
        const ul = pWrap.append('ul').attr('class','list');
        ul.selectAll('li')
          .data(papersData.slice(0,20))
          .join('li')
          .html(paper => {
            const title = escapeHTML(paper.title);
            const metaParts = [];
            if(paper.authors) metaParts.push(escapeHTML(paper.authors));
            if(paper.journal) metaParts.push(escapeHTML(paper.journal));
            if(paper.year) metaParts.push(escapeHTML(String(paper.year)));
            const cites = Number.isFinite(paper.cited_by_count) ? `Citations: ${paper.cited_by_count}` : '';
            if(cites) metaParts.push(escapeHTML(cites));
            const meta = metaParts.join(' · ');
            if(paper.href){
              return `<a href="${paper.href}" target="_blank" rel="noopener">${title}</a><br/><small>${meta}</small>`;
            }
            return `${title}<br/><small>${meta}</small>`;
          });
      } else {
        pWrap.html('<h3>Top Publications</h3><p class="meta">No publications available for this topic.</p>');
      }
    }).catch(err=>{
      if (err.name === 'AbortError') return;
      console.warn('loadLookupOnce error', err);
    });

    if (!options.suppressRoute) {
      const topicId = node === root ? null : (data.topic_id || null);
      updateRoute(topicId);
    }
  }

  function wrapLabel(textSel, label, maxWidth, maxLines = 3, lineHeightEm = 1.1) {
    const words = String(label || '—').split(/\s+/).filter(Boolean);

    // --- Pass 1: build lines using a hidden measuring tspan
    const meas = textSel.text(null).append('tspan')
      .attr('x', 0)
      .attr('visibility', 'hidden')
      .text('');

    const lines = [];
    let cur = [];

    for (const w of words) {
      cur.push(w);
      meas.text(cur.join(' '));
      if (meas.node().getComputedTextLength() > maxWidth) {
        // move last word to new line
        cur.pop();
        if (cur.length) lines.push(cur.join(' '));
        cur = [w];

        if (lines.length === maxLines - 1) {
          // last line – ellipsize
          let last = cur.join(' ') + '…';
          meas.text(last);
          while (last.length > 1 && meas.node().getComputedTextLength() > maxWidth) {
            last = last.slice(0, -2) + '…';
            meas.text(last);
          }
          lines.push(last);
          cur = [];
          break;
        }
      }
    }
    if (cur.length && lines.length < maxLines) lines.push(cur.join(' '));

    meas.remove(); // cleanup

    // --- Pass 2: render tspans with proper vertical centering
    textSel.text(null);
    const n = lines.length;
    const firstDy = n > 1 ? -((n - 1) / 2) * lineHeightEm : 0;

    lines.forEach((line, i) => {
      const t = textSel.append('tspan').attr('x', 0).text(line);
      if (i === 0) t.attr('dy', `${firstDy}em`);
      else t.attr('dy', `${lineHeightEm}em`);
    });
  }

  function draw(data){
    root = pack(data);
    focus = root;

    // remove previous nodes/labels if any
    gNodes.selectAll('*').interrupt().remove();
    gLabels.selectAll('*').remove();

    setSelectedNode = function(node){
      if (selectedEl) d3.select(selectedEl).classed('is-selected', false);
      if (!node) {
        selectedEl = null;
        return;
      }
      selectedEl = svg.selectAll('circle').filter(d => d === node).node();
      if (selectedEl) d3.select(selectedEl).classed('is-selected', true);
    };

    const nodes = gNodes.selectAll('circle').data(root.descendants()).join('circle')
      .attr('fill', d => {
        const c = d.data.topic_id ? topicColor(d.data.topic_id) : '#e2e8f0';
        const col = d3.color(c);
        col.opacity = 0.15;              // was 0.25 → softer
        return col + '';                 // to string
      })
      .on('mouseover', function (event, d) {
        const c = d.data.topic_id ? topicColor(d.data.topic_id) : '#1d4ed8';
        this.style.setProperty('--topic-accent', c);
        d3.select(this).classed('is-hover', true);
        tooltip.style('border-color', c);

        // SHOW tooltip (restored)
        const name = d.data.name || '';
        const count = d.data.size ? ` • ${d.data.size}` : '';
        tooltip
          .style('opacity', 1)
          .html(`<strong>${escapeHTML(name)}</strong>${count}`);
      })
      .on('mousemove', function (event) {
        // MOVE tooltip (restored)
        const { pageX: x, pageY: y } = event;
        tooltip.style('left', `${x + 16}px`).style('top', `${y + 12}px`);
      })
      .on('mouseout', function () {
        d3.select(this).classed('is-hover', false);
        tooltip.style('border-color', 'var(--tooltip-border)');

        // HIDE tooltip (restored)
        tooltip.style('opacity', 0);
      })
    // .attr('class', d => d.children ? 'node node--internal' : 'node node--leaf')
      // .attr('fill', d => {
      //   if (!d.children) return '#ffffff';
      //   return depthColors[d.depth] || depthColors[depthColors.length - 2];
      // })
      // .on('mouseover', function(event, d){
      //   d3.select(this).classed('is-hover', true);
      //   const name = d.data.name || '';
      //   const shortName = name.length > 40 ? name.slice(0, 40) + '…' : name;
      //   tooltip.style('opacity', 1).html(`<strong>${escapeHTML(shortName)}</strong>${d.data.size?` • ${d.data.size}`:''}`);
      // })
      // .on('mousemove', function(event){
      //   const { pageX: x, pageY: y } = event;
      //   const offsetX = 16;
      //   const offsetY = 12;
      //   tooltip.style('left', `${x + offsetX}px`).style('top', `${y + offsetY}px`);
      // })
      // .on('mouseout', function(){
      //   d3.select(this).classed('is-hover', false);
      //   tooltip.style('opacity', 0);
      // })
      .on('click', (event, d)=>{
        setSelectedNode(d);

        if (d.children) {
          if (focus !== d) { zoomToNodeRef(d); }
          showDetails(d);
        } else {
          const parent = d.parent || root;
          if (focus !== parent) { zoomToNodeRef(parent); }
          showDetails(d);
        }
        event.stopPropagation();
      });

    // const labels = gLabels.selectAll('text').data(root.descendants()).join('text')
    //   .style('fill-opacity', d => d.parent === root ? 1 : 0)
    //   .style('display', d => d.parent === root ? 'inline' : 'none')
    //   .text(d => d.data.name || '—');
    const labels = gLabels.selectAll('text')
      .data(root.descendants())
      .join('text')
      .attr('class', 'label')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .style('pointer-events', 'none')
      .style('fill-opacity', d => d.parent === root ? 1 : 0)
      .style('display', d => d.parent === root ? 'inline' : 'none')
      .each(function(d){
        const sel = d3.select(this);
        const name = d.data.name || '—';
        //const fontPx = Math.max(10, Math.min(22, d.r / 3));
        //sel.style('font-size', `${fontPx}px`);
        // Allow ~80–90% of the circle diameter for text width
        wrapLabel(sel, name, d.r * 1.8 /* width inside bubble */, 3);
      });

    function rewrapVisibleLabels(k, parentNode) {
      labels.each(function(n){
        if (n.parent !== parentNode) return; // only the labels that should be visible
        const sel = d3.select(this);
        const name = n.data.name || '—';
        //const fontPx = Math.max(10, Math.min(22, (n.r * k) / 3));
        //sel.style('font-size', `${fontPx}px`);
        wrapLabel(sel, name, n.r * k * 1.8, 3, 1.1);
      });
    }



    function zoomTo(v){
      const k = width / v[2];
      view = v;
      labels.attr('transform', d => `translate(${(d.x - v[0]) * k}, ${(d.y - v[1]) * k})`)
           // .attr('font-size', d => Math.max(10, Math.min(22, (d.r * k) / 3)));
      nodes.attr('transform', d => `translate(${(d.x - v[0]) * k}, ${(d.y - v[1]) * k})`)
           .attr('r', d => d.r * k);
    }

    function zoom(d){
      const transition = svg.transition().duration(750).tween('zoom', () => {
        const i = d3.interpolateZoom(view, [d.x, d.y, d.r * 2]);
        return t => zoomTo(i(t));
      });

      // labels
      //   .filter(function(n){ return n.parent === d || this.style.display === 'inline'; })
      //   .transition(transition)
      //   .style('fill-opacity', n => n.parent === d ? 1 : 0)
      //   .on('start', function(n){ if(n.parent === d) this.style.display = 'inline'; })
      //   .on('end', function(n){ if(n.parent !== d) this.style.display = 'none'; });

      labels
        .filter(function(n){ return n.parent === d || this.style.display === 'inline'; })
        .transition(transition)
        .style('fill-opacity', n => n.parent === d ? 1 : 0)
        .on('start', function(n){ if (n.parent === d) this.style.display = 'inline'; })
        .on('end', (n, i, nodesSel) => {
          const el = nodesSel[i];
          if (n.parent !== d) { el.style.display = 'none'; return; }
          // Rewrap once at final scale k
          const k = width / view[2];
          rewrapVisibleLabels(k, d);                   
        });      
    }

    zoomTo([root.x, root.y, root.r * 2]);
    rewrapVisibleLabels(width / (root.r * 2), root);   

    // attach a background click listener directly to this svg selection
    svg.on('click.topicExplorer', (event)=>{
      if(focus !== root){ zoomToNodeRef(root); showDetails(root); }
      setSelectedNode(null);
    });

    zoomToNodeRef = function(d){
      focus = d;
      setCrumbs(d);
      zoom(d);
    };

    // Initialize panel + crumbs
    setCrumbs(root);
    showDetails(root, { suppressRoute: true });

    applyRouteTopic = (topicId, options = {}) => {
      pendingTopicId = topicId || null;
      if (!root) return;
      if (!topicId) {
        zoomToNodeRef(root);
        setSelectedNode(null);
        showDetails(root, { suppressRoute: options.suppressRouteUpdate });
        return;
      }
      const target = root.descendants().find(n => (n.data || {}).topic_id === topicId);
      if (!target) return;
      if (target.children) {
        if (focus !== target) zoomToNodeRef(target);
        setSelectedNode(target);
        showDetails(target, { suppressRoute: options.suppressRouteUpdate });
      } else {
        const parent = target.parent || root;
        if (focus !== parent) zoomToNodeRef(parent);
        setSelectedNode(target);
        showDetails(target, { suppressRoute: options.suppressRouteUpdate });
      }
    };

    if (pendingTopicId) {
      applyRouteTopic(pendingTopicId, { suppressRouteUpdate: true });
    }
  }

  // start: fetch and draw (keep abort-aware)
  try {
    const resp = await fetch('data/topics_hierarchy.json', { signal: abortController.signal });
    if (!resp.ok) throw new Error(`Failed to load hierarchy: ${resp.status}`);
    const data = await resp.json();
    const topIds = collectTopLevelTopicIds(data);
    topicColorMap = buildTopicColorMapFromTopicIds(topIds);
    draw(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      // aborted during cleanup — ignore
    } else {
      panel.html('<p class="meta">Failed to load topics_hierarchy.json</p>');
      console.error(err);
    }
  }

  // cleanup function to be returned and callable later
  function cleanup(){
    // cancel fetches
    try { abortController.abort(); } catch(e){}

    // remove svg content & interrupt transitions
    svg.selectAll('*').interrupt().remove();

    // clear panel and breadcrumbs
    panel.html('');
    crumbs.html('');

    // clear caches
    lookupPromise = null;
    lookupCache = null;
    applyRouteTopic = null;
    topicColorMap = Object.freeze({});

    // remove svg-level listener namespace
    try { svg.on('.topicExplorer', null); } catch(e){}

    selectedEl = null;
    root = null;
    focus = null;
    view = null;
    setSelectedNode = () => {};
    zoomToNodeRef = () => {};
    navigateFn = null;
    pendingTopicId = null;
    abortController = null;
  }

  // also support named export destroy()
  return cleanup;
}

function updateRoute(topicId){
  if (typeof navigateFn !== 'function') return;
  navigateFn({ topic: topicId || null });
}

export function onRouteChange({ params = {}, navigate } = {}) {
  if (typeof navigate === 'function') {
    navigateFn = navigate;
  }
  pendingTopicId = typeof params.topic === 'string' && params.topic ? params.topic : null;
  if (typeof applyRouteTopic === 'function') {
    applyRouteTopic(pendingTopicId, { suppressRouteUpdate: true });
  }
}

export async function destroy() {
  // This function is present as an alternate lifecycle hook if needed.
  // Consumers can call it (but main loader will call the cleanup returned by init()).
  // noop here because init returns cleanup — actual cleanup happens via that function.
  return;
}
