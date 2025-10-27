const DEBOUNCE_MS = 250;
const MAX_COLLAPSED_AUTHORS = 3;

let state = null;
let elements = null;
let dataCache = null;
let navigateFn = null;
let searchTimer = null;
let fetchController = null;
let modeHandlers = null;

function escapeHTML(value) {
  return (value == null ? "" : String(value)).replace(/[&<>"]/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

function formatYear(year) {
  if (year == null || Number.isNaN(year)) return "—";
  return String(year);
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "0";
  return String(value);
}

function updateModeButtons(mode) {
  elements.modeButtons.forEach(btn => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  elements.searchInput.placeholder = mode === "authors"
    ? "Search names, affiliations, topics…"
    : "Search titles, authors, venues, topics…";
}

function updateRoute(partial) {
  if (!navigateFn) return;
  navigateFn(partial);
}

function applySearch(items, term) {
  const trimmed = term.trim().toLowerCase();
  if (!trimmed) return items;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter(item => {
    const blob = item.search_blob || "";
    return tokens.every(token => blob.includes(token));
  });
}

function renderPublications(items) {
  if (!items.length) {
    elements.results.innerHTML = `<div class="library-empty">No results. Try a different search.</div>`;
    return;
  }

  const rows = items.map(pub => {
    const segments = pub.authors.map((a, idx) => {
      const name = escapeHTML(a.name || "Unknown");
      const cls = a.local ? "author-name author-name--local" : "author-name";
      const suffix = idx < pub.authors.length - 1 ? ', ' : '';
      return `<span class="${cls}">${name}</span>${suffix}`;
    });
    const expanded = state.expandedPublications.has(pub.id);
    const topicTags = pub.topics.map(tag => `<span class="tag">${escapeHTML(tag.name)}</span>`).join("");
    const doiLink = pub.doi ? `https://doi.org/${pub.doi}` : null;
    const fallbackLink = pub.openalex_url || null;
    const linkHref = doiLink || fallbackLink;
    const linkTitle = doiLink ? "Open DOI" : "Open in OpenAlex";
    const linkIcon = linkHref ? `<a class="link-icon" href="${escapeHTML(linkHref)}" target="_blank" rel="noopener" aria-label="${escapeHTML(linkTitle)}">🔗</a>` : "";

    return `
      <tr>
        <td class="col-year">${formatYear(pub.year)}</td>
        <td class="col-title">
          <div class="library-title">
            <span class="title-text">${escapeHTML(pub.title || "Untitled")}</span>
            ${linkIcon}
          </div>
          <div class="authors-wrap" data-role="authors-wrap">
            <div class="library-authors${expanded ? '' : ' collapsed'}"
                data-role="authors"
                data-id="${escapeHTML(pub.id)}">
              ${segments.join('') || "—"}
            </div>
            <button type="button"
                    class="library-authors-toggle"
                    data-role="authors-toggle"
                    data-id="${escapeHTML(pub.id)}"
                    hidden>
              (${expanded ? 'less' : 'more'})
            </button>
          </div>
          <div class="library-venue">${escapeHTML(pub.venue || "—")}</div>
          <div class="library-tags">${topicTags}</div>
        </td>
        <td class="col-citations">${formatNumber(pub.cited_by_count)}</td>
      </tr>
    `;
  }).join("");

  elements.results.innerHTML = `
    <table class="library-table library-table--publications">
      <thead>
        <tr>
          <th scope="col" class="col-year">Year</th>
          <th scope="col" class="col-title">Publication</th>
          <th scope="col" class="col-citations">Citations</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  requestAnimationFrame(setupAuthorOverflow);
}

function renderAuthors(items) {
  if (!items.length) {
    elements.results.innerHTML = `<div class="library-empty">No results. Try a different search.</div>`;
    return;
  }

  const rows = items.map(author => {
    const topicTags = author.topics.map(tag => `<span class="tag">${escapeHTML(tag.name)}</span>`).join("");
    return `
      <tr>
        <td class="col-author">
          <div class="library-author-name">${escapeHTML(author.name || "Unknown author")}</div>
          <div class="library-author-affiliation">${escapeHTML(author.affiliation || "—")}</div>
          <div class="library-tags">${topicTags}</div>
        </td>
        <td class="col-pubs">${formatNumber(author.publication_count)}</td>
        <td class="col-citations">${formatNumber(author.citation_count)}</td>
      </tr>
    `;
  }).join("");

  elements.results.innerHTML = `
    <table class="library-table library-table--authors">
      <thead>
        <tr>
          <th scope="col" class="col-author">Author</th>
          <th scope="col" class="col-pubs">Publications</th>
          <th scope="col" class="col-citations">Citations</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  const toggles = elements.results.querySelectorAll('[data-role="authors-toggle"]');
  toggles.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (state.expandedPublications.has(id)) {
        state.expandedPublications.delete(id);
      } else {
        state.expandedPublications.add(id);
      }
      render();
    });
  });
}

function render() {
  if (!state || !elements || !dataCache) return;
  const dataset = state.mode === "authors" ? dataCache.authors : dataCache.publications;
  if (!dataset) return;
  updateModeButtons(state.mode);
  elements.searchInput.value = state.search;

  let items = applySearch(dataset, state.search);
  if (state.mode === "publications") {
    items = [...items].sort((a, b) => {
      const yearA = a.year ?? -Infinity;
      const yearB = b.year ?? -Infinity;
      if (yearA !== yearB) return yearB - yearA;
      const citeA = a.cited_by_count ?? 0;
      const citeB = b.cited_by_count ?? 0;
      if (citeA !== citeB) return citeB - citeA;
      return (a.title || "").localeCompare(b.title || "");
    });
    renderPublications(items);
  } else {
    items = [...items].sort((a, b) => {
      const pubsA = a.publication_count ?? 0;
      const pubsB = b.publication_count ?? 0;
      if (pubsA !== pubsB) return pubsB - pubsA;
      const citeA = a.citation_count ?? 0;
      const citeB = b.citation_count ?? 0;
      if (citeA !== citeB) return citeB - citeA;
      return (a.name || "").localeCompare(b.name || "");
    });
    renderAuthors(items);
  }
}

function setupAuthorOverflow() {
  if (!elements || !state || state.mode !== "publications") return;

  const wraps = Array.from(elements.results.querySelectorAll('[data-role="authors-wrap"]'));
  wraps.forEach(wrap => {
    const block = wrap.querySelector('[data-role="authors"]');
    const toggle = wrap.querySelector('[data-role="authors-toggle"]');
    if (!block || !toggle) return;

    const id = block.dataset.id;
    const expanded = state.expandedPublications.has(id);

    block.classList.toggle('collapsed', !expanded);

    // Measure overflow only when collapsed
    let hasOverflow = false;
    if (!expanded) {
      // Force layout; handle sub-pixel differences
      hasOverflow = (block.scrollWidth - block.clientWidth) > 1;
      block.dataset.overflow = hasOverflow ? 'true' : 'false';
    }

    // Toggle visibility
    if (!expanded && hasOverflow) {
      toggle.hidden = false;
      toggle.textContent = '(more)';
    } else if (expanded) {
      toggle.hidden = false;
      toggle.textContent = '(less)';
    } else {
      toggle.hidden = true;
    }

    // Click
    toggle.onclick = () => {
      if (expanded) {
        state.expandedPublications.delete(id);
      } else if (block.dataset.overflow === 'true') {
        state.expandedPublications.add(id);
      }
      // Re-run measurement after state change
      requestAnimationFrame(setupAuthorOverflow);
    };
  });

  // Re-measure on container resizes (font/viewport/column width changes)
  if (!setupAuthorOverflow._ro) {
    const ro = new ResizeObserver(() => setupAuthorOverflow());
    wraps.forEach(w => ro.observe(w));
    setupAuthorOverflow._ro = ro;
  }
}


function setMode(nextMode, { updateRoute: shouldUpdate = true } = {}) {
  if (state.mode === nextMode) return;
  state.mode = nextMode;
  if (nextMode !== "publications" && state.expandedPublications) {
    state.expandedPublications.clear();
  }
  if (shouldUpdate) {
    updateRoute({ mode: nextMode === "publications" ? null : nextMode });
  }
  render();
}

function setSearch(nextSearch, { updateRoute: shouldUpdate = true } = {}) {
  if (state.search === nextSearch) return;
  state.search = nextSearch;
  if (state.expandedPublications) {
    state.expandedPublications.clear();
  }
  if (shouldUpdate) {
    updateRoute({ q: nextSearch || null });
  }
  render();
}

function handleSearchInput(event) {
  const value = event.target.value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setSearch(value, { updateRoute: true });
  }, DEBOUNCE_MS);
}

async function loadData() {
  if (dataCache) return dataCache;
  fetchController = new AbortController();
  const signal = fetchController.signal;
  const [pubsResp, authorsResp] = await Promise.all([
    fetch("data/library_publications.json", { signal }),
    fetch("data/library_authors.json", { signal }),
  ]);

  if (!pubsResp.ok) throw new Error(`Failed to load library_publications.json (${pubsResp.status})`);
  if (!authorsResp.ok) throw new Error(`Failed to load library_authors.json (${authorsResp.status})`);

  const pubsData = await pubsResp.json();
  const authorsData = await authorsResp.json();
  dataCache = {
    publications: (pubsData.items || []).map(item => ({
      ...item,
      topics: Array.isArray(item.topics) ? item.topics : [],
      authors: Array.isArray(item.authors) ? item.authors : [],
      search_blob: (item.search_blob || "").toString().toLowerCase(),
    })),
    authors: (authorsData.items || []).map(item => ({
      ...item,
      topics: Array.isArray(item.topics) ? item.topics : [],
      search_blob: (item.search_blob || "").toString().toLowerCase(),
    })),
  };
  return dataCache;
}

export async function init({ mount, route = {}, navigate } = {}) {
  if (!mount) throw new Error("library.init requires { mount } DOM element");
  const root = mount.querySelector(".library-view");
  if (!root) throw new Error("library view markup missing .library-view container");

  state = {
    mode: route.mode === "authors" ? "authors" : "publications",
    search: typeof route.q === "string" ? route.q : "",
    expandedPublications: new Set(),
  };
  navigateFn = typeof navigate === "function" ? navigate : null;

  elements = {
    root,
    searchInput: root.querySelector('[data-role="search"]'),
    modeButtons: Array.from(root.querySelectorAll('[data-role="mode-btn"]')),
    results: root.querySelector("#library-results"),
  };

  if (!elements.searchInput || elements.modeButtons.length !== 2 || !elements.results) {
    throw new Error("library view markup incomplete");
  }

  elements.searchInput.value = state.search;
  updateModeButtons(state.mode);

  elements.searchInput.addEventListener("input", handleSearchInput);
  modeHandlers = [];
  elements.modeButtons.forEach(btn => {
    const handler = () => {
      const mode = btn.dataset.mode === "authors" ? "authors" : "publications";
      setMode(mode);
    };
    modeHandlers.push({ btn, handler });
    btn.addEventListener("click", handler);
  });

  try {
    elements.results.innerHTML = '<div class="library-empty">Loading…</div>';
    await loadData();
    render();
  } catch (err) {
    console.error(err);
    elements.results.innerHTML = `<div class="library-empty error">Failed to load library data.</div>`;
  }

  return function cleanup() {
    if (searchTimer) clearTimeout(searchTimer);
    if (fetchController) {
      try { fetchController.abort(); } catch (e) {}
    }
    if (elements) {
      elements.searchInput.removeEventListener("input", handleSearchInput);
      if (modeHandlers) {
        modeHandlers.forEach(({ btn, handler }) => {
          btn.removeEventListener("click", handler);
        });
      }
    }
    state = null;
    dataCache = null;
    elements = null;
    navigateFn = null;
    fetchController = null;
    modeHandlers = null;
  };
}

export function onRouteChange({ params = {}, navigate } = {}) {
  if (typeof navigate === "function") {
    navigateFn = navigate;
  }
  if (!state || !elements) return;
  const nextMode = params.mode === "authors" ? "authors" : "publications";
  const nextSearch = typeof params.q === "string" ? params.q : "";

  const modeChanged = nextMode !== state.mode;
  const searchChanged = nextSearch !== state.search;

  state.mode = nextMode;
  state.search = nextSearch;
  if (searchChanged && state.expandedPublications) {
    state.expandedPublications.clear();
  }

  if (modeChanged) {
    updateModeButtons(state.mode);
  }
  if (searchChanged) {
    elements.searchInput.value = state.search;
  }
  render();
}

export async function destroy() {
  // Cleanup handled by init's returned function.
  return;
}

export const __test = {
  setupAuthorOverflow,
  setContext(newState, newElements) {
    state = newState;
    elements = newElements;
  },
};
