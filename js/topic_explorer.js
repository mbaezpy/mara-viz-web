// js/topic_explorer.js
// Uses global d3 (UMD). Ensure <script src="https://d3js.org/d3.v7.min.js"></script>
// is loaded before your module loader.
export async function init({ mount } = {}) {
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

  let root, focus, view;
  let authorsCache = null, topicSummary = null, cachePromise = null;
  let selectedEl = null;
  let abortController = new AbortController();

  // Load side data (with abort support)
  function loadSideDataOnce(){
    if(cachePromise) return cachePromise;
    const signal = abortController.signal;
    cachePromise = Promise.all([
      fetch('/data/topic_authors.json', { signal }).then(r => r.ok ? r.json() : {} ).catch(()=>({})),
      fetch('/data/topic_summary.json', { signal }).then(r => r.ok ? r.json() : {} ).catch(()=>({}))
    ]).then(([authors, summary]) => { authorsCache = authors; topicSummary = summary; return {authors, summary}; });
    return cachePromise;
  }

  function normalizeKey(nodeData){
    return (nodeData.topic_id || nodeData.id || nodeData.key || nodeData.name || '').toString();
  }

  function escapeHTML(s){
    return (s==null?'' : String(s)).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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
      zoomToNode(target);
      showDetails(target);
      if (selectedEl) { d3.select(selectedEl).classed('is-selected', false); selectedEl = null; }
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function showDetails(node){
    const data = node.data || {};
    const key = normalizeKey(data);

    panel.html(`
      <h2>${escapeHTML(data.name || 'Untitled')}</h2>
      <div class="meta">${node.children ? 'Cluster' : 'Topic'} • ${data.size ? `${data.size} documents` : ''}</div>
      ${data.description ? `<section><h3>Description</h3><div class="desc">${escapeHTML(data.description)}</div></section>`: ''}
      <section id="authors-section"><h3>Top Authors</h3><div class="skeleton" style="height:48px"></div></section>
      <section id="journals-section"><h3>Top Journals</h3><div class="skeleton" style="height:56px"></div></section>
      <section id="pubs-section"><h3>Relevant Publications</h3><div class="skeleton" style="height:96px"></div></section>
    `);

    loadSideDataOnce().then(()=>{
      // Authors
      const authors = (authorsCache && (authorsCache[key] || authorsCache[data.name])) || [];
      const aWrap = panel.select('#authors-section');
      if(authors.length){
        aWrap.html('<h3>Top Authors</h3>');
        const chips = aWrap.append('div').attr('class','chips');
        chips.selectAll('span').data(authors.slice(0,12)).join('span').attr('class','chip').text(d => d.name ? `${d.name}${d.count?` (${d.count})`:''}` : d);
      } else {
        aWrap.html('<h3>Top Authors</h3><p class="meta">No authors available for this topic.</p>');
      }

      // Journals + Publications from topic_summary
      const summary = (topicSummary && (topicSummary[key] || topicSummary[data.name])) || {};
      const journals = Array.isArray(summary.top_journals) ? summary.top_journals : [];
      const pubs = Array.isArray(summary.publications) ? summary.publications : [];

      const jWrap = panel.select('#journals-section');
      if(journals.length){
        jWrap.html('<h3>Top Journals</h3>');
        const ulJ = jWrap.append('ul').attr('class','list compact');
        ulJ.selectAll('li').data(journals).join('li').html(j=>renderJournal(j));
      } else jWrap.html('<h3>Top Journals</h3><p class="meta">No journals</p>');

      const pWrap = panel.select('#pubs-section');
      if(pubs.length){
        pWrap.html('<h3>Relevant Publications</h3>');
        const ul = pWrap.append('ul').attr('class','list');
        ul.selectAll('li').data(pubs.slice(0,20)).join('li').html(p => renderPub(p));
      } else {
        pWrap.html('<h3>Relevant Publications</h3><p class="meta">No publications available for this topic.</p>');
      }
    }).catch(err=>{
      if (err.name === 'AbortError') return;
      console.warn('loadSideDataOnce error', err);
    });
  }

  function renderJournal(j) {
    return `
      <div class="line1">
        <span class="j-title">${escapeHTML(j.Journal)}</span>
        <span class="badge">${j.count_in_topic}</span>
      </div>
      <small>IF ${escapeHTML(j.IF || '–')}</small>
    `;
  }

  function parseIF(v){
    if(v==null) return null;
    if(typeof v === 'number') return v;
    if(typeof v === 'string'){
      const s = v.replace(/,/g,'.').replace(/[^0-9.]/g,'');
      const num = parseFloat(s);
      return Number.isFinite(num) ? num : null;
    }
    return null;
  }

  function renderPub(p){
    const title = escapeHTML(p.Title || p.title || p.name || 'Untitled');
    const year = p.Year || p.year || (p.date && (p.date.year || new Date(p.date).getFullYear())) || '';
    const authors = Array.isArray(p.Authors) ? p.Authors.join(', ') : (p.authors || p.Authors || '');
    const venue = p.Journal || p.venue || p.source || '';
    const href = p.url || p.URL || p.DOI ? (p.url || p.URL || `https://doi.org/${p.DOI}`) : null;
    const meta = [authors, year, venue].filter(Boolean).join(' · ');
    return href ? `<a href="${href}" target="_blank" rel="noopener">${title}</a><br/><small>${escapeHTML(meta)}</small>`
                : `${title}<br/><small>${escapeHTML(meta)}</small>`;
  }

  function draw(data){
    root = pack(data);
    focus = root;

    // remove previous nodes/labels if any
    gNodes.selectAll('*').interrupt().remove();
    gLabels.selectAll('*').remove();

    const nodes = gNodes.selectAll('circle').data(root.descendants()).join('circle')
      .attr('class', d => d.children ? 'node node--internal' : 'node node--leaf')
      .attr('fill', d => {
        if (!d.children) return '#ffffff';
        return depthColors[d.depth] || depthColors[depthColors.length - 2];
      })
      .on('mouseover', function(event, d){
        d3.select(this).classed('is-hover', true);
        const name = d.data.name || '';
        const shortName = name.length > 40 ? name.slice(0, 40) + '…' : name;
        tooltip.style('opacity', 1).html(`<strong>${escapeHTML(shortName)}</strong>${d.data.size?` • ${d.data.size}`:''}`);
      })
      .on('mousemove', function(event){
        const {pageX:x, pageY:y} = event;
        tooltip.style('left', x + 'px').style('top', y - 18 + 'px');
      })
      .on('mouseout', function(){
        d3.select(this).classed('is-hover', false);
        tooltip.style('opacity', 0);
      })
      .on('click', (event, d)=>{
        if (selectedEl && selectedEl !== event.currentTarget) {
          d3.select(selectedEl).classed('is-selected', false);
        }
        selectedEl = event.currentTarget;
        d3.select(selectedEl).classed('is-selected', true);

        if (d.children) {
          if (focus !== d) { zoomToNode(d); }
          showDetails(d);
        } else {
          const parent = d.parent || root;
          if (focus !== parent) { zoomToNode(parent); }
          showDetails(d);
        }
        event.stopPropagation();
      });

    const labels = gLabels.selectAll('text').data(root.descendants()).join('text')
      .style('fill-opacity', d => d.parent === root ? 1 : 0)
      .style('display', d => d.parent === root ? 'inline' : 'none')
      .text(d => d.data.name || '—');

    function zoomTo(v){
      const k = width / v[2];
      view = v;
      labels.attr('transform', d => `translate(${(d.x - v[0]) * k}, ${(d.y - v[1]) * k})`)
            .attr('font-size', d => Math.max(10, Math.min(22, (d.r * k) / 3)));
      nodes.attr('transform', d => `translate(${(d.x - v[0]) * k}, ${(d.y - v[1]) * k})`)
           .attr('r', d => d.r * k);
    }

    function zoom(d){
      const transition = svg.transition().duration(750).tween('zoom', () => {
        const i = d3.interpolateZoom(view, [d.x, d.y, d.r * 2]);
        return t => zoomTo(i(t));
      });

      labels
        .filter(function(n){ return n.parent === d || this.style.display === 'inline'; })
        .transition(transition)
        .style('fill-opacity', n => n.parent === d ? 1 : 0)
        .on('start', function(n){ if(n.parent === d) this.style.display = 'inline'; })
        .on('end', function(n){ if(n.parent !== d) this.style.display = 'none'; });
    }

    zoomTo([root.x, root.y, root.r * 2]);

    // attach a background click listener directly to this svg selection
    svg.on('click.topicExplorer', (event)=>{
      if(focus !== root){ zoomToNode(root); showDetails(root); }
      d3.selectAll('circle.is-selected').classed('is-selected', false);
      selectedEl = null;
    });

    function zoomToNode(d){ focus = d; setCrumbs(d); zoom(d); }

    // Initialize panel + crumbs
    setCrumbs(root);
    showDetails(root);
  }

  // start: fetch and draw (keep abort-aware)
  try {
    const resp = await fetch('data/hierarchy_bubble.json', { signal: abortController.signal });
    if (!resp.ok) throw new Error(`Failed to load hierarchy: ${resp.status}`);
    const data = await resp.json();
    draw(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      // aborted during cleanup — ignore
    } else {
      panel.html('<p class="meta">Failed to load hierarchy_bubble.json</p>');
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
    cachePromise = null;
    authorsCache = null;
    topicSummary = null;

    // remove svg-level listener namespace
    try { svg.on('.topicExplorer', null); } catch(e){}

    selectedEl = null;
  }

  // also support named export destroy()
  return cleanup;
}

export async function destroy() {
  // This function is present as an alternate lifecycle hook if needed.
  // Consumers can call it (but main loader will call the cleanup returned by init()).
  // noop here because init returns cleanup — actual cleanup happens via that function.
  return;
}
