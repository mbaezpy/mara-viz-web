// js/main.js
const mountRoot = document.getElementById('main-view');
let current = { name: null, module: null, cleanup: null, params: {}, onRouteChange: null };

function parseHash() {
  const defaultRoute = { view: 'topic_explorer', params: {} };
  const raw = window.location.hash || '';
  if (!raw || raw === '#') {
    return defaultRoute;
  }

  const trimmed = raw.replace(/^#/, '');

  if (trimmed.startsWith('/')) {
    const pathQuery = trimmed.slice(1);
    const [path, query = ''] = pathQuery.split('?');
    const view = path ? decodeURIComponent(path) : defaultRoute.view;
    const params = query ? Object.fromEntries(new URLSearchParams(query).entries()) : {};
    return { view, params };
  }

  // fallback for legacy hash style (#view=topic_explorer&...)
  if (trimmed.includes('=')) {
    const search = new URLSearchParams(trimmed);
    const view = search.get('view') || defaultRoute.view;
    search.delete('view');
    const params = Object.fromEntries(search.entries());
    return { view, params };
  }

  return { view: decodeURIComponent(trimmed) || defaultRoute.view, params: {} };
}

function buildHash(view, params) {
  const clean = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    clean[key] = value;
  });
  const query = new URLSearchParams(clean).toString();
  const base = `#/${encodeURIComponent(view)}`;
  return query ? `${base}?${query}` : base;
}

function setActiveTab(viewName) {
  document.querySelectorAll('.nav-tabs button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
}

function setRoute(viewName, updates = {}, options = {}) {
  const currentRoute = parseHash();
  const baseParams = viewName === currentRoute.view ? currentRoute.params : {};
  const merged = { ...baseParams, ...updates };
  Object.keys(merged).forEach(key => {
    const value = merged[key];
    if (value === undefined || value === null || value === '') {
      delete merged[key];
    }
  });

  const nextHash = buildHash(viewName, merged);
  const currentHash = window.location.hash || '';

  const applyRoute = () => loadRoute({ view: viewName, params: merged });

  if (options.replace) {
    if (currentHash === nextHash) {
      applyRoute();
    } else {
      window.history.replaceState(null, '', nextHash);
      applyRoute();
    }
  } else if (currentHash === nextHash) {
    applyRoute();
  } else {
    window.location.hash = nextHash;
  }
}

async function loadView(viewName, params = {}) {
  try {
    // fetch view HTML and replace inside mountRoot
    const res = await fetch(`views/${viewName}.html`);
    if (!res.ok) throw new Error(`Failed to fetch view ${viewName}: ${res.status}`);
    const html = await res.text();
    // clear mountRoot and insert wrapper
    mountRoot.innerHTML = `<div class="view-wrapper" data-view="${viewName}">${html}</div>`;

    // if previous module exports destroy or returned cleanup, call it
    if (current.module && typeof current.module.destroy === 'function') {
      try { await current.module.destroy(); } catch(e){ console.warn('destroy() failed', e); }
    }
    if (current.cleanup && typeof current.cleanup === 'function') {
      try { current.cleanup(); } catch(e){ console.warn('cleanup() failed', e); }
    }

    // dynamic import of view script (js/<viewName>.js)
    const mod = await import(`./${viewName}.js`);
    const navigateForView = (updates = {}, options = {}) => setRoute(viewName, updates, options);
    current = { name: viewName, module: mod, cleanup: null, params, onRouteChange: typeof mod.onRouteChange === 'function' ? mod.onRouteChange : null };

    // call init with a well-scoped mount node
    // allow init to return a cleanup function (optional)
    if (mod.init) {
      const mountNode = mountRoot.querySelector('.view-wrapper');
      const maybeCleanup = await mod.init({ mount: mountNode, route: { ...params }, navigate: navigateForView });
      if (typeof maybeCleanup === 'function') current.cleanup = maybeCleanup;
    }
    current.params = { ...params };
  } catch (err) {
    console.error('Failed to load view', viewName, err);
    mountRoot.innerHTML = `<div class="view-error">Failed to load view: ${err.message}</div>`;
  }
}

async function loadRoute(route) {
  const viewChanged = route.view !== current.name;
  if (viewChanged) {
    await loadView(route.view, route.params);
  } else {
    current.params = { ...route.params };
    if (typeof current.onRouteChange === 'function') {
      current.onRouteChange({
        params: { ...route.params },
        navigate: (updates = {}, options = {}) => setRoute(route.view, updates, options)
      });
    }
  }
  setActiveTab(route.view);
}

// wire tabs
document.querySelectorAll('.nav-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    setRoute(btn.dataset.view, {}, { replace: false });
  });
});

window.addEventListener('hashchange', () => {
  const route = parseHash();
  loadRoute(route);
});

// Initial load
const initialRoute = parseHash();
if (!window.location.hash) {
  setRoute(initialRoute.view, initialRoute.params, { replace: true });
} else {
  loadRoute(initialRoute);
}

// optionally expose for debugging
window._rv = { loadView, setRoute, parseHash };
