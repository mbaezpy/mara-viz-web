import {
  buildTopicColorMapFromTopicIds,
  topLevelOf,
  colorForTopicId as resolveTopicColor,
} from "./topic_colors.js";

const DEBOUNCE_MS = 250;
const ROUTE_UPDATE_MS = 200;

const FACETS = ["topics", "authors", "journals"];
const SORT_DEFAULTS = {
  publications: { field: "year", order: "desc" },
  authors: { field: "name", order: "asc" },
};
const SORTABLE_FIELDS = {
  publications: {
    year: { label: "Year", type: "number", defaultOrder: "desc", className: "col-year" },
    title: { label: "Publication", type: "string", defaultOrder: "asc", className: "col-title" },
    citations: { label: "Citations", type: "number", defaultOrder: "desc", className: "col-citations" },
  },
  authors: {
    name: { label: "Author", type: "string", defaultOrder: "asc", className: "col-author" },
    publications: { label: "Publications", type: "number", defaultOrder: "desc", className: "col-pubs" },
    citations: { label: "Citations", type: "number", defaultOrder: "desc", className: "col-citations" },
  },
};

let state = null;
let elements = null;
let dataCache = null;
let navigateFn = null;
let searchTimer = null;
let routeTimer = null;
let fetchController = null;
let modeHandlers = null;
let toastTimer = null;
let filterOverflowRaf = null;

function escapeHTML(value) {
  return (value == null ? "" : String(value)).replace(/[&<>"]/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

function normalize(str = "") {
  return str
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function cssEscape(value) {
  try {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
  } catch (err) {
    // ignore
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function dedupeArrayById(arr) {
  const seen = new Set();
  return arr.filter(item => {
    const key = item.id || normalize(item.label || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatYear(year) {
  if (year == null || Number.isNaN(year)) return "—";
  return String(year);
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "0";
  return new Intl.NumberFormat().format(value);
}

function tokenizeSearch(query) {
  return dedupeArrayById(
    (normalize(query) || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(token => ({ id: token, label: token }))
  ).map(t => t.id);
}

function applySearch(items = [], query = "") {
  if (!Array.isArray(items) || !items.length) return items || [];
  const tokens = tokenizeSearch(query);
  if (!tokens.length) return items;
  return items.filter(item => {
    const parts = [
      item.name,
      item.affiliation,
      ...(Array.isArray(item.topics) ? item.topics.map(tag => tag.label || tag.name || tag) : []),
    ];
    const blob = normalize(parts.join(" "));
    if (!blob) return false;
    return tokens.every(token => blob.includes(token));
  });
}

function getSortState(mode) {
  const fallback = SORT_DEFAULTS[mode] || SORT_DEFAULTS.publications;
  const stored = state?.sort?.[mode];
  if (stored && SORTABLE_FIELDS[mode]?.[stored.field]) {
    return stored;
  }
  return { ...fallback };
}

function parseSortParam(mode, value) {
  const defaults = SORT_DEFAULTS[mode];
  if (!value || typeof value !== "string") return { ...defaults };
  const [fieldRaw = "", orderRaw = ""] = value.split(":");
  const field = fieldRaw.trim();
  const meta = SORTABLE_FIELDS[mode]?.[field];
  if (!meta) return { ...defaults };
  const order = orderRaw.trim().toLowerCase() === "asc" ? "asc" : orderRaw.trim().toLowerCase() === "desc" ? "desc" : meta.defaultOrder;
  return { field, order };
}

function formatSortParam(mode) {
  const sort = getSortState(mode);
  return `${sort.field}:${sort.order}`;
}

function compareValues(a, b, type, order) {
  let result = 0;
  if (type === "number") {
    const toNumber = value => {
      const num = Number(value);
      return Number.isFinite(num) ? num : Number.NEGATIVE_INFINITY;
    };
    const numA = toNumber(a);
    const numB = toNumber(b);
    result = numA - numB;
  } else {
    const strA = (a == null ? "" : String(a)).toLowerCase();
    const strB = (b == null ? "" : String(b)).toLowerCase();
    result = strA.localeCompare(strB);
  }
  return order === "asc" ? result : -result;
}

function sortPublications(items = []) {
  const sort = getSortState("publications");
  const meta = SORTABLE_FIELDS.publications[sort.field];
  if (!meta) return items;
  return [...items].sort((a, b) => {
    let valueA;
    let valueB;
    if (sort.field === "year") {
      valueA = a.year ?? Number.NEGATIVE_INFINITY;
      valueB = b.year ?? Number.NEGATIVE_INFINITY;
    } else if (sort.field === "title") {
      valueA = a.title || "";
      valueB = b.title || "";
    } else if (sort.field === "citations") {
      valueA = a.cited_by_count ?? 0;
      valueB = b.cited_by_count ?? 0;
    }
    return compareValues(valueA, valueB, meta.type, sort.order);
  });
}

function sortAuthors(items = []) {
  const sort = getSortState("authors");
  const meta = SORTABLE_FIELDS.authors[sort.field];
  if (!meta) return items;
  return [...items].sort((a, b) => {
    let valueA;
    let valueB;
    if (sort.field === "name") {
      valueA = a.name || "";
      valueB = b.name || "";
    } else if (sort.field === "publications") {
      valueA = a.publication_count ?? 0;
      valueB = b.publication_count ?? 0;
    } else if (sort.field === "citations") {
      valueA = a.citation_count ?? 0;
      valueB = b.citation_count ?? 0;
    }
    return compareValues(valueA, valueB, meta.type, sort.order);
  });
}

function buildSelectOptions() {
  elements.modeButtons.forEach(btn => {
    const isActive = btn.dataset.mode === state.mode;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  elements.searchInput.placeholder =
    state.mode === "authors"
      ? "Search names, affiliations, topics…"
      : "Search titles, authors, venues, topics…";
}

function updateSearchUI() {
  elements.searchClear.hidden = !state.search;
  elements.searchSpinner.hidden = true;
}

function createPanels() {
  const pubPanel = document.createElement("div");
  pubPanel.className = "library-panel";
  pubPanel.dataset.panel = "publications";

  const authorPanel = document.createElement("div");
  authorPanel.className = "library-panel";
  authorPanel.dataset.panel = "authors";

  elements.results.innerHTML = "";
  elements.results.appendChild(pubPanel);
  elements.results.appendChild(authorPanel);

  authorPanel.style.display = "none";

  elements.panels = {
    publications: pubPanel,
    authors: authorPanel,
  };
}

function highlightText(text, tokens) {
  if (!text) return "";
  if (!tokens || !tokens.length) return escapeHTML(text);
  const chars = Array.from(text);
  if (!chars.length) return "";

  const normalizedChars = [];
  const indexMap = [];
  chars.forEach((char, idx) => {
    const normalized = char
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase() || char.toLowerCase();
    for (let i = 0; i < normalized.length; i += 1) {
      normalizedChars.push(normalized[i]);
      indexMap.push(idx);
    }
  });

  if (!normalizedChars.length) return escapeHTML(text);

  const normalizedText = normalizedChars.join("");
  const mask = new Array(chars.length).fill(false);

  tokens.forEach(token => {
    if (!token) return;
    const target = token.toLowerCase();
    if (!target) return;
    let searchIndex = 0;
    while (searchIndex <= normalizedText.length - target.length) {
      const found = normalizedText.indexOf(target, searchIndex);
      if (found === -1) break;
      const startIdx = indexMap[found];
      const endIdx = indexMap[Math.min(found + target.length - 1, indexMap.length - 1)];
      for (let i = startIdx; i <= endIdx; i += 1) {
        mask[i] = true;
      }
      searchIndex = found + target.length;
    }
  });

  let result = "";
  let open = false;
  chars.forEach((char, idx) => {
    const isMarked = mask[idx];
    if (isMarked && !open) {
      result += "<mark>";
      open = true;
    } else if (!isMarked && open) {
      result += "</mark>";
      open = false;
    }
    result += escapeHTML(char);
  });
  if (open) result += "</mark>";
  return result;
}

function highlightMatches(container, facet, entryId) {
  if (!container) return;
  let selector = "";
  const escaped = cssEscape(entryId);
  if (facet === "topics") selector = `[data-topic-id="${escaped}"]`;
  if (facet === "authors") selector = `[data-author-id="${escaped}"]`;
  if (facet === "journals") selector = `[data-journal-id="${escaped}"]`;
  if (!selector) return;
  container.querySelectorAll(selector).forEach(el => {
    el.classList.add("flash-highlight");
    setTimeout(() => el.classList.remove("flash-highlight"), 1000);
  });
}

function getSortMeta(mode, field) {
  return SORTABLE_FIELDS[mode]?.[field];
}

function renderSortableHeader(mode, field) {
  const meta = getSortMeta(mode, field);
  if (!meta) return "";
  const sort = getSortState(mode);
  const isActive = sort.field === field;
  const symbol = sort.order === "asc" ? "▲" : "▼";
  const ariaSort = isActive ? (sort.order === "asc" ? "ascending" : "descending") : "none";
  const attrs = [
    `scope="col"`,
    `class="${meta.className} sortable"`,
    `role="button"`,
    `tabindex="0"`,
    `data-field="${field}"`,
    `data-mode="${mode}"`,
    `data-sort-active="${isActive}"`,
    `data-sort-symbol="${isActive ? symbol : ""}"`,
    `aria-sort="${ariaSort}"`,
  ];
  return `<th ${attrs.join(" ")}>${meta.label}</th>`;
}

function attachSortInteractions(panel, mode) {
  panel.querySelectorAll("th.sortable").forEach(th => {
    const field = th.dataset.field;
    const handler = () => setSort(mode, field);
    th.addEventListener("click", handler);
    th.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler();
      }
    });
  });
}

function renderPublications(panel, items) {
  if (!items.length) {
    panel.innerHTML = `
      <div class="library-empty">
        No results for current filters.
        <button type="button" class="library-filter-clear" data-role="clear-all">Clear all</button>
      </div>`;
    return;
  }

  const rows = items.map(pub => {
    const titleHTML = highlightText(pub.title || "Untitled", state.searchTokens);
    const authorsHTML = pub.authors
      .map((a, idx) => {
        const suffix = idx < pub.authors.length - 1 ? ", " : "";
        if (a.local) {
          const key = a._key;
          const rawLabel = a.name || "Unknown";
          const safeKey = escapeHTML(key);
          const safeLabel = escapeHTML(rawLabel);
          const ariaLabel = `Add filter: Author ${rawLabel}`;
          return `<button type="button" class="library-author-link" data-author-id="${safeKey}" data-author-label="${safeLabel}" title="Add filter" aria-label="${escapeHTML(ariaLabel)}">${highlightText(rawLabel, state.searchTokens)}</button>${suffix}`;
        }
        return `${highlightText(a.name || "Unknown", state.searchTokens)}${suffix}`;
      })
      .join("");
    const venueLabelRaw = pub.venue_name || pub.venue || "—";
    const venueLabel = escapeHTML(venueLabelRaw);
    const venueButton = pub.venue_key
      ? `<button type="button"
            class="tag tag--venue tag--clickable library-venue-link"
            data-journal-id="${escapeHTML(pub.venue_key)}"
            data-journal-label="${venueLabel}"
            title="Add filter"
            aria-label="${escapeHTML(`Add filter: Journal ${venueLabelRaw}`)}">
            <span class="tag-icon">J</span>
            <span class="tag-label">${venueLabel}</span>
        </button>`
      : venueLabel;
    const topicTags = (pub.topics || [])
      .map(tag => {
        const color = dataCache.colorForTopicId
          ? dataCache.colorForTopicId(tag.top_level_id || tag.id)
          : "#94a3b8";
        const label = tag.label;
        return `
          <button type="button"
            class="tag tag--topic tag--clickable"
            data-topic-id="${escapeHTML(tag.id)}"
            data-topic-label="${escapeHTML(label)}"
            style="--topic-color:${color}"
            title="Add filter" aria-label="${escapeHTML(`Add filter: Topic ${label}`)}">
            <span class="tag-label">${escapeHTML(label)}</span>
          </button>`;
      })
      .join("");


    const doiLink = pub.doi ? `https://doi.org/${pub.doi}` : null;
    const fallbackLink = pub.openalex_url || null;
    const linkHref = doiLink || fallbackLink;
    const linkTitle = doiLink ? "Open DOI" : "Open in OpenAlex";
    const linkIcon = linkHref
      ? `<a class="link-icon" href="${escapeHTML(linkHref)}" target="_blank" rel="noopener" aria-label="${escapeHTML(linkTitle)}">🔗</a>`
      : "";

    return `
      <tr>
        <td class="col-year">${formatYear(pub.year)}</td>
        <td class="col-title">
          <div class="library-title">
            <a class="title-text" href="${escapeHTML(linkHref)}" target="_blank" rel="noopener" aria-label="${escapeHTML(linkTitle)}">
              
              ${titleHTML}
              
            </a>
      
          </div>
          <div class="authors-wrap">
            <div class="library-authors" data-role="authors">${authorsHTML || "—"}</div>
          </div>
          <div class="library-venue" data-journal-id="${escapeHTML(pub.venue_key || "")}" data-journal-label="${venueLabel}">
            ${venueButton}
          </div>
          <div class="library-tags" data-role="topic-tags">${topicTags}</div>
        </td>
        <td class="col-citations numeric">${formatNumber(pub.cited_by_count)}</td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <table class="library-table library-table--publications">
      <thead>
        <tr>
          ${renderSortableHeader("publications", "year")}
          ${renderSortableHeader("publications", "title")}
          ${renderSortableHeader("publications", "citations")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  attachPublicationInteractions(panel);
  attachSortInteractions(panel, "publications");
}

function attachPublicationInteractions(panel) {
  panel.querySelectorAll('[data-role="clear-all"]').forEach(btn => {
    btn.addEventListener("click", clearAllFilters);
  });
  panel.querySelectorAll("[data-topic-id]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.topicId;
      const label = el.dataset.topicLabel || id;
      addFilter("topics", { id, label });
    });
  });

  panel.querySelectorAll("[data-author-id]").forEach(el => {
    if (el.dataset.role === "author-trigger") return;
    el.addEventListener("click", () => {
      const id = el.dataset.authorId;
      const label = el.dataset.authorLabel || id;
      addFilter("authors", { id, label });
    });
  });

  panel.querySelectorAll("[data-journal-id]").forEach(el => {
    el.querySelectorAll(".library-venue-link").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = el.dataset.journalId;
        if (!id) return;
        const label = el.dataset.journalLabel || id;
        addFilter("journals", { id, label });
      });
    });
  });
}

function attachAuthorOverlayInteractions(panel) {
  if (!panel) return;
  panel.querySelectorAll('[data-role="author-trigger"]').forEach(btn => {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      const authorId = btn.dataset.authorId;
      openAuthorOverlay(authorId);
    });
  });
}

function renderAuthors(panel, items) {
  if (!items.length) {
    panel.innerHTML = `<div class="library-empty">No authors for current search.</div>`;
    return;
  }

  const rows = items.map(author => {
    const topicTags = (author.topics || [])
      .map(tag => {
        const colorValue = dataCache.colorForTopicId
          ? dataCache.colorForTopicId(tag.top_level_id || tag.id)
          : "#94a3b8";
        const safeColor = escapeHTML(colorValue || "#94a3b8");
        const label = tag.label || tag.name || tag.id || "—";
        return `
          <button type="button"
            class="tag tag--topic tag--clickable"
            data-topic-id="${escapeHTML(tag.id)}"
            data-topic-label="${escapeHTML(label)}"
            style="--topic-color:${safeColor}"
            title="Add filter" aria-label="${escapeHTML(`Add filter: Topic ${label}`)}">
            <span class="tag-label">${escapeHTML(label)}</span>
          </button>`;
      })
      .join("");
    const safeName = escapeHTML(author.name || "Unknown author");
    const authorId = escapeHTML(author.id || "");
    const triggerLabel = escapeHTML(`View details for ${author.name || "author"}`);
    return `
      <tr>
        <td class="col-author">
          <button type="button"
            class="library-author-trigger"
            data-role="author-trigger"
            data-author-id="${authorId}"
            aria-label="${triggerLabel}">
            <div class="library-author-name">${safeName}</div>
            <div class="library-author-affiliation">${escapeHTML(author.affiliation || "—")}</div>
          </button>
          <div class="library-tags">${topicTags}</div>
        </td>
        <td class="col-pubs numeric">${formatNumber(author.publication_count)}</td>
        <td class="col-citations numeric">${formatNumber(author.citation_count)}</td>
      </tr>`;
  }).join("");

  panel.innerHTML = `
    <table class="library-table library-table--authors">
      <thead>
        <tr>
          ${renderSortableHeader("authors", "name")}
          ${renderSortableHeader("authors", "publications")}
          ${renderSortableHeader("authors", "citations")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  attachPublicationInteractions(panel);
  attachSortInteractions(panel, "authors");
  attachAuthorOverlayInteractions(panel);
  refreshActiveAuthorOverlay();
}

function renderAuthorChart(series = []) {
  if (!Array.isArray(series) || !series.length) {
    return `<div class="library-overlay-empty">No publication data.</div>`;
  }
  const totals = series.map(entry => Math.max(0, (entry.main || 0) + (entry.secondary || 0)));
  const maxTotal = Math.max(...totals, 0);
  if (maxTotal <= 0) {
    return `<div class="library-overlay-empty">No publication data.</div>`;
  }
  return `
    <div class="library-author-chart">
      ${series
        .map(entry => {
          const yearLabel = entry.year == null ? "—" : entry.year;
          const total = Math.max(0, (entry.main || 0) + (entry.secondary || 0));
          const relative = maxTotal ? Math.min(1, total / maxTotal) : 0;
          const mainPortion = total ? Math.max(0, Math.min(1, (entry.main || 0) / total)) : 0;
          const secondaryPortion = 1 - mainPortion;
          return `
            <div class="library-author-chart-row">
              <span>${escapeHTML(String(yearLabel))}</span>
              <div class="library-author-chart-bar" aria-label="${escapeHTML(`Year ${yearLabel}: ${total} publications`)}">
                <div class="library-author-chart-progress" style="width:${(relative * 100).toFixed(2)}%">
                  <span class="chart-segment chart-segment--main" style="width:${(mainPortion * 100).toFixed(2)}%"></span>
                  <span class="chart-segment chart-segment--secondary" style="width:${(secondaryPortion * 100).toFixed(2)}%"></span>
                </div>
              </div>
              <span>${formatNumber(total)}</span>
            </div>`;
        })
        .join("")}
    </div>`;
}

function renderOverlayTopics(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="library-overlay-empty">No topic data available.</p>`;
  }
  return `
    <ul class="list compact">
      ${items
        .map(item => {
          const color = dataCache?.colorForTopicId
            ? dataCache.colorForTopicId(item.top_level_id || item.id)
            : "#94a3b8";
          const badge = `<span class="badge">${formatNumber(item.count || 0)}</span>`;
          return `
            <li>
              <div class="line1">
              <a>
                <span class="topic-color-dot" style="--topic-color:${escapeHTML(color || "#94a3b8")}" aria-hidden="true"></span>
                ${escapeHTML(item.name || item.label || item.id || "Topic")}
              </a>
                ${badge}

              </div>
            </li>`;
        })
        .join("")}
    </ul>`;
}

function renderOverlayJournals(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="library-overlay-empty">No journal data available.</p>`;
  }
  return `
    <ul class="list compact">
      ${items
        .map(item => {
          const badge = `<span class="badge">${formatNumber(item.count || 0)}</span>`;
          const issn = item.issn_l ? `<small>ISSN-L ${escapeHTML(item.issn_l)}</small>` : "";
          return `
            <li>
              <div class="line1">
                ${escapeHTML(item.name || "Unknown journal")}
                ${badge}
              </div>
              ${issn}
            </li>`;
        })
        .join("")}
    </ul>`;
}

function renderOverlayCoauthors(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="library-overlay-empty">No coauthors recorded.</p>`;
  }
  return `
    <ul class="list compact">
      ${items
        .map(item => {
          const badge = `<span class="badge">${formatNumber(item.count || 0)}</span>`;
          const metaParts = [];
          if (item.affiliation) metaParts.push(`<small ${item.is_local? "class='author-local'" : ""}>${escapeHTML(item.affiliation)}</small>`);
          //if (item.is_local) metaParts.push('<small class="author-name--local">Local</small>');
          const meta = metaParts.join("");
          return `
            <li>
              <div class="line1">
                ${escapeHTML(item.name || "Unknown author")}
                ${badge}
              </div>
              ${meta}
            </li>`;
        })
        .join("")}
    </ul>`;
}

function renderTopPublications(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="library-overlay-empty">No publications available.</p>`;
  }
  return `
    <ul class="list">
      ${items
        .map(pub => {
          const link = pub.doi ? `https://doi.org/${pub.doi}` : pub.openalex_url;
          const title = escapeHTML(pub.title || "Untitled publication");
          const metaParts = [];
          if (pub.authors && pub.authors.length) metaParts.push(escapeHTML(pub.authors.slice(0, 4).join(", ")));
          if (pub.venue) metaParts.push(escapeHTML(pub.venue));
          if (pub.year) metaParts.push(escapeHTML(String(pub.year)));
          if (Number.isFinite(pub.cited_by_count)) metaParts.push(`${formatNumber(pub.cited_by_count)} citations`);
          metaParts.push(pub.is_main ? "Main author" : "Co-author");
          const meta = metaParts.join(" · ");
          const linkMarkup = link
            ? `<a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : `<span class="item-label">${title}</span>`;
          return `
            <li>
              ${linkMarkup}
              <br/>
              <small>${meta}</small>
            </li>`;
        })
        .join("")}
    </ul>`;
}

function openAuthorOverlay(authorId) {
  if (!authorId || !elements.overlay || !elements.overlayContent) return;
  const author = dataCache?.authorsById?.get(authorId);
  if (!author) return;
  renderAuthorOverlay(author);
  elements.overlay.classList.add("is-open");
  elements.overlay.setAttribute("aria-hidden", "false");
  state.activeOverlayAuthor = authorId;
  document.removeEventListener("keydown", handleOverlayKeydown);
  document.addEventListener("keydown", handleOverlayKeydown);
  const closeBtn = elements.overlay.querySelector(".library-overlay-close");
  if (closeBtn) closeBtn.focus();
}

function closeAuthorOverlay() {
  if (!elements.overlay) return;
  if (!elements.overlay.classList.contains("is-open")) return;
  elements.overlay.classList.remove("is-open");
  elements.overlay.setAttribute("aria-hidden", "true");
  state.activeOverlayAuthor = null;
  document.removeEventListener("keydown", handleOverlayKeydown);
}

function handleOverlayKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeAuthorOverlay();
  }
}

function refreshActiveAuthorOverlay() {
  if (!state.activeOverlayAuthor || !elements.overlay || !elements.overlay.classList.contains("is-open")) {
    return;
  }
  const author = dataCache?.authorsById?.get(state.activeOverlayAuthor);
  if (!author) {
    closeAuthorOverlay();
    return;
  }
  renderAuthorOverlay(author);
}
function renderAuthorOverlay(author) {
  if (!elements.overlayContent) return;
  const detail = author.detail || {};
  const stats = detail.stats || {};
  const statCards = [
    { label: "Main publications", value: stats.main_publications ?? 0 },
    { label: "Total citations", value: stats.total_citations ?? author.citation_count ?? 0 },
    { label: "Total coauthors", value: stats.coauthor_total ?? 0 },
  ];
  const statsMarkup = `
    <div class="library-author-stats">
      ${statCards
        .map(
          card => `
            <div class="library-author-stat">
              <div class="library-author-stat-value">${formatNumber(card.value)}</div>
              <div class="library-author-stat-label">${escapeHTML(card.label)}</div>
            </div>`
        )
        .join("")}
    </div>`;

  const chartMarkup = renderAuthorChart(detail.year_series);

  const journalsMarkup = renderOverlayJournals(detail.top_journals);
  const coauthorsMarkup = renderOverlayCoauthors(detail.top_coauthors);
  const topicsMarkup = renderOverlayTopics(detail.top_topics);
  const publicationsMarkup = renderTopPublications(detail.top_publications);

  elements.overlayContent.innerHTML = `
    <header>
      <h2 id="library-overlay-title">${escapeHTML(author.name || "Author details")}</h2>
      <div class="library-overlay-affiliation">${escapeHTML(author.affiliation || "—")}</div>
    </header>
    <section class="library-overlay-section">
      <h3>Stats</h3>
      ${statsMarkup}
    </section>
    <section class="library-overlay-section">
      <h3>Publications over time</h3>
      ${chartMarkup}
    </section>
    <section class="library-overlay-section">
      <h3>Top journals</h3>
      ${journalsMarkup}
    </section>
    <section class="library-overlay-section">
      <h3>Top coauthors</h3>
      ${coauthorsMarkup}
    </section>
    <section class="library-overlay-section">
      <h3>Top topics</h3>
      ${topicsMarkup}
    </section>
    <section class="library-overlay-section">
      <h3>Top publications</h3>
      ${publicationsMarkup}
    </section>
  `;
}

function ensurePanel(mode) {
  const cache = state.panelCache[mode];
  const hash = getPanelHash(mode);
  if (cache.rendered && cache.hash === hash) return;

  const panel = elements.panels[mode];
  if (mode === "publications") {
    const items = getFilteredPublications();
    renderPublications(panel, items);
    cache.rendered = true;
    cache.hash = hash;
    cache.metrics = { total: items.length };
  } else {
    const items = getFilteredAuthors();
    renderAuthors(panel, items);
    cache.rendered = true;
    cache.hash = hash;
  }
}

function getPanelHash(mode) {
  if (mode === "authors") {
    return JSON.stringify({
      mode,
      search: state.search,
      sort: getSortState("authors"),
    });
  }
  const filters = state.filters;
  return JSON.stringify({
    mode,
    search: state.search,
    topics: filters.topics.map(f => f.id).sort(),
    authors: filters.authors.map(f => f.id).sort(),
    journals: filters.journals.map(f => f.id).sort(),
    sort: getSortState("publications"),
  });
}

function getFilteredPublications() {
  if (!dataCache) return [];
  const publications = dataCache.publications || [];
  const filters = state.filters;
  const tokens = state.searchTokens || [];
  const topicIds = filters.topics.map(t => t.id);
  const authorIds = filters.authors.map(a => a.id);
  const journalIds = filters.journals.map(j => j.id);

  const filtered = publications.filter(pub => {
    if (tokens.length) {
      const searchBlob = pub._search_norm || "";
      if (!tokens.every(token => searchBlob.includes(token))) {
        return false;
      }
    }

    if (topicIds.length) {
      const pubTopics = pub.topic_ids || [];
      if (!topicIds.some(id => pubTopics.includes(id))) {
        return false;
      }
    }

    if (authorIds.length) {
      const locals = pub.local_author_keys || [];
      if (!authorIds.some(id => locals.includes(id))) return false;
    }

    if (journalIds.length) {
      const venueKey = pub.venue_key;
      if (!venueKey || !journalIds.includes(venueKey)) return false;
    }

    return true;
  });
  return sortPublications(filtered);
}

function getFilteredAuthors() {
  if (!dataCache) return [];
  const authors = dataCache.authors || [];
  const topicIds = state.filters.topics.map(t => t.id);

  const searched = applySearch(authors, state.search);
  if (!topicIds.length) {
    return sortAuthors(searched);
  }
  const filtered = searched.filter(author => {
    const authorTopicIds = (author.topics || []).map(t => t.id);
    if (!authorTopicIds.length) return false;
    return topicIds.some(id => authorTopicIds.includes(id));
  });
  return sortAuthors(filtered);
}

function renderFilterBar() {
  const container = elements.filterBar;
  const filters = state.filters;
  const hasFilters = FACETS.some(facet => filters[facet].length);
  const parts = [];

  if (!hasFilters && !state.search) {
    container.innerHTML = "";
    clearFilterClearButton();
    return;
  }

  FACETS.forEach(facet => {
    const values = filters[facet];
    if (!values.length) return;
    const facetLabel = facet === "topics" ? "Topics" : facet === "authors" ? "Authors" : "Journal";
    parts.push(`<span class="library-filter-label" data-facet="${facet}">${facetLabel}</span>`);
    values.forEach(entry => {
      const label = escapeHTML(entry.label || entry.id);
      const id = escapeHTML(entry.id);
      const chipKey = `${facet}|${entry.id}`;
      const icon = facet === "topics" ? "#" : facet === "authors" ? "@" : "J";
      let extraClass = "";
      let extraStyle = "";
      let glyph = "";
      if (facet === "topics" && dataCache && typeof dataCache.colorForTopicId === "function") {
        const colorValue = dataCache.colorForTopicId(entry.id) || "#94a3b8";
        const safeColor = escapeHTML(colorValue);
        extraClass = " is-topic";
        extraStyle = ` style="--topic-color:${safeColor}"`;
        glyph = '<span class="chip-swatch" aria-hidden="true"></span>';
      }
      parts.push(`
        <span class="library-filter-chip${extraClass}" data-facet="${facet}" data-id="${id}" data-key="${escapeHTML(chipKey)}" tabindex="0" role="button"${extraStyle}>
          ${glyph}
          <span class="chip-icon" aria-hidden="true">${escapeHTML(icon)}</span>
          <span class="chip-label">${label}</span>
          <button type="button" class="remove" aria-label="Remove filter ${facetLabel}: ${label}" data-role="remove-filter" data-facet="${facet}" data-id="${id}">✕</button>
        </span>
      `);
    });
  });

  container.innerHTML = parts.join("");

  container.querySelectorAll('[data-role="remove-filter"]').forEach(btn => {
    btn.addEventListener("click", event => {
      const facet = btn.dataset.facet;
      const id = btn.dataset.id;
      event.stopPropagation();
      removeFilter(facet, id);
    });
  });

  container.querySelectorAll(".library-filter-chip").forEach(chip => {
    chip.addEventListener("click", event => {
      if (event.target.closest("[data-role=\"remove-filter\"]")) return;
      const facet = chip.dataset.facet;
      const id = chip.dataset.id;
      highlightMatches(elements.panels.publications, facet, id);
    });
    chip.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (event.target.closest("[data-role=\"remove-filter\"]")) return;
        const facet = chip.dataset.facet;
        const id = chip.dataset.id;
        highlightMatches(elements.panels.publications, facet, id);
      }
    });
  });

  if (hasFilters) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "library-filter-clear";
    clearBtn.textContent = "Clear all";
    clearBtn.addEventListener("click", clearAllFilters);
    container.appendChild(clearBtn);
  }

  animateNewFilterChips();
  scheduleFilterBarOverflowCheck();
}

function animateNewFilterChips() {
  if (!state || !elements) return;
  const recent = state.recentlyAddedFilters || [];
  if (!recent.length) return;
  const keys = new Set(recent);
  const chips = elements.filterBar.querySelectorAll(".library-filter-chip");
  chips.forEach(chip => {
    const key = chip.dataset.key;
    if (!key || !keys.has(key)) return;
    chip.classList.add("is-new");
    chip.addEventListener(
      "animationend",
      () => {
        chip.classList.remove("is-new");
      },
      { once: true }
    );
  });
  state.recentlyAddedFilters = [];
}

function scheduleFilterBarOverflowCheck() {
  if (!elements || !elements.filterBar) return;
  if (filterOverflowRaf) {
    cancelAnimationFrame(filterOverflowRaf);
  }
  filterOverflowRaf = requestAnimationFrame(() => {
    filterOverflowRaf = null;
    applyFilterBarOverflow();
  });
}

function applyFilterBarOverflow() {
  if (!state || !elements || !elements.filterBar) return;
  const container = elements.filterBar;
  const chips = Array.from(container.querySelectorAll(".library-filter-chip"));
  const labels = Array.from(container.querySelectorAll(".library-filter-label"));

  container.classList.remove("is-collapsed", "is-expanded");
  container.querySelectorAll('[data-role="filter-expand"], [data-role="filter-collapse"]').forEach(btn => {
    btn.remove();
  });
  chips.forEach(chip => chip.classList.remove("is-hidden"));
  labels.forEach(label => label.classList.remove("is-hidden"));

  if (!chips.length) {
    state.filterBarExpanded = false;
    return;
  }

  const rowPositions = [];
  chips.forEach(chip => {
    const top = chip.offsetTop;
    if (!rowPositions.includes(top)) {
      rowPositions.push(top);
    }
  });
  rowPositions.sort((a, b) => a - b);

  const totalRows = rowPositions.length;
  if (totalRows <= 2) {
    state.filterBarExpanded = false;
    return;
  }

  if (!state.filterBarExpanded) {
    container.classList.add("is-collapsed");
    const cutoff = rowPositions[1];
    let hiddenCount = 0;
    chips.forEach(chip => {
      if (chip.offsetTop > cutoff) {
        chip.classList.add("is-hidden");
        hiddenCount += 1;
      }
    });
    labels.forEach(label => {
      const facet = label.dataset.facet;
      if (!facet) return;
      const facetChips = Array.from(container.querySelectorAll(`.library-filter-chip[data-facet="${facet}"]`));
      const hasVisible = facetChips.some(chip => !chip.classList.contains("is-hidden"));
      if (!hasVisible) {
        label.classList.add("is-hidden");
      }
    });
    if (hiddenCount > 0) {
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "library-filter-more";
      expandBtn.dataset.role = "filter-expand";
      expandBtn.textContent = `+ ${hiddenCount} more`;
      expandBtn.addEventListener("click", () => {
        state.filterBarExpanded = true;
        render();
      });
      const clearBtn = container.querySelector(".library-filter-clear");
      if (clearBtn) {
        container.insertBefore(expandBtn, clearBtn);
      } else {
        container.appendChild(expandBtn);
      }
    }
  } else {
    container.classList.add("is-expanded");
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "library-filter-more";
    collapseBtn.dataset.role = "filter-collapse";
    collapseBtn.textContent = "Show less";
    collapseBtn.addEventListener("click", () => {
      state.filterBarExpanded = false;
      render();
    });
    const clearBtn = container.querySelector(".library-filter-clear");
    if (clearBtn) {
      container.insertBefore(collapseBtn, clearBtn);
    } else {
      container.appendChild(collapseBtn);
    }
  }
}

function clearFilterClearButton() {
  elements.filterBar.innerHTML = "";
}

function ensureFilterLabels() {
  if (!dataCache) return;
  const topicIndex = dataCache.topicIndex || new Map();
  const authorIndex = dataCache.authorIndex || new Map();
  const journalIndex = dataCache.journalIndex || new Map();

  FACETS.forEach(facet => {
    state.filters[facet] = state.filters[facet].map(entry => {
      if (entry.label && entry.label !== entry.id) return entry;
      if (facet === "topics") {
        return { ...entry, label: topicIndex.get(entry.id) || entry.label || entry.id };
      }
      if (facet === "authors") {
        return { ...entry, label: authorIndex.get(entry.id) || entry.label || entry.id };
      }
      if (facet === "journals") {
        return { ...entry, label: journalIndex.get(entry.id) || entry.label || entry.id };
      }
      return entry;
    });
  });
}

function render() {
  if (!state || !elements || !dataCache) return;
  buildSelectOptions();
  ensureFilterLabels();
  renderFilterBar();
  ensurePanel(state.mode);
  Object.entries(elements.panels).forEach(([key, node]) => {
    node.style.display = key === state.mode ? "block" : "none";
  });
  updateSearchUI();
  applyPendingHighlights();
}

function applyPendingHighlights() {
  if (!state.pendingHighlights.length) return;
  const panel = elements.panels?.[state.mode] || elements.panels?.publications;
  state.pendingHighlights.forEach(({ facet, id }) => {
    highlightMatches(panel, facet, id);
  });
  state.pendingHighlights = [];
}

function addFilter(facet, entry, options = {}) {
  if (!FACETS.includes(facet) || !entry) return false;
  const { silent = false } = options;
  const filters = state.filters[facet];
  const id = entry.id || normalize(entry.label || "");
  const label = entry.label || entry.id || id;
  if (!id) return false;
  if (filters.some(item => item.id === id)) return false;

  state.filters[facet] = dedupeArrayById([...filters, { id, label }]);
  if (!Array.isArray(state.recentlyAddedFilters)) {
    state.recentlyAddedFilters = [];
  }
  state.filterSequence.push(`${facet}|${id}`);
  state.pendingHighlights.push({ facet, id });
  state.recentlyAddedFilters.push(`${facet}|${id}`);
  invalidatePanels(["publications", "authors"]);
  scheduleRouteUpdate();
  render();
  if (!silent) {
    const facetLabel = facet === "topics" ? "Topic" : facet === "authors" ? "Author" : "Journal";
    showToast(`Added filter: ${facetLabel} = ${label}`);
  }
  return true;
}

function setSort(mode, field) {
  if (!state || !SORTABLE_FIELDS[mode] || !SORTABLE_FIELDS[mode][field]) return;
  if (!state.sort) state.sort = { publications: { ...SORT_DEFAULTS.publications }, authors: { ...SORT_DEFAULTS.authors } };
  const current = getSortState(mode);
  const meta = SORTABLE_FIELDS[mode][field];
  let nextOrder = meta.defaultOrder;
  if (current.field === field) {
    nextOrder = current.order === "asc" ? "desc" : "asc";
  }
  state.sort[mode] = { field, order: nextOrder };
  if (state.panelCache[mode]) {
    state.panelCache[mode].rendered = false;
    state.panelCache[mode].hash = null;
  }
  scheduleRouteUpdate();
  render();
}

function removeFilter(facet, id, options = {}) {
  if (!FACETS.includes(facet)) return;
  const { silent = false } = options;
  const existing = state.filters[facet];
  if (!existing || !existing.length) return;
  const entry = existing.find(item => item.id === id);
  if (!entry) return;
  state.filters[facet] = existing.filter(item => item.id !== id);
  state.filterSequence = state.filterSequence.filter(entry => entry !== `${facet}|${id}`);
  state.lastRemovedFilter = { facet, entry };
  invalidatePanels(["publications", "authors"]);
  scheduleRouteUpdate();
  render();
  if (!silent) {
    const facetLabel = facet === "topics" ? "Topic" : facet === "authors" ? "Author" : "Journal";
    showToast(`Removed filter: ${facetLabel} = ${entry.label || entry.id}`);
  }
  return entry;
}

function clearAllFilters(options = {}) {
  const { resetSearch = true, silent = false, skipRouteUpdate = false, skipRender = false } = options;
  const hadSearch = resetSearch && Boolean(state.search);
  const hadFilters = FACETS.some(facet => state.filters[facet]?.length);
  if (!hadFilters && !hadSearch) return false;

  FACETS.forEach(facet => {
    state.filters[facet] = [];
  });
  state.filterSequence = [];
  state.pendingHighlights = [];
  state.recentlyAddedFilters = [];
  state.filterBarExpanded = false;
  state.lastRemovedFilter = null;
  if (state.expandedPublications && typeof state.expandedPublications.clear === "function") {
    state.expandedPublications.clear();
  }

  if (resetSearch && hadSearch) {
    state.search = "";
    state.searchTokens = [];
    if (elements && elements.searchInput) {
      elements.searchInput.value = "";
    }
    if (elements && elements.searchSpinner) {
      elements.searchSpinner.hidden = true;
    }
    Object.values(state.panelCache).forEach(cache => {
      cache.rendered = false;
      cache.hash = null;
    });
  } else {
    invalidatePanels(["publications", "authors"]);
  }

  if (!skipRouteUpdate) scheduleRouteUpdate();
  if (!skipRender) render();
  if (!silent) showToast("Cleared all filters");
  return true;
}

function removeLastFilter() {
  const lastKey = state.filterSequence[state.filterSequence.length - 1];
  if (!lastKey) return;
  const [facet, id] = lastKey.split("|");
  const filters = state.filters[facet] || [];
  const entry = filters.find(item => item.id === id);
  if (!entry) {
    state.filterSequence.pop();
    return;
  }
  state.filterSequence.pop();
  state.filters[facet] = filters.filter(item => item.id !== id);
  state.lastRemovedFilter = { facet, entry };
  invalidatePanels(["publications", "authors"]);
  scheduleRouteUpdate();
  render();
  const facetLabel = facet === "topics" ? "Topic" : facet === "authors" ? "Author" : "Journal";
  showToast(`Removed filter: ${facetLabel} = ${entry.label || entry.id}`, {
    duration: 2500,
    action: {
      label: "Undo",
      onClick: () => {
        addFilter(facet, entry, { silent: true });
      },
    },
  });
}

function invalidatePanels(modes = ["publications"]) {
  if (!state || !state.panelCache) return;
  modes.forEach(mode => {
    if (state.panelCache[mode]) {
      state.panelCache[mode].rendered = false;
      state.panelCache[mode].hash = null;
    }
  });
}

function scheduleRouteUpdate() {
  if (!navigateFn) return;
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = setTimeout(() => {
    const params = {
      mode: state.mode !== "publications" ? state.mode : null,
      q: state.search ? state.search : null,
      topics: state.filters.topics.length ? state.filters.topics.map(f => f.id).join(",") : null,
      authors: state.filters.authors.length ? state.filters.authors.map(f => f.id).join(",") : null,
      journals: state.filters.journals.length ? state.filters.journals.map(f => f.id).join(",") : null,
      sort: formatSortParam(state.mode),
    };
    navigateFn(params, { replace: true });
  }, ROUTE_UPDATE_MS);
}

function showToast(message, options = {}) {
  const { action, duration = 1500 } = options;
  if (!elements.toast) {
    const toast = document.createElement("div");
    toast.className = "library-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
    elements.toast = toast;
  }
  const toast = elements.toast;
  toast.innerHTML = "";

  const messageSpan = document.createElement("span");
  messageSpan.className = "toast-message";
  messageSpan.textContent = message;
  toast.appendChild(messageSpan);

  if (action && action.label && typeof action.onClick === "function") {
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "toast-action";
    actionBtn.textContent = action.label;
    actionBtn.addEventListener(
      "click",
      () => {
        hideToast();
        action.onClick();
      },
      { once: true }
    );
    toast.appendChild(actionBtn);
  }

  toast.classList.add("is-visible");
  if (toastTimer) clearTimeout(toastTimer);
  const autoHide = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  if (autoHide) {
    toastTimer = setTimeout(() => {
      hideToast();
    }, duration);
  } else {
    toastTimer = null;
  }

  function hideToast() {
    toast.classList.remove("is-visible");
  }
}

function setMode(nextMode) {
  if (state.mode === nextMode) return;
  clearAllFilters({ resetSearch: false, silent: true, skipRouteUpdate: true, skipRender: true });
  state.mode = nextMode;
  closeAuthorOverlay();
  if (state.panelCache[nextMode]) {
    state.panelCache[nextMode].rendered = false;
    state.panelCache[nextMode].hash = null;
  }
  scheduleRouteUpdate();
  render();
}

function setSearch(nextSearch) {
  if (state.search === nextSearch) return;
  state.search = nextSearch;
  state.searchTokens = tokenizeSearch(nextSearch);
  state.expandedPublications.clear();
  Object.values(state.panelCache).forEach(cache => {
    cache.rendered = false;
    cache.hash = null;
  });
  elements.searchSpinner.hidden = false;
  scheduleRouteUpdate();
  render();
}

function handleSearchInput(event) {
  const value = event.target.value;
  if (searchTimer) clearTimeout(searchTimer);
  elements.searchSpinner.hidden = false;
  searchTimer = setTimeout(() => {
    setSearch(value);
  }, DEBOUNCE_MS);
}

function parseFiltersFromRoute(route) {
  const parseList = (value) =>
    (value || "")
      .split(",")
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(id => ({ id, label: id }));

  return {
    topics: parseList(route.topics),
    authors: parseList(route.authors),
    journals: parseList(route.journals),
  };
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

  const topicIndex = new Map();
  const authorIndex = new Map();
  const journalIndex = new Map();

  const allTopicIds = new Set();
  const publications = (pubsData.items || []).map(item => {
    const topics = (item.topics || []).map(raw => {
      const id = raw.id || normalize(raw.name || raw);
      const label = raw.label || raw.name || raw.id || raw;
      const top_level_id = raw.top_level_id || topLevelOf(id);
      if (id) allTopicIds.add(id);
      topicIndex.set(id, label);
      return { id, label, top_level_id };
    });
    const authors = (item.authors || []).map(a => {
      const key = a.id || normalize(a.name || "");
      if (a.local) authorIndex.set(key, a.name || key);
      return {
        ...a,
        _key: key,
        local: Boolean(a.local),
      };
    });
    const venueKey = item.venue_id || normalize(item.venue || item.venue_name || "");
    if (venueKey) journalIndex.set(venueKey, item.venue || item.venue_name || venueKey);

    const searchParts = [
      item.title || "",
      item.venue || item.venue_name || "",
      authors.map(a => a.name || "").join(" "),
      topics.map(t => t.label).join(" "),
    ].join(" ");

    const localAuthors = authors.filter(a => a.local).map(a => a._key);

    return {
      ...item,
      topics,
      authors,
      venue_key: venueKey,
      topic_ids: topics.map(t => t.id),
      local_author_keys: localAuthors,
      _search_norm: normalize(searchParts),
      search_blob: (item.search_blob || "").toString().toLowerCase(),
    };
  });

  const authors = (authorsData.items || []).map(item => {
    const authorTopics = Array.isArray(item.topics)
      ? item.topics
          .map(raw => {
            if (!raw) return null;
            const id = raw.id || normalize(raw.name || raw.label || raw);
            if (!id) return null;
            const label = raw.name || raw.label || raw.id || String(raw);
            const top_level_id = raw.top_level_id || topLevelOf(id);
            allTopicIds.add(id);
            const normalizedLabel = label;
            return {
              ...raw,
              id,
              label: normalizedLabel,
              name: raw.name || normalizedLabel,
              top_level_id,
            };
          })
          .filter(Boolean)
      : [];
    return {
      ...item,
      topics: authorTopics,
      search_blob: (item.search_blob || "").toString().toLowerCase(),
    };
  });

    // Build & keep a single color map
  const TOPIC_COLOR = buildTopicColorMapFromTopicIds([...allTopicIds]);

  const authorsById = new Map();
  authors.forEach(author => {
    if (author && author.id) authorsById.set(author.id, author);
  });

  dataCache = {
    publications,
    authors,
    authorsById,
    topicIndex,
    authorIndex,
    journalIndex,
    TOPIC_COLOR,
    colorForTopicId: id => resolveTopicColor(id, TOPIC_COLOR),
  };
  return dataCache;
}

export async function init({ mount, route = {}, navigate } = {}) {
  if (!mount) throw new Error("library.init requires { mount } DOM element");
  const view = mount.querySelector(".library-view");
  if (!view) throw new Error("library view markup missing .library-view container");

  elements = {
    root: view,
    searchInput: view.querySelector('[data-role="search"]'),
    searchClear: view.querySelector('[data-role="search-clear"]'),
    searchSpinner: view.querySelector('[data-role="search-spinner"]'),
    modeButtons: Array.from(view.querySelectorAll('[data-role="mode-btn"]')),
    results: view.querySelector("#library-results"),
    filterBar: view.querySelector('[data-role="filter-bar"]'),
    toast: null,
    overlay: view.querySelector('[data-role="author-overlay"]'),
    overlayContent: view.querySelector('[data-role="overlay-content"]'),
    overlayDismiss: Array.from(view.querySelectorAll('[data-role="overlay-dismiss"]')),
  };

  if (!elements.searchInput || elements.modeButtons.length !== 2 || !elements.results || !elements.filterBar) {
    throw new Error("library view markup incomplete");
  }
  if (!elements.overlay || !elements.overlayContent) {
    throw new Error("library author overlay markup missing");
  }

  elements.overlayDismiss.forEach(btn => {
    btn.addEventListener("click", () => closeAuthorOverlay());
  });

  navigateFn = typeof navigate === "function" ? navigate : null;

  const initialFilters = parseFiltersFromRoute(route);

  state = {
    mode: route.mode === "authors" ? "authors" : "publications",
    search: typeof route.q === "string" ? route.q : "",
    searchTokens: [],
    filters: {
      topics: initialFilters.topics,
      authors: initialFilters.authors,
      journals: initialFilters.journals,
    },
    sort: {
      publications: { ...SORT_DEFAULTS.publications },
      authors: { ...SORT_DEFAULTS.authors },
    },
    filterSequence: [],
    expandedPublications: new Set(),
    panelCache: {
      publications: { rendered: false, hash: null },
      authors: { rendered: false, hash: null },
    },
    pendingHighlights: [],
    recentlyAddedFilters: [],
    filterBarExpanded: false,
    lastRemovedFilter: null,
    activeOverlayAuthor: null,
  };

  FACETS.forEach(facet => {
    state.filters[facet] = dedupeArrayById(state.filters[facet]);
  });

  state.searchTokens = tokenizeSearch(state.search);
  state.filterSequence = FACETS.flatMap(facet =>
    state.filters[facet].map(entry => `${facet}|${entry.id}`)
  );
  state.sort[state.mode] = parseSortParam(state.mode, route.sort);

  elements.searchInput.value = state.search;
  const searchInputHandler = handleSearchInput;
  const searchKeyHandler = event => {
    if (event.key === "Backspace" && !event.target.value && state.filterSequence.length) {
      removeLastFilter();
      event.preventDefault();
    }
  };
  elements.searchInput.addEventListener("input", searchInputHandler);
  elements.searchInput.addEventListener("keydown", searchKeyHandler);
  state._searchHandlers = { searchInputHandler, searchKeyHandler };

  elements.searchClear.addEventListener("click", () => {
    elements.searchInput.value = "";
    setSearch("");
  });

  modeHandlers = [];
  elements.modeButtons.forEach(btn => {
    const handler = () => {
      const mode = btn.dataset.mode === "authors" ? "authors" : "publications";
      setMode(mode);
    };
    modeHandlers.push({ btn, handler });
    btn.addEventListener("click", handler);
  });

  createPanels();

  try {
    await loadData();
    ensureFilterLabels();
    render();
  } catch (err) {
    console.error(err);
    elements.results.innerHTML = `<div class="library-empty error">Failed to load library data.</div>`;
    elements.searchSpinner.hidden = true;
  }

  return function cleanup() {
    closeAuthorOverlay();
    if (searchTimer) clearTimeout(searchTimer);
    if (routeTimer) clearTimeout(routeTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (filterOverflowRaf) {
      cancelAnimationFrame(filterOverflowRaf);
      filterOverflowRaf = null;
    }
    if (fetchController) {
      try { fetchController.abort(); } catch (e) {}
    }
    if (elements) {
      if (state && state._searchHandlers) {
        elements.searchInput.removeEventListener("input", state._searchHandlers.searchInputHandler);
        elements.searchInput.removeEventListener("keydown", state._searchHandlers.searchKeyHandler);
      }
      if (modeHandlers) {
        modeHandlers.forEach(({ btn, handler }) => btn.removeEventListener("click", handler));
      }
    }
    if (state) state._searchHandlers = null;
    state = null;
    dataCache = null;
    elements = null;
    navigateFn = null;
  };
}

export function onRouteChange({ params = {}, navigate } = {}) {
  if (typeof navigate === "function") {
    navigateFn = navigate;
  }
  if (!state || !elements) return;

  state.mode = params.mode === "authors" ? "authors" : "publications";
  state.search = params.q || "";
  state.searchTokens = tokenizeSearch(state.search);
  state.filters = parseFiltersFromRoute(params);
  FACETS.forEach(facet => {
    state.filters[facet] = dedupeArrayById(state.filters[facet]);
  });
  state.filterSequence = FACETS.flatMap(facet =>
    state.filters[facet].map(entry => `${facet}|${entry.id}`)
  );
  state.sort[state.mode] = parseSortParam(state.mode, params.sort);
  if (state.expandedPublications && typeof state.expandedPublications.clear === "function") {
    state.expandedPublications.clear();
  }
  state.pendingHighlights = [];
  state.recentlyAddedFilters = [];
  state.filterBarExpanded = false;
  state.lastRemovedFilter = null;
  Object.values(state.panelCache).forEach(cache => {
    cache.rendered = false;
    cache.hash = null;
  });
  elements.searchInput.value = state.search;
  render();
}

export async function destroy() {
  return;
}
