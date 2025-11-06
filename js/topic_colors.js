// topic_colors.js

const DEFAULT_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

const DEFAULT_COLOR = "#94a3b8";

function globalD3() {
  if (typeof window !== "undefined" && window.d3) return window.d3;
  if (typeof globalThis !== "undefined" && globalThis.d3) return globalThis.d3;
  return null;
}

function normalizeColor(value, fallback) {
  if (!value) return fallback;
  const str = String(value).trim();
  if (!str) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(str)) return str.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(str)) {
    return (
      "#" +
      str[1] + str[1] +
      str[2] + str[2] +
      str[3] + str[3]
    ).toLowerCase();
  }
  const rgbMatch = str.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgbMatch) {
    const toHex = (num) => {
      const clamped = Math.max(0, Math.min(255, Number(num) || 0));
      return clamped.toString(16).padStart(2, "0");
    };
    return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
  }
  return str;
}

function generatePalette(count) {
  const d3 = globalD3();
  const base = Array.isArray(d3?.schemeTableau10) && d3.schemeTableau10.length
    ? d3.schemeTableau10
    : DEFAULT_PALETTE;

  if (count <= base.length) {
    return base.slice(0, count);
  }

  if (d3?.interpolateRainbow) {
    return Array.from({ length: count }, (_, i) => d3.interpolateRainbow(i / count));
  }

  // Fallback: simple HSL wheel
  return Array.from({ length: count }, (_, i) => {
    const h = Math.round((360 * i) / count);
    return `hsl(${h} 65% 55%)`;
  });
}

/** "A.1" -> "A" ; "B.3.c" -> "B" */
export function topLevelOf(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  const i = s.indexOf(".");
  return i === -1 ? s : s.slice(0, i);
}

/** Build a stable color map for top-level IDs from any list of topic IDs */
export function buildTopicColorMapFromTopicIds(topicIds = []) {
  const tops = Array.from(new Set(topicIds.map(topLevelOf).filter(Boolean))).sort();
  if (!tops.length) return Object.freeze({});

  const palette = generatePalette(tops.length);
  const map = {};
  tops.forEach((top, index) => {
    const rawColor = palette[index] ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? DEFAULT_COLOR;
    map[top] = normalizeColor(rawColor, DEFAULT_COLOR);
  });
  return Object.freeze(map);
}

/** Any topic id -> color of its top-level */
export function colorForTopicId(id, colorMap, fallback = DEFAULT_COLOR) {
  const top = topLevelOf(id);
  if (!top || !colorMap) return fallback;
  return colorMap[top] || fallback;
}
