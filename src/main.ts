/**
 * angl3r — Michigan Fishing Regulations
 * Main app entry point.
 *
 * Loads the static data, sets up the search box, and renders results
 * + detail panel. All DOM manipulation is via innerHTML for simplicity
 * (this is a static site, no XSS surface — all data is from a known PDF
 * parsed at build time).
 */

import "./styles.css";
import type { RegsData } from "./types";
import { LAKE_TYPE_TITLES, STREAM_TYPE_TITLES } from "./types";
import { search, groupByCounty, findExact, type Result } from "./search";

// Vite rewrites these imports to fingerprinted URLs in the build, with the
// correct base path. We use them as both <img src> and CSS url().
import faviconUrl from "../public/logo.png";
import brandLogoUrl from "../public/logo.png";
// The county map SVG is loaded as a raw string so we can inline it into
// the DOM and attach click handlers to each <path>. Using ?raw tells Vite
// to ship the file contents as a string instead of as a fingerprinted URL.
import miCountiesSvg from "../public/mi-counties.svg?raw";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// Data is fetched at runtime so regs.json doesn't get inlined into the
// bundle (it's ~460KB). The JSON lives at public/data/regs.json and is
// served as a static asset on GitHub Pages.
let DATA: RegsData | null = null;
let DATA_PROMISE: Promise<RegsData> | null = null;

async function loadData(): Promise<RegsData> {
  if (DATA) return DATA;
  if (DATA_PROMISE) return DATA_PROMISE;
  // Compute the base URL the same way Vite did at build time. This means
  // the site works under any subpath (e.g. /angler/) on GitHub Pages.
  const base = import.meta.env.BASE_URL || "/";
  DATA_PROMISE = fetch(`${base}data/regs.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch regs.json: ${r.status}`);
      return r.json();
    })
    .then((json) => {
      DATA = json as RegsData;
      return DATA;
    });
  return DATA_PROMISE;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function highlight(text: string, query: string): string {
  if (!query) return esc(text);
  // Case-insensitive highlight. Escape HTML first, then wrap matches.
  const escaped = esc(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // regex-escape
  return escaped.replace(new RegExp(`(${q})`, "gi"), "<mark>$1</mark>");
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let selectedResult: Result | null = null;
let currentQuery = "";
let currentView: "search" | "map" = "search";
let currentSpecies: string | null = null;  // null = "All species"
let currentCountyFilter: string | null = null;  // when set, results are scoped to this county

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

function renderHeader(activeView: "search" | "map" = "search"): string {
  return `
    <header class="header">
      <div class="header__inner">
        <div class="header__brand">
          <img src="${brandLogoUrl}" alt="angl3r" class="header__logo" />
          <span class="header__name">angl3r</span>
        </div>
        <nav class="header__nav" role="tablist">
          <button
            class="header__nav-btn ${activeView === "search" ? "is-active" : ""}"
            role="tab"
            id="tab-search"
            data-view="search"
            aria-selected="${activeView === "search"}"
            aria-controls="view-container"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <span>Search</span>
          </button>
          <button
            class="header__nav-btn ${activeView === "map" ? "is-active" : ""}"
            role="tab"
            id="tab-map"
            data-view="map"
            aria-selected="${activeView === "map"}"
            aria-controls="view-container"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span>Counties</span>
          </button>
        </nav>
        <a class="header__link" href="https://github.com/tsteinke11306/angl3r" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.8 1.7 2.6 1.2.1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/>
          </svg>
          <span>GitHub</span>
        </a>
      </div>
    </header>
  `;
}

function renderStats(data: RegsData): string {
  const wbCount = data.meta.waterbody_count ?? data.waterbodies?.length ?? 0;
  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card__icon stat-card__icon--lake">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 18c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>
            <path d="M3 13c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>
          </svg>
        </div>
        <div class="stat-card__body">
          <div class="stat-card__num">${data.meta.lake_count}</div>
          <div class="stat-card__label">Trout/salmon lakes</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__icon stat-card__icon--stream">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 12c3-2 5-2 8 0s5 2 8 0 4-2 4-2"/>
            <path d="M2 18c3-2 5-2 8 0s5 2 8 0 4-2 4-2"/>
            <path d="M2 6c3-2 5-2 8 0s5 2 8 0 4-2 4-2"/>
          </svg>
        </div>
        <div class="stat-card__body">
          <div class="stat-card__num">${data.meta.stream_count}</div>
          <div class="stat-card__label">Trout/salmon streams</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__icon stat-card__icon--total">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 22V2l12 4v16"/>
            <path d="M6 12h12"/>
          </svg>
        </div>
        <div class="stat-card__body">
          <div class="stat-card__num">${wbCount.toLocaleString()}</div>
          <div class="stat-card__label">Total waterbodies</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-card__icon stat-card__icon--county">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </div>
        <div class="stat-card__body">
          <div class="stat-card__num">${data.meta.county_count}</div>
          <div class="stat-card__label">Counties covered</div>
        </div>
      </div>
    </div>
  `;
}

function renderSearchBox(): string {
  return `
    <div class="search">
      <svg class="search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.3-4.3"/>
      </svg>
      <input
        type="search"
        id="search-input"
        class="search__input"
        placeholder="Search lakes, streams, or counties…"
        autocomplete="off"
        autofocus
      />
    </div>
  `;
}


/**
 * Render the species filter chips. Each species is a button that, when
 * clicked, filters the results to show only waterbodies where that species
 * is found (for now, this means: show all waterbodies in counties that
 * have species-specific regulations for this species).
 *
 * "All species" is the default (no filter).
 */
function renderSpeciesFilter(data: RegsData, selected: string | null): string {
  const species = data.species?.statewide ?? [];
  return `
    <div class="species-filter-wrapper">
      <div class="species-filter-label">Filter by species</div>
      <div class="species-filter" role="group" aria-label="Filter by species">
        <button
          class="species-chip ${selected === null ? "species-chip--active" : ""}"
          data-species-id="__all"
        >
          All species
        </button>
        ${species
          .map(
            (sp) => `
        <button
          class="species-chip ${selected === sp.id ? "species-chip--active" : ""}"
          data-species-id="${esc(sp.id)}"
          title="${esc(sp.name)}"
        >
          ${esc(sp.name.replace(/\s*\(.*?\)\s*/g, ""))}
        </button>
      `
          )
          .join("")}
      </div>
    </div>
  `;
}

/**
 * Precompute county-level data for the map: waterbody counts, type codes,
 * species lists, and exception status. This runs once when the map view
 * is first rendered and is reused for tooltips, choropleth coloring, and
 * the county summary panel.
 */

interface CountyMapData {
  waterbodyCount: number;
  lakeCount: number;
  streamCount: number;
  hasExceptions: boolean;
  typeCodes: string[];
  waterbodies: { name: string; kind: string; type?: string; source: string }[];
  speciesSet: string[];
}

let countyMapDataCache: Map<string, CountyMapData> | null = null;

function getCountyMapData(data: RegsData): Map<string, CountyMapData> {
  if (countyMapDataCache) return countyMapDataCache;
  const map = new Map<string, CountyMapData>();
  const stats = data.counties?.stats ?? {};

  // Initialize from county stats
  for (const [county, s] of Object.entries(stats)) {
    map.set(county, {
      waterbodyCount: s.waterbodies ?? 0,
      lakeCount: 0,  // recomputed from waterbodies below
      streamCount: 0, // recomputed from waterbodies below
      hasExceptions: s.has_exceptions ?? false,
      typeCodes: [],
      waterbodies: [],
      speciesSet: [],
    });
  }

  // Aggregate waterbody details - count actual lakes/streams from the
  // unified waterbodies array (includes both PDF and Wikipedia sources).
  for (const wb of data.waterbodies ?? []) {
    const entry = map.get(wb.county);
    if (!entry) continue;
    entry.waterbodies.push({
      name: wb.name,
      kind: wb.kind,
      type: wb.type,
      source: wb.source,
    });
    // Count by kind: lakes, rivers/streams/creeks count as "streams"
    if (wb.kind === "lake" || wb.kind === "pond") {
      entry.lakeCount++;
    } else if (wb.kind === "river" || wb.kind === "stream" || wb.kind === "creek" || wb.kind === "channel") {
      entry.streamCount++;
    }
    if (wb.type && wb.source === "pdf") {
      if (!entry.typeCodes.includes(wb.type)) {
        entry.typeCodes.push(wb.type);
      }
    }
  }

  // Aggregate species from survey data
  const sbw = data.species_by_waterbody ?? {};
  for (const [county, wbs] of Object.entries(sbw)) {
    const entry = map.get(county);
    if (!entry) continue;
    const speciesSet = new Set<string>();
    for (const wbData of Object.values(wbs)) {
      for (const sp of wbData.species ?? []) {
        speciesSet.add(sp);
      }
    }
    entry.speciesSet = Array.from(speciesSet).sort();
  }

  countyMapDataCache = map;
  return map;
}

/** Compute choropleth fill color based on waterbody count (0 to maxCount). */
function choroplethFill(count: number, maxCount: number): string {
  if (maxCount === 0 || count === 0) return "#d4e0ed";
  const t = Math.min(1, count / maxCount);
  // Interpolate from light blue (#cfe0f0) to deep blue (#1a5a9e)
  const r = Math.round(207 + t * (26 - 207));
  const g = Math.round(224 + t * (90 - 224));
  const b = Math.round(240 + t * (158 - 240));
  return `rgb(${r},${g},${b})`;
}

/**
 * Build the map view: an inline SVG of Michigan counties with choropleth
 * coloring by waterbody density, county labels, and rich data attributes.
 */
function renderMapView(data: RegsData): string {
  const countyData = getCountyMapData(data);
  const allCounties = data.counties?.order ?? Array.from(countyData.keys());
  const maxWB = Math.max(...Array.from(countyData.values()).map((d) => d.waterbodyCount), 1);

  // Count summary stats for the map stats bar
  const totalWithExceptions = Array.from(countyData.values()).filter((d) => d.hasExceptions).length;
  const totalWithPdfWaters = Array.from(countyData.values()).filter((d) => d.typeCodes.length > 0).length;
  const richest = Array.from(countyData.entries()).sort((a, b) => b[1].waterbodyCount - a[1].waterbodyCount)[0];

  // Annotate the SVG: add choropleth fill, data attributes, and labels
  let annotated = miCountiesSvg;

  // Add data attributes and inline fill to each county path
  annotated = annotated.replace(
    /<path\s+([^>]*?)data-county="([^"]+)"([^>]*?)\/?>/g,
    (_match, before, county, after) => {
      const cd = countyData.get(county);
      if (!cd) return `<path ${before}data-county="${county}"${after}/>`;
      const fill = choroplethFill(cd.waterbodyCount, maxWB);
      const excAttr = cd.hasExceptions ? ' data-has-exceptions="true"' : "";
      return `<path ${before}data-county="${county}"${after} data-waterbody-count="${cd.waterbodyCount}"${excAttr} style="fill: ${fill};"/>`;
    }
  );

  // Add county label text elements before the closing </g> tag.
  // Labels are positioned at approximate centroids using path bounding boxes.
  // Since we can't call getBBox during string construction, we add empty
  // text elements with data-county attributes and position them in
  // attachMapHandlers after the SVG is in the DOM.
  const labelTexts = allCounties
    .map((county) => {
      const cd = countyData.get(county);
      if (!cd || cd.waterbodyCount === 0) return "";
      const shortName = county.length > 8 ? county.substring(0, 7) + "." : county;
      return `<text data-county-label="${esc(county)}" class="map-county-label" x="0" y="0" text-anchor="middle" pointer-events="none">${esc(shortName)}</text>`;
    })
    .join("\n    ");

  annotated = annotated.replace(/(\s*<\/g>\s*<\/svg>\s*)$/, `${labelTexts}\n$1`);

  return `
    <div class="map-view">
      <div class="map-view__header">
        <h2 class="map-view__title">Browse by county</h2>
        <p class="map-view__hint">
          Click a county for detailed info. Hover for stats. Scroll to zoom, drag to pan.
        </p>
      </div>
      <div class="map-stats-bar">
        <span class="map-stat"><strong>${allCounties.length}</strong> counties</span>
        <span class="map-stat"><strong>${totalWithExceptions}</strong> with exceptions</span>
        <span class="map-stat"><strong>${totalWithPdfWaters}</strong> with trout/salmon waters</span>
        <span class="map-stat">Richest: <strong>${esc(richest?.[0] ?? "")}</strong> (${richest?.[1].waterbodyCount ?? 0})</span>
      </div>
      <div class="map-search">
        <svg class="map-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
        <input type="search" id="map-search-input" class="map-search__input" placeholder="Filter counties by name..." autocomplete="off" />
      </div>
      <div class="map-zoomable" id="map-zoomable">
        <div class="map-svg-container" id="map-svg-container">${annotated}</div>
        <div class="map-tooltip" id="map-tooltip" aria-hidden="true" style="display: none;"></div>
        <div class="map-controls" id="map-controls" role="toolbar" aria-label="Map controls">
          <button type="button" class="map-control-btn" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="map-control-btn" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">\u2212</button>
          <button type="button" class="map-control-btn" data-action="reset" title="Reset zoom" aria-label="Reset zoom">\u27F2</button>
        </div>
      </div>
      <div class="map-legend map-legend--gradient">
        <div class="map-legend__gradient-bar">
          <span class="map-legend__gradient-label">Few</span>
          <div class="map-legend__gradient-fill"></div>
          <span class="map-legend__gradient-label">Many waterbodies</span>
        </div>
        <span class="map-legend__item">
          <span class="map-legend__swatch map-legend__swatch--exceptions"></span>
          Has species exceptions
        </span>
        <span class="map-legend__item">
          <span class="map-legend__swatch map-legend__swatch--selected"></span>
          Selected
        </span>
      </div>
    </div>
  `;
}

function renderResults(results: Result[]): string {
  if (results.length === 0) {
    return `<div class="results"><div class="results__empty">No matches. Try a different name or check the spelling.</div></div>`;
  }
  const groups = groupByCounty(results);
  const html: string[] = [];
  for (const [county, items] of groups) {
    html.push(`<div class="results__group-header">${esc(county)} County</div>`);
    for (const r of items) {
      const isSelected =
        selectedResult &&
        selectedResult.name === r.name &&
        selectedResult.county === r.county &&
        selectedResult.kind === r.kind;
      html.push(`
        <button
          class="result"
          data-kind="${r.kind}"
          data-name="${esc(r.name)}"
          data-county="${esc(r.county)}"
          aria-selected="${isSelected ? "true" : "false"}"
        >
          <span class="result__main">
            <span class="result__name">${highlight(r.name, currentQuery)}</span>
            ${r.matchedField === "county"
              ? `<span class="result__county">in ${esc(r.county)} County</span>`
              : ""}
          </span>
          <span class="result__kind result__kind--${r.kind}">${capitalize(r.kind)} ${r.type ? `· ${esc(r.type)}` : ""}</span>
        </button>
      `);
    }
  }
  return `<div class="results">${html.join("")}</div>`;
}

function renderDetailPlaceholder(): string {
  return `
    <div class="detail__placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2v6m0 8v6m-10-10h6m8 0h6"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      <p>Search for a lake or stream to see its regulations.</p>
      <p style="font-size: 0.8125rem; margin-top: 0.5rem;">Try "Higgins", "Au Sable", or "Allegan".</p>
    </div>
  `;
}

function renderDetailForResult(result: Result, data: RegsData): string {
  const record = findExact(data, result.kind, result.name, result.county);
  if (!record) return renderDetailPlaceholder();

  const isPdf = record.source === "pdf";
  const typeCode = record.type;

  // For PDF entries with a Type code, get the structured Type regulation
  // data (parsed from pp. 44-45).
  let typeTable = null;
  let typeTitle = "";
  if (isPdf && typeCode) {
    if (record.kind === "stream" || record.kind === "river" || record.kind === "creek") {
      typeTable = data.type_tables.stream_types[typeCode];
      typeTitle = STREAM_TYPE_TITLES[typeCode] ?? `Type ${typeCode}`;
    } else {
      typeTable = data.type_tables.lake_types[typeCode];
      typeTitle = LAKE_TYPE_TITLES[typeCode] ?? `Type ${typeCode}`;
    }
  }

  // For PDF entries, link to the PDF page. For Wikipedia entries, link to
  // the Wikipedia article.
  const pdfPage = record.pdf_record?.source_page;
  const pdfHref = pdfPage
    ? `https://github.com/tsteinke11306/angl3r/blob/main/data/2026-Michigan-Fishing-Regulations.pdf#page=${pdfPage}`
    : null;
  const wikiHref = record.wikipedia_title
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(record.wikipedia_title.replace(/ /g, "_"))}`
    : null;

  // Build the Type / regulation section
  let typeSection = "";
  if (isPdf && typeCode && typeTable && typeTable.plain) {
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Type ${esc(typeCode)} regulation</h3>
        <pre class="detail__body detail__body--type">${esc(typeTable.plain)}</pre>
      </div>
    `;
  } else if (isPdf && typeCode) {
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Type ${esc(typeCode)} regulation</h3>
        <p class="detail__body--ocr">No structured regulation data found for this Type. See the original PDF for details.</p>
      </div>
    `;
  } else {
    // Wikipedia-only entry — no specific Type code; statewide species rules apply
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Regulation designation</h3>
        <p class="detail__body">This waterbody is not listed in the 2026 Michigan inland trout/salmon regulations, so it does not have a specific Type code. The statewide species rules (below) apply to all waters in ${esc(record.county)} County unless a county-specific exception is listed.</p>
      </div>
    `;
  }

  // Build the species section: statewide rules + county exceptions
  const species = data.species?.statewide ?? [];
  const countyExceptions = data.species?.county_exceptions?.[record.county] ?? null;
  const speciesSectionExpanded = currentSpecies !== null;

  // Check which species are confirmed for this specific waterbody
  const wbSpecies = data.species_by_waterbody?.[record.county]?.[record.name];
  const confirmedSet = new Set(
    (wbSpecies?.species ?? []).map((s: string) => s.toLowerCase())
  );

  // Sort confirmed species to the top so they surface first
  const sortedSpecies = [...species].sort((a, b) => {
    const aConfirmed = confirmedSet.size > 0 && (
      confirmedSet.has(a.name.toLowerCase()) ||
      Array.from(confirmedSet).some(c => a.name.toLowerCase().includes(c))
    );
    const bConfirmed = confirmedSet.size > 0 && (
      confirmedSet.has(b.name.toLowerCase()) ||
      Array.from(confirmedSet).some(c => b.name.toLowerCase().includes(c))
    );
    if (aConfirmed === bConfirmed) return a.name.localeCompare(b.name);
    return aConfirmed ? -1 : 1;
  });

  const speciesItemsHtml = sortedSpecies
    .map((sp) => {
      const isSelected = currentSpecies === sp.id;
      const collapsed = speciesSectionExpanded && !isSelected;
      const openAttr = collapsed ? "" : "open";
      const isConfirmed = confirmedSet.size > 0 && (
        confirmedSet.has(sp.name.toLowerCase()) ||
        Array.from(confirmedSet).some(c => sp.name.toLowerCase().includes(c))
      );
      const itemClass = `species-list__item ${isConfirmed ? "species-list__item--confirmed" : ""}`;
      const headerClass = `species-list__toggle ${isSelected ? "species-list__toggle--active" : ""}`;
      return `
        <details class="${itemClass}" ${openAttr} ${isSelected ? "data-selected-species" : ""}>
          <summary class="${headerClass}">
            <span class="species-list__name">${esc(sp.name)}</span>
            <span class="species-list__size">${esc(sp.min_size)}</span>
          </summary>
          <dl class="species-list__regs">
            <dt>Min size</dt><dd>${esc(sp.min_size)}</dd>
            <dt>Daily limit</dt><dd>${esc(sp.daily_limit)}</dd>
            <dt>Seasons</dt>
            <dd>${sp.possession_seasons.map((s) => esc(s)).join("<br>")}</dd>
            ${sp.notes ? `<dt>Notes</dt><dd>${esc(sp.notes)}</dd>` : ""}
          </dl>
        </details>
      `;
    })
    .join("");

  const speciesSection = `
    <div class="detail__section">
      <h3 class="detail__section-title">Statewide species rules</h3>
      <p class="detail__hint">Statewide rules apply unless a county-specific exception is listed below. Confirmed species for this waterbody are outlined and sorted to the top.</p>
      <div class="species-list">${speciesItemsHtml}</div>
    </div>
    ${
      countyExceptions
        ? `<div class="detail__section">
        <h3 class="detail__section-title">${esc(record.county)} County exceptions</h3>
        <div class="detail__body detail__body--reg-text">${esc(countyExceptions).replace(/\n/g, "<br>")}</div>
      </div>`
        : ""
    }
  `;

  // Species found in this specific waterbody from historical survey data
  let speciesByWaterbodySection = "";
  if (wbSpecies && wbSpecies.species && wbSpecies.species.length > 0) {
    const speciesChips = wbSpecies.species
      .map((sp: string) => `<span class="badge badge--species">${esc(sp)}</span>`)
      .join(" ");
    const extrasHtml = wbSpecies.extras?.length
      ? `<p class="detail__hint">Also noted: ${esc(wbSpecies.extras.join("; "))}</p>`
      : "";
    speciesByWaterbodySection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Species found here</h3>
        <p class="detail__hint">
          From ${wbSpecies.survey_records} historical DNR survey(s)
          (${wbSpecies.survey_years?.slice(0, 3).join(", ")}${(wbSpecies.survey_years?.length || 0) > 3 ? "…" : ""}).
        </p>
        <div class="detail__species-chips">${speciesChips}</div>
        ${extrasHtml}
      </div>
    `;
  } else if (wbSpecies && wbSpecies.source === null) {
    speciesByWaterbodySection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Species found here</h3>
        <p class="detail__hint">No historical survey data available for this waterbody.</p>
      </div>
    `;
  }

  // Source badge
  const sourceBadge = isPdf
    ? `<span class="badge badge--pdf">Type ${esc(typeCode ?? "?")} — ${esc(typeTitle)}</span>`
    : `<span class="badge badge--wiki">Wikipedia entry</span>`;

  return `
    <h2 class="detail__title">${esc(result.name)}</h2>
    <p class="detail__subtitle">${esc(result.county)} County · ${esc(capitalize(record.kind))}</p>

    <div class="detail__badges">
      ${sourceBadge}
      ${record.section ? `<span class="badge">${esc(record.section.slice(0, 60))}${record.section.length > 60 ? "…" : ""}</span>` : ""}
    </div>

    ${record.section
      ? `<div class="detail__section">
           <h3 class="detail__section-title">Section of stream</h3>
           <p class="detail__body">${esc(record.section)}</p>
         </div>`
      : ""
    }

    ${record.closure
      ? `<div class="detail__section">
           <h3 class="detail__section-title">Seasonal closure</h3>
           <p class="detail__body"><span class="badge badge--warning">${esc(record.closure)}</span></p>
         </div>`
      : ""
    }

    ${typeSection}

    ${speciesByWaterbodySection}

    ${speciesSection}

    <div class="detail__links">
      ${pdfHref ? `<a class="detail__link" href="${pdfHref}" target="_blank" rel="noopener noreferrer">View in original PDF (page ${pdfPage}) →</a>` : ""}
      ${wikiHref ? `<a class="detail__link" href="${wikiHref}" target="_blank" rel="noopener noreferrer">Read on Wikipedia →</a>` : ""}
    </div>

    <div class="detail__citation">
      Source: <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>,
      effective ${esc(data.source.effective)}.
      Waterbody names from <a href="https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county" target="_blank" rel="noopener noreferrer">Wikipedia</a> (CC BY-SA 4.0).
      ${data.meta?.survey_source?.title
        ? `Species data from <a href="https://doi.org/${esc(data.meta.survey_source.doi)}" target="_blank" rel="noopener noreferrer">${esc(data.meta.survey_source.title)}</a> (${esc(data.meta.survey_source.license)}).`
        : ''}
    </div>
  `;
}

function renderFooter(): string {
  return `
    <footer class="footer">
      <div class="footer__inner">
        <div class="footer__left">
          <p>
            Built from the official <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>.
            This site is a convenience lookup; always verify current rules with the DNR before fishing.
          </p>
        </div>
        <div class="footer__right">
          <a class="footer__source" href="https://github.com/tsteinke11306/angl3r" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.8 1.7 2.6 1.2.1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/>
            </svg>
            Source on GitHub
          </a>
          <p>Data last updated ${new Date().toLocaleDateString()}</p>
        </div>
      </div>
    </footer>
  `;
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

/**
 * Render the search view (search box + results container). Both are
 * inside #view-container; we render them as a single string and use
 * innerHTML to update. The actual search/click handlers are attached
 * separately after the DOM is updated.
 */
function renderSearchView(data: RegsData, selectedSpecies: string | null = null): string {
  // If a county filter is active (set by clicking a county on the map),
  // show a banner above the search box indicating the filter and giving
  // a clear button. The filter is intentionally separate from the search
  // input — typing in the search box clears the filter.
  const filterBanner = currentCountyFilter
    ? `
      <div class="county-filter-banner" id="county-filter-banner">
        <span>
          Showing
          <strong>${esc(currentCountyFilter)} County</strong>
          waterbodies only
        </span>
        <button type="button" class="county-filter-banner__clear" id="county-filter-clear" aria-label="Clear county filter">
          Show all
        </button>
      </div>
    `
    : "";

  return `
    ${filterBanner}
    ${renderSearchBox()}
    ${renderSpeciesFilter(data, selectedSpecies)}
    <div id="results-container">${renderResults([])}</div>
  `;
}

/**
 * Render the map view (inline SVG of Michigan counties).
 */
function renderMapViewUI(data: RegsData): string {
  return renderMapView(data);
}

/**
 * Switch between the search and map views. Updates the tab button states,
 * swaps the contents of #view-container, and re-attaches handlers.
 */
function switchView(target: "search" | "map", data: RegsData) {
  currentView = target;

  // Update nav button active states in the header
  const tabSearch = document.getElementById("tab-search")!;
  const tabMap = document.getElementById("tab-map")!;
  tabSearch.setAttribute("aria-selected", String(target === "search"));
  tabMap.setAttribute("aria-selected", String(target === "map"));
  tabSearch.classList.toggle("is-active", target === "search");
  tabMap.classList.toggle("is-active", target === "map");

  // Replace the view container's contents
  const container = document.getElementById("view-container")!;
  container.innerHTML =
    target === "search" ? renderSearchView(data, currentSpecies) : renderMapViewUI(data);

  // Re-attach handlers for the new view
  if (target === "search") {
    attachSearchHandlers(data);
  } else {
    attachMapHandlers(data);
  }
}

/**
 * Re-attach event handlers for the search view. Called after every render
 * of the search UI (initial load, view switch from map, etc.).
 */
function attachSearchHandlers(data: RegsData) {
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  if (!searchInput) return;
  // Re-apply the current query (in case we're switching from map where
  // the user clicked a county)
  searchInput.value = currentQuery;

  const resultsContainer = document.getElementById("results-container")!;

  // If we just switched from the map with a county filter, populate the
  // results with that county's waterbodies (no search query).
  if (currentCountyFilter && !currentQuery) {
    const countyWBs =
      data.waterbodies?.filter((w) => w.county === currentCountyFilter) ?? [];
    resultsContainer.innerHTML = renderResults(
      countyWBs.map((w) => ({
        kind: w.kind as "lake" | "river" | "stream" | "creek" | "pond" | "bay" | "harbor" | "channel",
        name: w.name,
        county: w.county,
        source: w.source as "pdf" | "wikipedia",
        type: w.type,
        source_page: w.pdf_record?.source_page,
        section: w.section,
        closure: w.closure,
        wikipedia_title: w.wikipedia_title,
        matchDistance: 0,
        matchedField: "name" as const,
      }))
    );
    attachResultHandlers(data);
    if (countyWBs.length > 0) {
      selectedResult = countyWBs[0] as unknown as Result;
      updateDetailForSelected(data);
    }
  } else if (currentQuery) {
    // Otherwise, run the current query if any
    const results = doSearch(data);
    resultsContainer.innerHTML = renderResults(results);
    attachResultHandlers(data);
  }

  // County filter banner — wire up the "Show all" clear button
  const clearBtn = document.getElementById("county-filter-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      currentCountyFilter = null;
      // Re-render the search view to drop the banner
      const viewContainer = document.getElementById("view-container")!;
      viewContainer.innerHTML = renderSearchView(data, currentSpecies);
      attachSearchHandlers(data);
      // Re-render the detail for the currently selected result
      if (selectedResult) {
        const detailContainer = document.getElementById("detail-container");
        if (detailContainer) {
          detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(selectedResult, data)}</div>`;
        }
      }
    });
  }

  let searchTimer: number | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      currentQuery = searchInput.value;
      // If user starts typing, drop the county filter — they're now in
      // search mode, not browse mode.
      if (currentQuery && currentCountyFilter) {
        currentCountyFilter = null;
        // Re-render to drop the banner
        const viewContainer = document.getElementById("view-container")!;
        viewContainer.innerHTML = renderSearchView(data, currentSpecies);
        attachSearchHandlers(data);
        return;
      }
      const results = doSearch(data);
      resultsContainer.innerHTML = renderResults(results);
      attachResultHandlers(data);
      // Auto-select the first result if nothing is selected
      if (!selectedResult && results.length > 0) {
        selectedResult = results[0];
        updateDetailForSelected(data);
      } else if (selectedResult) {
        updateDetailForSelected(data);
      }
    }, 80);
  });

  // Keyboard nav
  searchInput.addEventListener("keydown", (e) => {
    const buttons = Array.from(resultsContainer.querySelectorAll<HTMLElement>(".result"));
    if (buttons.length === 0) return;
    const currentIdx = selectedResult
      ? buttons.findIndex(
          (b) =>
            b.dataset.name === selectedResult!.name &&
            b.dataset.county === selectedResult!.county &&
            b.dataset.kind === selectedResult!.kind
        )
      : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = buttons[Math.min(currentIdx + 1, buttons.length - 1)];
      if (next) next.click();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = buttons[Math.max(currentIdx - 1, 0)];
      if (prev) prev.click();
    }
  });

  // Species filter chips
  const speciesChips = document.querySelectorAll<HTMLElement>(".species-chip");
  speciesChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const speciesId = chip.dataset.speciesId;
      currentSpecies = speciesId === "__all" ? null : speciesId || null;
      // Re-render the search view to update chip active states AND the
      // detail panel to reflect the new species selection.
      const viewContainer = document.getElementById("view-container")!;
      viewContainer.innerHTML = renderSearchView(data, currentSpecies);
      attachSearchHandlers(data);
      // Re-render the detail panel for the currently selected result so
      // the new species filter takes effect (e.g. expands the right
      // species card).
      if (selectedResult) {
        const detailContainer = document.getElementById("detail-container");
        if (detailContainer) {
          detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(selectedResult, data)}</div>`;
        }
      }
    });
  });
}

/**
 * Wrapper around search() that also factors in the species filter.
 * Currently, the species filter doesn't change WHICH waterbodies appear
 * (the warmwater baseline applies everywhere), but it could be used to
 * restrict to trout/salmon only, or to surface only waterbodies with
 * county-specific exceptions for the selected species.
 */
function doSearch(data: RegsData): Result[] {
  const results = search(currentQuery, data, 50);
  if (currentSpecies === null) {
    return results;
  }
  // If a specific species is selected, we still return all matching
  // waterbodies (the regs apply to most of them via the statewide baseline).
  // The species filter is primarily a UI hint for the detail panel.
  return results;
}

/**
 * Re-attach event handlers for the map view. Wires up the click handler
 * on each <path> element so clicking a county sets the search filter
 * to that county name and switches back to the search view.
 */
function attachMapHandlers(data: RegsData) {
  const container = document.getElementById("map-svg-container");
  if (!container) return;
  const zoomable = document.getElementById("map-zoomable");

  // ----- Pan/zoom -----
  // We apply a CSS transform to a wrapper around the SVG. This is fast
  // (GPU-accelerated) and lets us support wheel zoom + drag pan + buttons
  // without a third-party library.
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 8;

  // The wrapper we transform. We use the .map-svg-container itself as
  // the transform target (it's already positioned by CSS).
  const target = container as HTMLElement;

  function applyTransform() {
    target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function setTransform(newScale: number, newTx: number, newTy: number) {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    tx = newTx;
    ty = newTy;
    applyTransform();
  }

  function resetTransform() {
    setTransform(1, 0, 0);
  }

  // Wheel zoom - zoom toward the cursor position
  // Math: keep the point under the cursor visually fixed.
  // p = cursor relative to element center. After scaling by k, the
  // element grows by k. To keep p fixed: newTx = p - k * (p - tx).
  if (zoomable) {
    zoomable.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      const k = newScale / scale;
      // Keep cursor point fixed: newTx = cx - k*(cx - tx)
      setTransform(newScale, cx - k * (cx - tx), cy - k * (cy - ty));
    }, { passive: false });
  }

  // Drag-to-pan
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTx = 0;
  let panStartTy = 0;
  let panMoved = false; // track if the mouse actually moved during pan

  if (zoomable) {
    zoomable.addEventListener("mousedown", (e: MouseEvent) => {
      // Don't start a pan if the user clicked on a county path or label -
      // those have their own click handlers.
      const clickTarget = e.target as Element;
      if (clickTarget.closest("[data-county]")) return;
      if (clickTarget.closest("text[data-county-label]")) return;
      isPanning = true;
      panMoved = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartTx = tx;
      panStartTy = ty;
      zoomable.style.cursor = "grabbing";
      e.preventDefault(); // prevent text selection flash
    });

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panMoved = true;
      tx = panStartTx + dx;
      ty = panStartTy + dy;
      applyTransform();
    });

    window.addEventListener("mouseup", () => {
      if (isPanning) {
        isPanning = false;
        if (zoomable) zoomable.style.cursor = "";
      }
    });
  }

  // Touch pan (single finger)
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTx = 0;
  let touchStartTy = 0;
  let touchActive = false;

  if (zoomable) {
    zoomable.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as Element;
      if (target.closest("[data-county]")) return;
      touchActive = true;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTx = tx;
      touchStartTy = ty;
    }, { passive: true });

    zoomable.addEventListener("touchmove", (e: TouchEvent) => {
      if (!touchActive || e.touches.length !== 1) return;
      tx = touchStartTx + (e.touches[0].clientX - touchStartX);
      ty = touchStartTy + (e.touches[0].clientY - touchStartY);
      applyTransform();
    }, { passive: true });

    zoomable.addEventListener("touchend", () => { touchActive = false; });
  }

  // Control buttons (+/-/reset) - zoom toward center of current view
  const controls = document.getElementById("map-controls");
  if (controls) {
    controls.addEventListener("click", (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".map-control-btn");
      if (!btn) return;
      const action = btn.dataset.action;
      // Zoom toward center (0,0 in element-relative coords since transform
      // origin is center)
      const cx = 0;
      const cy = 0;
      if (action === "zoom-in") {
        const k = 1.4;
        setTransform(scale * k, cx - k * (cx - tx), cy - k * (cy - ty));
      } else if (action === "zoom-out") {
        const k = 1 / 1.4;
        setTransform(scale * k, cx - k * (cx - tx), cy - k * (cy - ty));
      } else if (action === "reset") {
        resetTransform();
      }
    });
  }

  // ----- Position county labels at path centroids -----
  const labelTexts = container.querySelectorAll<SVGTextElement>("text[data-county-label]");
  labelTexts.forEach((textEl) => {
    const county = textEl.getAttribute("data-county-label");
    if (!county) return;
    const path = container.querySelector<SVGPathElement>(`path[data-county="${county}"]`);
    if (!path) return;
    try {
      const bbox = path.getBBox();
      textEl.setAttribute("x", String(bbox.x + bbox.width / 2));
      textEl.setAttribute("y", String(bbox.y + bbox.height / 2 + 0.03));
    } catch {
      // getBBox may fail if SVG isn't rendered yet; skip silently
    }
  });

  // ----- County search filter -----
  const mapSearchInput = document.getElementById("map-search-input") as HTMLInputElement | null;
  if (mapSearchInput) {
    let mapSearchTimer: number | null = null;
    mapSearchInput.addEventListener("input", () => {
      if (mapSearchTimer) window.clearTimeout(mapSearchTimer);
      mapSearchTimer = window.setTimeout(() => {
        const q = mapSearchInput.value.trim().toLowerCase();
        const allPaths = container.querySelectorAll<SVGPathElement>("path[data-county]");
        const allLabels = container.querySelectorAll<SVGTextElement>("text[data-county-label]");
        if (!q) {
          // Reset: show all at full opacity
          allPaths.forEach((p) => p.classList.remove("map-county--dim", "map-county--match"));
          allLabels.forEach((l) => l.classList.remove("map-county-label--dim", "map-county-label--match"));
          return;
        }
        const matched: string[] = [];
        allPaths.forEach((p) => {
          const c = p.getAttribute("data-county") ?? "";
          if (c.toLowerCase().includes(q)) {
            p.classList.add("map-county--match");
            p.classList.remove("map-county--dim");
            matched.push(c);
          } else {
            p.classList.add("map-county--dim");
            p.classList.remove("map-county--match");
          }
        });
        allLabels.forEach((l) => {
          const c = l.getAttribute("data-county-label") ?? "";
          if (c.toLowerCase().includes(q)) {
            l.classList.add("map-county-label--match");
            l.classList.remove("map-county-label--dim");
          } else {
            l.classList.add("map-county-label--dim");
            l.classList.remove("map-county-label--match");
          }
        });
        // Auto-select if exactly one match
        if (matched.length === 1) {
          showCountyOnMap(matched[0], data);
        }
      }, 120);
    });
  }

  // ----- County click + hover handler -----
  const countyDataMap = getCountyMapData(data);
  const paths = container.querySelectorAll<SVGPathElement>("path[data-county]");
  paths.forEach((path) => {
    const county = path.getAttribute("data-county")!;
    const cd = countyDataMap.get(county);

    const wbCount = cd?.waterbodyCount ?? 0;
    const label = `${county} County - ${wbCount} waterbod${wbCount === 1 ? "y" : "ies"}`;
    path.setAttribute("aria-label", label);
    path.setAttribute("role", "button");
    path.setAttribute("tabindex", "0");

    const onActivate = () => {
      // Suppress click if this was the end of a drag-pan (user dragged
      // the map and happened to release over a county).
      if (panMoved) {
        panMoved = false;
        return;
      }
      // Stay on map view, show county summary in the detail panel
      showCountyOnMap(county, data);
    };

    path.addEventListener("click", onActivate);
    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });

    // Rich tooltip on hover - show county stats card
    path.addEventListener("mouseenter", (e) => {
      const tooltip = document.getElementById("map-tooltip");
      if (!tooltip || !cd) return;
      tooltip.innerHTML = `
        <div class="map-tooltip__card">
          <div class="map-tooltip__name">${esc(county)} County</div>
          <div class="map-tooltip__stats">
            <span>${cd.lakeCount} lakes</span>
            <span>${cd.streamCount} rivers/streams</span>
            <span>${cd.waterbodyCount} total</span>
          </div>
          <div class="map-tooltip__badges">
            ${cd.hasExceptions ? '<span class="map-tooltip__badge map-tooltip__badge--exc">Has exceptions</span>' : '<span class="map-tooltip__badge map-tooltip__badge--no-exc">No exceptions</span>'}
            ${cd.typeCodes.length > 0 ? `<span class="map-tooltip__badge map-tooltip__badge--type">Types: ${esc(cd.typeCodes.join(", "))}</span>` : ""}
          </div>
          ${cd.speciesSet.length > 0 ? `<div class="map-tooltip__species">${cd.speciesSet.length} species from surveys</div>` : ""}
        </div>
      `;
      tooltip.style.display = "block";
      tooltip.setAttribute("aria-hidden", "false");
      const containerRect = (document.getElementById("map-zoomable") as HTMLElement).getBoundingClientRect();
      tooltip.style.left = (e.clientX - containerRect.left + 18) + "px";
      tooltip.style.top = (e.clientY - containerRect.top - 10) + "px";
    });
    path.addEventListener("mousemove", (e) => {
      const tooltip = document.getElementById("map-tooltip");
      if (!tooltip || tooltip.style.display === "none") return;
      const containerRect = (document.getElementById("map-zoomable") as HTMLElement).getBoundingClientRect();
      // Position tooltip to the right of cursor, clamp to container
      const tx = Math.min(e.clientX - containerRect.left + 18, containerRect.width - 220);
      const ty = Math.max(e.clientY - containerRect.top - 10, 10);
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";
    });
    path.addEventListener("mouseleave", () => {
      const tooltip = document.getElementById("map-tooltip");
      if (!tooltip) return;
      tooltip.style.display = "none";
      tooltip.setAttribute("aria-hidden", "true");
    });
  });
}

/**
 * Show a rich county summary panel in the detail container while staying
 * on the map view. The panel includes stats, waterbody list, type codes,
 * species found, and a button to switch to search view with the county filter.
 */
function showCountyOnMap(county: string, data: RegsData) {
  // Highlight the selected county on the map
  const container = document.getElementById("map-svg-container");
  if (container) {
    container.querySelectorAll<SVGPathElement>("path[data-county]").forEach((p) => {
      p.removeAttribute("data-selected");
    });
    const selected = container.querySelector<SVGPathElement>(`path[data-county="${county}"]`);
    if (selected) selected.setAttribute("data-selected", "true");
  }

  const detailContainer = document.getElementById("detail-container");
  if (!detailContainer) return;
  detailContainer.innerHTML = `<div class="detail">${renderCountySummary(county, data)}</div>`;
  detailContainer.scrollTop = 0;

  // Wire up the "Search all in county" button
  const searchBtn = document.getElementById("county-search-btn");
  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      currentCountyFilter = county;
      currentQuery = "";
      selectedResult = null;
      currentSpecies = null;
      switchView("search", data);
      const results = data.waterbodies?.filter((w) => w.county === county) ?? [];
      const resultsContainer = document.getElementById("results-container");
      if (resultsContainer) {
        resultsContainer.innerHTML = renderResults(
          results.map((w) => ({
            kind: w.kind as Result["kind"],
            name: w.name,
            county: w.county,
            source: w.source as "pdf" | "wikipedia",
            type: w.type,
            source_page: w.pdf_record?.source_page,
            section: w.section,
            closure: w.closure,
            wikipedia_title: w.wikipedia_title,
            matchDistance: 0,
            matchedField: "name" as const,
          }))
        );
        attachResultHandlers(data);
        if (results.length > 0) {
          selectedResult = results[0] as unknown as Result;
          updateDetailForSelected(data);
        }
      }
    });
  }

  // Wire up waterbody links in the county summary
  const wbLinks = detailContainer.querySelectorAll<HTMLElement>("[data-wb-link]");
  wbLinks.forEach((link) => {
    link.addEventListener("click", () => {
      const name = link.dataset.wbLink!;
      const kind = link.dataset.wbKind!;
      // Switch to search view and select this waterbody
      currentCountyFilter = county;
      currentQuery = "";
      selectedResult = null;
      currentSpecies = null;
      switchView("search", data);
      const results = data.waterbodies?.filter((w) => w.county === county) ?? [];
      const resultsContainer = document.getElementById("results-container");
      if (resultsContainer) {
        resultsContainer.innerHTML = renderResults(
          results.map((w) => ({
            kind: w.kind as Result["kind"],
            name: w.name,
            county: w.county,
            source: w.source as "pdf" | "wikipedia",
            type: w.type,
            source_page: w.pdf_record?.source_page,
            section: w.section,
            closure: w.closure,
            wikipedia_title: w.wikipedia_title,
            matchDistance: 0,
            matchedField: "name" as const,
          }))
        );
        attachResultHandlers(data);
        // Select the clicked waterbody
        const target = results.find((w) => w.name === name && w.kind === kind);
        if (target) {
          selectedResult = {
            kind: target.kind as Result["kind"],
            name: target.name,
            county: target.county,
            source: target.source as "pdf" | "wikipedia",
            type: target.type,
            source_page: target.pdf_record?.source_page,
            section: target.section,
            closure: target.closure,
            wikipedia_title: target.wikipedia_title,
            matchDistance: 0,
            matchedField: "name" as const,
          };
          updateDetailForSelected(data);
        }
      }
    });
  });
}

/**
 * Render a rich county summary panel for the map view. Shows stats,
 * waterbody list, type codes, species found, exceptions, and a search button.
 */
function renderCountySummary(county: string, data: RegsData): string {
  const cd = getCountyMapData(data).get(county);
  if (!cd) return renderDetailPlaceholder();

  // Sort waterbodies: PDF first, then by kind, then alphabetically
  const sortedWbs = [...cd.waterbodies].sort((a, b) => {
    if (a.source !== b.source) return a.source === "pdf" ? -1 : 1;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });

  // Group waterbodies by kind
  const byKind: Record<string, typeof sortedWbs> = {};
  for (const wb of sortedWbs) {
    if (!byKind[wb.kind]) byKind[wb.kind] = [];
    byKind[wb.kind].push(wb);
  }
  const kindOrder = ["lake", "river", "stream", "creek", "pond", "bay", "harbor", "channel"];
  const sortedKinds = Object.keys(byKind).sort((a, b) => {
    const ai = kindOrder.indexOf(a);
    const bi = kindOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const exceptions = data.species?.county_exceptions?.[county] ?? null;

  // Species chips
  const speciesChipsHtml = cd.speciesSet.length > 0
    ? cd.speciesSet.map((sp) => `<span class="badge badge--species">${esc(sp)}</span>`).join(" ")
    : '<p class="detail__hint">No historical survey species data available for this county.</p>';

  return `
    <h2 class="detail__title">${esc(county)} County</h2>
    <p class="detail__subtitle">Click any waterbody to view its regulations</p>

    <div class="county-summary__stats">
      <div class="county-stat">
        <span class="county-stat__num">${cd.lakeCount}</span>
        <span class="county-stat__label">Lakes</span>
      </div>
      <div class="county-stat">
        <span class="county-stat__num">${cd.streamCount}</span>
        <span class="county-stat__label">Rivers/Streams</span>
      </div>
      <div class="county-stat">
        <span class="county-stat__num">${cd.waterbodyCount}</span>
        <span class="county-stat__label">Total</span>
      </div>
    </div>

    <div class="detail__badges">
      ${cd.hasExceptions ? '<span class="badge badge--warning">Has county-specific exceptions</span>' : '<span class="badge badge--wiki">No county exceptions</span>'}
      ${cd.typeCodes.length > 0 ? `<span class="badge badge--pdf">Type codes: ${esc(cd.typeCodes.join(", "))}</span>` : ""}
    </div>

    ${exceptions ? `
      <div class="detail__section">
        <h3 class="detail__section-title">County-specific exceptions</h3>
        <div class="detail__body detail__body--reg-text">${esc(exceptions).replace(/\n/g, "<br>")}</div>
      </div>
    ` : ""}

    <div class="detail__section">
      <h3 class="detail__section-title">Waterbodies (${sortedWbs.length})</h3>
      ${sortedKinds.map((kind) => `
        <div class="county-wb-group">
          <div class="county-wb-group__header">${esc(capitalize(kind))}s (${byKind[kind].length})</div>
          ${byKind[kind].map((wb) => `
            <button class="county-wb-link" data-wb-link="${esc(wb.name)}" data-wb-kind="${esc(wb.kind)}">
              <span class="county-wb-link__name">${esc(wb.name)}</span>
              ${wb.type ? `<span class="county-wb-link__type">${esc(wb.type)}</span>` : ""}
              ${wb.source === "pdf" ? '<span class="county-wb-link__src">PDF</span>' : '<span class="county-wb-link__src county-wb-link__src--wiki">Wiki</span>'}
            </button>
          `).join("")}
        </div>
      `).join("")}
    </div>

    <div class="detail__section">
      <h3 class="detail__section-title">Species from surveys (${cd.speciesSet.length})</h3>
      <div class="detail__species-chips">${speciesChipsHtml}</div>
    </div>

    <div class="county-summary__actions">
      <button id="county-search-btn" class="county-search-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
        Search all in ${esc(county)} County
      </button>
    </div>

    <div class="detail__citation">
      Source: <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>,
      effective ${esc(data.source.effective)}.
    </div>
  `;
}

/**
 * Re-attach the click handlers to result buttons in the results list.
 */
function attachResultHandlers(data: RegsData) {
  const resultsContainer = document.getElementById("results-container");
  if (!resultsContainer) return;
  const buttons = resultsContainer.querySelectorAll<HTMLElement>(".result");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.kind as "lake" | "stream";
      const name = btn.dataset.name!;
      const county = btn.dataset.county!;
      // Use findExact to look up the waterbody directly from data,
      // not from search() — currentQuery may be empty (e.g. county filter mode),
      // which would cause search() to return an empty array.
      const result = findExact(data, kind, name, county);
      if (!result) return;
      selectedResult = { kind, name, county, source: result.source as "pdf" | "wikipedia", type: result.type, source_page: result.pdf_record?.source_page, section: result.section, closure: result.closure, wikipedia_title: result.wikipedia_title, matchDistance: 0, matchedField: "name" as const };
      buttons.forEach((b) => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      updateDetailForSelected(data);
    });
  });
}

/**
 * Re-render the detail panel for the currently selected result.
 */
function updateDetailForSelected(data: RegsData) {
  const detailContainer = document.getElementById("detail-container");
  if (!detailContainer) return;
  if (selectedResult) {
    detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(selectedResult, data)}</div>`;
  } else {
    detailContainer.innerHTML = `<div class="detail">${renderDetailPlaceholder()}</div>`;
  }
  // With dual-pane scrolling, the detail panel stays in place when
  // the user selects a new waterbody. Scroll it to the top so the
  // header is immediately visible.
  detailContainer.scrollTop = 0;
}

async function main() {
  const root = document.getElementById("app")!;
  let data: RegsData;
  try {
    data = await loadData();
  } catch (err) {
    root.innerHTML = `
      <div class="main">
        <h1>Failed to load data</h1>
        <p>${esc((err as Error).message)}</p>
      </div>
    `;
    return;
  }

  // Fix the favicon href to use the proper base URL. The HTML has a
  // placeholder href; we update it now that the JS bundle has loaded.
  const favicon = document.getElementById("favicon") as HTMLLinkElement | null;
  if (favicon) favicon.href = faviconUrl;

  // Initial render: search view is default
  currentView = "search";
  root.innerHTML = `
    ${renderHeader(currentView)}
    <main class="main">
      ${renderStats(data)}
      <div class="layout">
        <div>
          <div id="view-container">${renderSearchView(data)}</div>
        </div>
        <div id="detail-container">
          <div class="detail">${renderDetailPlaceholder()}</div>
        </div>
      </div>
    </main>
    ${renderFooter()}
  `;

  // Wire up the tab buttons
  document.getElementById("tab-search")!.addEventListener("click", () => {
    if (currentView === "search") return;
    switchView("search", data);
  });
  document.getElementById("tab-map")!.addEventListener("click", () => {
    if (currentView === "map") return;
    switchView("map", data);
  });

  // Attach the search-view handlers (input, keyboard nav, result clicks)
  attachSearchHandlers(data);
}

main().catch((err) => {
  console.error("Failed to start app:", err);
  document.getElementById("app")!.innerHTML = `
    <div class="main">
      <h1>Failed to start</h1>
      <p>${esc((err as Error).message)}</p>
    </div>
  `;
});
