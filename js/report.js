const d3 = window.d3;

const REPORT_CATALOG = [
  {
    id: "publications",
    label: "Publications",
    reports: [
      { id: "pubs_per_year", label: "Publications per year" },
      { id: "cites_per_year", label: "Citations per year" },
      { id: "cum_cites_per_year", label: "Cumulative citations per year" },
      { id: "top_venues", label: "Top venues" },
    ],
  },
  {
    id: "topics",
    label: "Topics",
    reports: [
      { id: "pubs_per_topic", label: "Publications per topic" },
      { id: "cites_per_topic", label: "Citations per topic" },
      { id: "topic_pubs_over_time", label: "Publications per topic over time" },
      { id: "topic_cum_cites_over_time", label: "Cumulative citations per topic" },
    ],
  },
];

let state = null;
let elements = null;
let reportsData = null;
let topicColorScale = null;
let navigateFn = null;

function escapeHTML(value) {
  return (value == null ? "" : String(value)).replace(/[&<>"]/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "0";
  return new Intl.NumberFormat().format(value);
}

function buildSelectOptions() {
  elements.select.innerHTML = "";
  REPORT_CATALOG.forEach(section => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = section.label;
    section.reports.forEach(rep => {
      const option = document.createElement("option");
      option.value = `${section.id}:${rep.id}`;
      option.textContent = rep.label;
      optgroup.appendChild(option);
    });
    elements.select.appendChild(optgroup);
  });
}

function setSelectValue(sectionId, reportId) {
  const value = `${sectionId}:${reportId}`;
  for (const option of elements.select.options) {
    if (option.value === value) {
      option.selected = true;
      return;
    }
  }
  elements.select.selectedIndex = 0;
}

function parseSelectValue() {
  const value = elements.select.value || "";
  const [sectionId, reportId] = value.split(":");
  return { sectionId, reportId };
}

function clearContainers() {
  elements.chart.innerHTML = "";
  elements.table.innerHTML = "";
  elements.legend.innerHTML = "";
  elements.meta.textContent = "";
  elements.options.innerHTML = "";
}

function renderTable(columns, rows, optionsKey) {
  const limitControl = createLimitControl(optionsKey, rows.length);
  if (limitControl) {
    const cap = Math.min(limitControl.limit, rows.length);
    rows = rows.slice(0, cap);
    if (limitControl.container) {
      elements.options.appendChild(limitControl.container);
    }
  }
  if (!rows.length) {
    elements.table.innerHTML = '<div class="report-empty">No rows.</div>';
    return;
  }
  const thead = columns.map(col => `<th scope="col">${escapeHTML(col.label)}</th>`).join("");
  const tbody = rows.map((row, rowIndex) => {
    const cells = columns.map(col => {
      const value = typeof col.value === "function" ? col.value(row, rowIndex) : row[col.key];
      const display = col.format ? col.format(value, row) : value;
      const className = col.numeric ? "numeric" : "";
      return `<td class="${className}">${escapeHTML(display != null ? String(display) : "")}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  elements.table.innerHTML = `
    <table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  `;
}

function createLimitControl(optionsKey, totalRows) {
  const LIMITS = [20, 50, Infinity];
  const LABELS = ["Top 20", "Top 50", "All"];
  if (!state.tableOptions) state.tableOptions = {};
  const entry = state.tableOptions[optionsKey] || { index: 0 };
  state.tableOptions[optionsKey] = entry;

  if (totalRows <= LIMITS[0]) {
    entry.index = 2;
    return null;
  }

  const select = document.createElement("select");
  select.className = "report-limit";
  LIMITS.forEach((limit, idx) => {
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = LABELS[idx];
    select.appendChild(option);
  });
  if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= LIMITS.length) {
    entry.index = 0;
  }
  select.value = String(entry.index);
  select.addEventListener("change", () => {
    entry.index = Number(select.value);
    renderCurrent();
  });

  const wrapper = document.createElement("label");
  wrapper.className = "report-limit-label";
  wrapper.textContent = "Rows:";
  wrapper.appendChild(select);

  const selectedIdx = Number.isInteger(entry.index) ? entry.index : 0;
  const limitValue = LIMITS[selectedIdx] === Infinity ? totalRows : LIMITS[selectedIdx];
  return { limit: limitValue, container: wrapper };
}

function createSVG(container, { height = 320, margin = { top: 24, right: 24, bottom: 48, left: 64 } } = {}) {
  const width = Math.max(container.clientWidth || 720, 480);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const svg = d3
    .select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", "100%");
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  return { svg, g, width, height, innerWidth, innerHeight, margin };
}

function renderVerticalBarChart(container, data, { xAccessor, yAccessor, xLabel, yLabel, rotateLabels = false, tooltip } ) {
  const chart = createSVG(container);
  const x = d3
    .scaleBand()
    .domain(data.map(xAccessor))
    .range([0, chart.innerWidth])
    .padding(0.2);
  const maxY = d3.max(data, yAccessor) || 0;
  const y = d3.scaleLinear().domain([0, maxY]).nice().range([chart.innerHeight, 0]);

  const axisX = chart.g
    .append("g")
    .attr("transform", `translate(0,${chart.innerHeight})`)
    .call(d3.axisBottom(x).tickSizeOuter(0));
  if (rotateLabels) {
    axisX
      .selectAll("text")
      .attr("text-anchor", "end")
      .attr("transform", "rotate(-40)")
      .attr("dx", "-0.6em")
      .attr("dy", "0.45em");
  }

  chart.g
    .append("g")
    .call(d3.axisLeft(y).ticks(6).tickSize(-chart.innerWidth))
    .call(g => g.selectAll(".tick line").attr("stroke", "#e2e8f0"))
    .call(g => g.select(".domain").remove());

  const bars = chart.g
    .append("g")
    .attr("fill", "#2563eb")
    .selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", d => x(xAccessor(d)))
    .attr("y", d => y(yAccessor(d)))
    .attr("width", x.bandwidth())
    .attr("height", d => chart.innerHeight - y(yAccessor(d)));

  if (typeof tooltip === "function") {
    bars.append("title").text(d => tooltip(d));
  }

  chart.g
    .append("text")
    .attr("x", chart.innerWidth / 2)
    .attr("y", chart.innerHeight + chart.margin.bottom - 10)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--muted)")
    .text(xLabel);

  chart.g
    .append("text")
    .attr("x", -chart.margin.left + 8)
    .attr("y", -12)
    .attr("fill", "var(--muted)")
    .text(yLabel);
}

function renderHorizontalBarChart(container, data, { yAccessor, xAccessor, xLabel, tooltip, onBarClick }) {
  const barHeight = 28;
  const height = Math.max(data.length * barHeight + 60, 220);
  const chart = createSVG(container, { height, margin: { top: 16, right: 24, bottom: 40, left: 180 } });

  const y = d3
    .scaleBand()
    .domain(data.map(yAccessor))
    .range([0, chart.innerHeight])
    .padding(0.2);

  const maxX = d3.max(data, xAccessor) || 0;
  const x = d3.scaleLinear().domain([0, maxX]).nice().range([0, chart.innerWidth]);

  chart.g
    .append("g")
    .call(d3.axisLeft(y).tickSizeOuter(0))
    .call(g => g.select(".domain").remove());

  chart.g
    .append("g")
    .attr("transform", `translate(0,${chart.innerHeight})`)
    .call(d3.axisBottom(x).ticks(6).tickSize(-chart.innerHeight))
    .call(g => g.selectAll(".tick line").attr("stroke", "#e2e8f0"))
    .call(g => g.select(".domain").remove());

  const bars = chart.g
    .append("g")
    .attr("fill", "#2563eb")
    .selectAll("rect")
    .data(data)
    .join("rect")
    .attr("y", d => y(yAccessor(d)))
    .attr("height", y.bandwidth())
    .attr("x", 0)
    .attr("width", d => x(xAccessor(d)))
    .style("cursor", onBarClick ? "pointer" : "default");

  if (typeof tooltip === "function") {
    bars.append("title").text(d => tooltip(d));
  }
  if (typeof onBarClick === "function") {
    bars.on("click", (_, d) => onBarClick(d));
  }

  chart.g
    .append("text")
    .attr("x", chart.innerWidth)
    .attr("y", chart.innerHeight + chart.margin.bottom - 10)
    .attr("text-anchor", "end")
    .attr("fill", "var(--muted)")
    .text(xLabel);
}

function renderLineSeries(container, options) {
  const {
    seriesList,
    years,
    valueKey,
    colorScale,
    legendEl,
    visibility,
    onToggle,
  } = options;

  if (!seriesList.length || !years.length) {
    container.innerHTML = '<div class="report-empty">No data available.</div>';
    if (legendEl) legendEl.innerHTML = "";
    return;
  }

  container.innerHTML = "";
  if (legendEl) legendEl.innerHTML = "";

  const margin = { top: 24, right: 32, bottom: 48, left: 64 };
  const chart = createSVG(container, { height: 360, margin });
  const minYear = d3.min(years) || 0;
  const maxYear = d3.max(years) || 0;

  const x = d3.scaleLinear().domain([minYear, maxYear]).range([0, chart.innerWidth]);
  const yMax = d3.max(seriesList, series => d3.max(series.values, v => v[valueKey])) || 0;
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([chart.innerHeight, 0]);

  chart.g
    .append("g")
    .attr("transform", `translate(0,${chart.innerHeight})`)
    .call(d3.axisBottom(x).ticks(Math.min(10, years.length)).tickFormat(d3.format("d")));

  chart.g
    .append("g")
    .call(d3.axisLeft(y).ticks(6).tickSize(-chart.innerWidth))
    .call(g => g.selectAll(".tick line").attr("stroke", "#e2e8f0"))
    .call(g => g.select(".domain").remove());

  const line = d3
    .line()
    .x(d => x(d.year))
    .y(d => y(d[valueKey]))
    .curve(d3.curveMonotoneX);

  const seriesGroup = chart.g.append("g");
  const activeIds = visibility && visibility.size > 0 ? visibility : null;

  const seriesPaths = seriesGroup
    .selectAll("path")
    .data(seriesList, d => d.topic_id || d.id)
    .join("path")
    .attr("fill", "none")
    .attr("stroke-width", 2.4)
    .attr("stroke", d => colorScale(d.topic_id || d.id))
    .attr("opacity", d => (activeIds && !activeIds.has(d.topic_id || d.id) ? 0.2 : 1))
    .attr("d", d => line(d.values));

  const focusLine = chart.g.append("line").attr("stroke", "#94a3b8").attr("stroke-dasharray", "4 4").style("opacity", 0);
  const focusDots = chart.g
    .append("g")
    .selectAll("circle")
    .data(seriesList, d => d.topic_id || d.id)
    .join("circle")
    .attr("r", 4)
    .attr("fill", d => colorScale(d.topic_id || d.id))
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("opacity", 0);

  const tooltip = ensureTooltip();

  const overlay = chart.g
    .append("rect")
    .attr("fill", "transparent")
    .attr("pointer-events", "all")
    .attr("width", chart.innerWidth)
    .attr("height", chart.innerHeight)
    .on("mousemove", onPointerMove)
    .on("mouseleave", onPointerLeave);

  function onPointerMove(event) {
    const [mx] = d3.pointer(event);
    const year = Math.round(x.invert(mx));
    if (year < minYear || year > maxYear) {
      onPointerLeave();
      return;
    }
    const px = x(year);
    focusLine
      .attr("x1", px)
      .attr("x2", px)
      .attr("y1", 0)
      .attr("y2", chart.innerHeight)
      .style("opacity", 0.5);

    const rows = [];
    focusDots.each(function(series) {
      const point = series.valueMap.get(year);
      const id = series.topic_id || series.id;
      const active = !activeIds || activeIds.has(id);
      d3.select(this)
        .style("opacity", point && active ? 1 : 0)
        .attr("cx", px)
        .attr("cy", point ? y(point[valueKey]) : 0);
      if (point && active) {
        rows.push({
          label: series.topic || series.label || id,
          value: point[valueKey],
          color: colorScale(id),
        });
      }
    });

    if (!rows.length) {
      tooltip.style.opacity = 0;
      return;
    }

    const content = [`<strong>${year}</strong>`].concat(
      rows.map(r => `<span class="dot" style="background:${r.color}"></span>${escapeHTML(r.label)}: ${formatNumber(r.value)}`)
    ).join("<br>");
    tooltip.innerHTML = content;
    const rect = container.getBoundingClientRect();
    tooltip.style.opacity = 1;
    tooltip.style.left = `${rect.left + window.scrollX + px + chart.margin.left}px`;
    tooltip.style.top = `${rect.top + window.scrollY + chart.margin.top + 12}px`;
  }

  function onPointerLeave() {
    focusLine.style("opacity", 0);
    focusDots.style("opacity", 0);
    tooltip.style.opacity = 0;
  }

  if (legendEl) {
    legendEl.innerHTML = "";
    seriesList.forEach(series => {
      const id = series.topic_id || series.id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = activeIds && !activeIds.has(id) ? "is-muted" : "";
      btn.innerHTML = `<span class="dot" style="background:${colorScale(id)}"></span>${escapeHTML(series.topic || series.label || id)}`;
      btn.addEventListener("click", () => {
        if (typeof onToggle === "function") {
          onToggle(id);
        }
      });
      legendEl.appendChild(btn);
    });
  }

  if (metaText) {
    elements.meta.innerHTML = metaText;
  }
}

function ensureTooltip() {
  if (!elements.tooltip) {
    const tooltip = document.createElement("div");
    tooltip.className = "report-tooltip";
    document.body.appendChild(tooltip);
    elements.tooltip = tooltip;
  }
  return elements.tooltip;
}

function renderPublicationsPerYear() {
  const rows = reportsData.publications.years || [];
  elements.title.textContent = "Publications per year";
  clearContainers();
  renderVerticalBarChart(elements.chart, rows, {
    xAccessor: d => d.year,
    yAccessor: d => d.pubs,
    xLabel: "Year",
    yLabel: "Publications",
    tooltip: d => `${d.year} — ${d.pubs} publications`,
  });
  renderTable(
    [
      { label: "Year", key: "year" },
      { label: "Publications", key: "pubs", format: formatNumber, numeric: true },
      { label: "Citations", key: "citations", format: formatNumber, numeric: true },
      { label: "Cumulative citations", key: "cum_citations", format: formatNumber, numeric: true },
    ],
    reportsData.publications.years || [],
    "pubs_per_year_table"
  );
}

function renderCitationsPerYear() {
  const rows = reportsData.publications.years || [];
  elements.title.textContent = "Citations per year";
  clearContainers();
  renderVerticalBarChart(elements.chart, rows, {
    xAccessor: d => d.year,
    yAccessor: d => d.citations,
    xLabel: "Year",
    yLabel: "Citations",
    tooltip: d => `${d.year} — Σ citations: ${formatNumber(d.citations)}`,
  });
  renderTable(
    [
      { label: "Year", key: "year" },
      { label: "Publications", key: "pubs", format: formatNumber, numeric: true },
      { label: "Citations", key: "citations", format: formatNumber, numeric: true },
      { label: "Cumulative citations", key: "cum_citations", format: formatNumber, numeric: true },
    ],
    reportsData.publications.years || [],
    "cites_per_year_table"
  );
}

function renderCumulativeCitationsPerYear() {
  const rows = reportsData.publications.years || [];
  elements.title.textContent = "Cumulative citations per year";
  clearContainers();
  const series = [
    {
      id: "total_citations",
      label: "Cumulative citations",
      values: rows.map(d => ({ year: d.year, value: d.cum_citations })),
      valueMap: new Map(rows.map(d => [d.year, { value: d.cum_citations }])),
    },
  ];
  renderLineSeries(elements.chart, {
    seriesList: series.map(s => ({ ...s, values: s.values.map(v => ({ year: v.year, value: v.value })) })),
    years: rows.map(d => d.year),
    valueKey: "value",
    colorScale: d3.scaleOrdinal().domain(["total_citations"]).range(["#2563eb"]),
    legendEl: elements.legend,
    visibility: new Set(["total_citations"]),
  });
  elements.meta.textContent = `Total citations: ${formatNumber(reportsData.publications.total_citations || 0)}`;
  renderTable(
    [
      { label: "Year", key: "year" },
      { label: "Publications", key: "pubs", format: formatNumber, numeric: true },
      { label: "Citations", key: "citations", format: formatNumber, numeric: true },
      { label: "Cumulative citations", key: "cum_citations", format: formatNumber, numeric: true },
    ],
    reportsData.publications.years || [],
    "cum_cites_per_year_table"
  );
}

function renderTopVenues() {
  const rows = reportsData.publications.venues || [];
  elements.title.textContent = "Top venues";
  clearContainers();
  const chartRows = rows.slice(0, 10);
  renderHorizontalBarChart(elements.chart, chartRows, {
    yAccessor: d => d.venue_name,
    xAccessor: d => d.pubs,
    xLabel: "Publications",
    tooltip: d => `${escapeHTML(d.venue_name)} — ${d.pubs} publications`,
  });
  renderTable(
    [
      { label: "#", value: (_, idx) => String(idx + 1), numeric: true },
      { label: "Venue", key: "venue_name" },
      { label: "Publications", key: "pubs", format: formatNumber, numeric: true },
    ],
    rows,
    "top_venues_table"
  );
}

function getTopicOption(key) {
  if (!state.viewOptions[key]) {
    state.viewOptions[key] = {};
  }
  return state.viewOptions[key];
}

function renderTopicBars(metricKey, label, optionsKey, onBarClick) {
  const topics = reportsData.topics.topics || [];
  elements.title.textContent = label;
  clearContainers();
  elements.meta.textContent = onBarClick ? "Click a bar to open the Library with the selected topic." : "";

  const opts = getTopicOption(optionsKey);
  const limit = opts.showAll ? topics.length : 20;
  const slice = topics.slice(0, limit);

  renderHorizontalBarChart(elements.chart, slice, {
    yAccessor: d => d.topic,
    xAccessor: d => d[metricKey],
    xLabel: metricKey === "pubs_total" ? "Publications" : "Citations",
    tooltip: d => `${escapeHTML(d.topic)} — ${formatNumber(d[metricKey])}`,
    onBarClick,
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "report-link";
  toggle.textContent = opts.showAll ? "Show top 20" : "Show all";
  toggle.addEventListener("click", () => {
    opts.showAll = !opts.showAll;
    renderCurrent();
  });
  elements.options.appendChild(toggle);

  renderTable(
    [
      { label: "#", value: (_, idx) => String(idx + 1), numeric: true },
      { label: "Topic", key: "topic" },
      { label: metricKey === "pubs_total" ? "Publications" : "Citations", key: metricKey, format: formatNumber, numeric: true },
      { label: "Total citations", key: "cites_total", format: formatNumber, numeric: true },
    ],
    topics,
    `${optionsKey}_table`
  );
}

function renderTopicPublications() {
  renderTopicBars("pubs_total", "Publications per topic", "pubs_per_topic", topic => {
    if (window._rv && typeof window._rv.setRoute === "function") {
      window._rv.setRoute("library", { q: topic.topic });
    }
  });
}

function renderTopicCitations() {
  renderTopicBars("cites_total", "Citations per topic", "cites_per_topic", topic => {
    if (window._rv && typeof window._rv.setRoute === "function") {
      window._rv.setRoute("library", { q: topic.topic });
    }
  });
}

function buildTopicSeries(valueKey) {
  const topics = reportsData.topics.topics || [];
  const years = reportsData.topics.years || [];
  return topics.map(topic => {
    const values = topic.series.map(point => ({
      year: point.year,
      value: point[valueKey],
    }));
    const map = new Map(values.map(v => [v.year, v]));
    // ensure every year present
    years.forEach(year => {
      if (!map.has(year)) {
        const zero = { year, value: 0 };
        values.push(zero);
        map.set(year, zero);
      }
    });
    values.sort((a, b) => a.year - b.year);
    return {
      topic_id: topic.topic_id,
      topic: topic.topic,
      values,
      valueMap: map,
      pubs_total: topic.pubs_total,
      cites_total: topic.cites_total,
    };
  });
}

function renderTopicSeries(valueKey, title, optionsKey, extraOptions = {}) {
  const years = reportsData.topics.years || [];
  if (!years.length) {
    elements.title.textContent = title;
    clearContainers();
    elements.chart.innerHTML = '<div class="report-empty">No data available.</div>';
    return;
  }

  const seriesList = buildTopicSeries(valueKey);
  const opts = getTopicOption(optionsKey);
  if (extraOptions.allowNormalize && typeof opts.normalize !== "boolean") {
    opts.normalize = false;
  }
  if (!opts.visible || opts.visible.size === 0) {
    const defaults = seriesList.slice(0, 6).map(s => s.topic_id);
    opts.visible = new Set(defaults);
  }
  const updateVisibility = (id) => {
    if (!opts.visible) opts.visible = new Set();
    if (opts.visible.has(id) && opts.visible.size > 1) {
      opts.visible.delete(id);
    } else {
      opts.visible.add(id);
    }
    renderCurrent();
  };

  clearContainers();
  elements.title.textContent = title;
  elements.meta.textContent = extraOptions.allowNormalize
    ? "Use legend items to toggle topics. Enable normalization to compare relative growth."
    : "Use legend items to toggle topics.";

  let preparedSeries = seriesList;
  if (extraOptions.normalize) {
    preparedSeries = seriesList.map(series => {
      const first = series.values.find(v => v.year === years[0]);
      const offset = opts.normalize ? (first ? first.value : 0) : 0;
      const values = series.values.map(v => ({ year: v.year, value: v.value - offset }));
      const map = new Map(values.map(v => [v.year, { year: v.year, value: v.value }]));
      return {
        ...series,
        values,
        valueMap: map,
      };
    });
  } else {
    preparedSeries = seriesList.map(series => ({
      ...series,
      values: series.values.map(v => ({ year: v.year, value: v.value })),
    }));
  }

  renderLineSeries(elements.chart, {
    seriesList: preparedSeries,
    years,
    valueKey: "value",
    colorScale: topicColorScale,
    legendEl: elements.legend,
    visibility: opts.visible,
    onToggle: updateVisibility,
  });

  if (extraOptions.allowNormalize) {
    const label = document.createElement("label");
    label.className = "report-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(opts.normalize);
    checkbox.addEventListener("change", () => {
      opts.normalize = checkbox.checked;
      renderCurrent();
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" Normalize to first year"));
    elements.options.appendChild(label);
  }

  renderTable(
    [
      { label: "Topic", key: "topic" },
      { label: "Publications", key: "pubs_total", format: formatNumber, numeric: true },
      { label: "Citations", key: "cites_total", format: formatNumber, numeric: true },
    ],
    seriesList,
    `${optionsKey}_table`
  );
}

function renderTopicPublicationsOverTime() {
  renderTopicSeries("pubs", "Publications per topic over time", "topic_pubs_over_time");
}

function renderTopicCumulativeCitationsOverTime() {
  renderTopicSeries("cum_citations", "Cumulative citations per topic", "topic_cum_cites_over_time", {
    allowNormalize: true,
    normalize: true,
  });
}

const REPORT_HANDLERS = {
  "publications:pubs_per_year": renderPublicationsPerYear,
  "publications:cites_per_year": renderCitationsPerYear,
  "publications:cum_cites_per_year": renderCumulativeCitationsPerYear,
  "publications:top_venues": renderTopVenues,
  "topics:pubs_per_topic": renderTopicPublications,
  "topics:cites_per_topic": renderTopicCitations,
  "topics:topic_pubs_over_time": renderTopicPublicationsOverTime,
  "topics:topic_cum_cites_over_time": renderTopicCumulativeCitationsOverTime,
};

function renderCurrent() {
  if (!state) return;
  const key = `${state.sectionId}:${state.reportId}`;
  const handler = REPORT_HANDLERS[key];
  if (handler) {
    handler();
  } else {
    clearContainers();
    elements.title.textContent = "Report";
    elements.meta.textContent = "Report not available.";
  }
}

function handleShow() {
  const { sectionId, reportId } = parseSelectValue();
  state.sectionId = sectionId || REPORT_CATALOG[0].id;
  state.reportId = reportId || REPORT_CATALOG[0].reports[0].id;
  if (navigateFn) {
    navigateFn({ section: state.sectionId, report: state.reportId });
  }
  renderCurrent();
}

function updateFromRoute(params) {
  const sectionEntry = REPORT_CATALOG.find(s => s.id === params.section) || REPORT_CATALOG[0];
  const reportEntry = sectionEntry.reports.find(r => r.id === params.report) || sectionEntry.reports[0];
  state.sectionId = sectionEntry.id;
  state.reportId = reportEntry.id;
  setSelectValue(sectionEntry.id, reportEntry.id);
  renderCurrent();
}

export async function init({ mount, route = {}, navigate } = {}) {
  if (!mount) throw new Error("report.init requires { mount } DOM element");
  const root = mount.querySelector(".report-view");
  if (!root) throw new Error("report view markup missing .report-view container");

  elements = {
    root,
    select: root.querySelector('[data-role="report-select"]'),
    showButton: root.querySelector('[data-role="report-show"]'),
    chart: root.querySelector('[data-role="report-chart"]'),
    table: root.querySelector('[data-role="report-table"]'),
    legend: root.querySelector('[data-role="report-legend"]'),
    options: root.querySelector('[data-role="report-options"]'),
    meta: root.querySelector('[data-role="report-meta"]'),
    title: root.querySelector('[data-role="report-title"]'),
  };

  if (!elements.select || !elements.showButton || !elements.chart || !elements.table) {
    throw new Error("report view markup incomplete");
  }

  navigateFn = function(update) {
    if (typeof navigate === "function") {
      navigate(update);
    }
  };

  buildSelectOptions();

  state = {
    sectionId: route.section || REPORT_CATALOG[0].id,
    reportId: route.report || REPORT_CATALOG[0].reports[0].id,
    viewOptions: {},
    tableOptions: {},
  };

  setSelectValue(state.sectionId, state.reportId);

  elements.showButton.addEventListener("click", handleShow);

  try {
    const response = await fetch("data/reports.json");
    if (!response.ok) throw new Error(`Failed to load reports.json (${response.status})`);
    reportsData = await response.json();
    const topicIds = (reportsData.topics?.topics || []).map(t => t.topic_id);
    topicColorScale = d3.scaleOrdinal(d3.schemeTableau10).domain(topicIds);
    updateFromRoute(route);
  } catch (err) {
    console.error(err);
    elements.chart.innerHTML = `<div class=\"report-empty error\">Failed to load report data.</div>`;
  }

  return function cleanup() {
    elements.showButton.removeEventListener("click", handleShow);
    elements = null;
    state = null;
    navigateFn = null;
  };
}

export function onRouteChange({ params = {}, navigate } = {}) {
  if (typeof navigate === "function") {
    navigateFn = navigate;
  }
  if (!state || !elements) return;
  updateFromRoute(params);
}

export async function destroy() {
  return;
}
