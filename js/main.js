// js/main.js
const mountRoot = document.getElementById('main-view');
let current = { name: null, module: null, cleanup: null };

async function loadView(viewName) {
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
    current = { name: viewName, module: mod, cleanup: null };

    // call init with a well-scoped mount node
    // allow init to return a cleanup function (optional)
    if (mod.init) {
      const mountNode = mountRoot.querySelector('.view-wrapper');
      const maybeCleanup = await mod.init({ mount: mountNode });
      if (typeof maybeCleanup === 'function') current.cleanup = maybeCleanup;
    }
  } catch (err) {
    console.error('Failed to load view', viewName, err);
    mountRoot.innerHTML = `<div class="view-error">Failed to load view: ${err.message}</div>`;
  }
}

// wire tabs
document.querySelectorAll('.nav-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadView(btn.dataset.view);
  });
});

// Initial load
loadView('topic_explorer');

// optionally expose for debugging
window._rv = { loadView };

