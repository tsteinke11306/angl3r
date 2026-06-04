/**
 * Angler — Michigan Fishing Regulations
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
import logoUrl from "../public/angler-icon.svg";
import topoUrl from "../public/topo-bg.svg";
// The county map SVG is loaded as a raw string so we can inline it into
// the DOM and attach click handlers to each <path>. Using ?raw tells Vite
// to ship the file contents as a string instead of as a fingerprinted URL.
import miCountiesSvg from "../public/mi-counties.svg?raw";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// Data is imported as a JSON module — Vite inlines it into the bundle at
// Data is fetched at runtime so the JSON doesn't get inlined into the
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

function renderHeader(): string {
  return `
    <header class="site-header" style="--topo-bg: url('${topoUrl}')">
      <div class="site-header__inner">
        <img src="${logoUrl}" alt="" class="site-logo" />
        <div>
          <h1 class="site-title">Angler</h1>
          <p class="site-tagline">Michigan fishing regulations — search by lake or stream</p>
        </div>
      </div>
    </header>
  `;
}

function renderStats(data: RegsData): string {
  const wbCount = data.meta.waterbody_count ?? data.waterbodies?.length ?? 0;
  return `
    <div class="stats">
      <span><strong>${data.meta.lake_count}</strong> PDF trout/salmon lakes</span>
      <span><strong>${data.meta.stream_count}</strong> PDF trout/salmon streams</span>
      <span><strong>${wbCount}</strong> total named waterbodies</span>
      <span><strong>${data.meta.county_count}</strong> counties</span>
      <span>Source: <strong>${esc(data.source.title)}</strong> + Wikipedia</span>
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
 * View tabs let the user switch between the search interface and the
 * county map. Default is "search" (the original behavior). The map view
 * shows an interactive SVG of Michigan counties; clicking a county sets
 * the search filter to that county and switches back to the search view.
 */
function renderViewTabs(active: "search" | "map"): string {
  return `
    <div class="view-tabs" role="tablist">
      <button
        class="view-tabs__btn"
        role="tab"
        id="tab-search"
        data-view="search"
        aria-selected="${active === "search"}"
        aria-controls="view-container"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
        Search
      </button>
      <button
        class="view-tabs__btn"
        role="tab"
        id="tab-map"
        data-view="map"
        aria-selected="${active === "map"}"
        aria-controls="view-container"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        Browse by county
      </button>
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
  `;
}

/**
 * Build the map view: an inline SVG of Michigan counties with the
 * `data-has-data` and `data-empty` attributes set per the data.
 *
 * The SVG is imported as a raw string at the top of the file, so we can
 * just inject it here. The path elements have id="county-<name>" and
 * data-county="<Name>" already; we just add the data-* flags.
 */


function renderMapView(data: RegsData): string {
  // Build a set of counties that have waterbodies (PDF trout/salmon OR
  // Wikipedia named waters). Every county has the statewide species
  // baseline, so all 83 are populated. The map's "named waterbodies" stat
  // is the total count from the unified waterbodies array.
  const countiesWithWaterbodies = new Set<string>();
  for (const wb of data.waterbodies ?? []) {
    countiesWithWaterbodies.add(wb.county);
  }

  // Annotate the SVG: mark each path as has-data or has-species.
  // We wrap the whole thing in a <g id="map-zoomable"> so we can apply
  // pan/zoom transforms later.
  let annotated = miCountiesSvg;
  annotated = annotated.replace(
    /<path\s+([^>]*?)data-county="([^"]+)"([^>]*?)\/?>/g,
    (_match, before, county, after) => {
      const has = countiesWithWaterbodies.has(county);
      const flag = has ? ' data-has-data="true"' : ' data-has-species="true"';
      return `<path ${before}data-county="${county}"${after}${flag}/>`;
    }
  );

  return `
    <div class="map-view">
      <div class="map-view__header">
        <h2 class="map-view__title">Browse by county</h2>
        <p class="map-view__hint">
          Click any county to see all ${data.waterbodies?.length ?? 0} named waterbodies. Hover for name. Scroll to zoom, drag to pan.
        </p>
      </div>
      <div class="map-zoomable" id="map-zoomable">
        <div class="map-svg-container" id="map-svg-container">${annotated}</div>
        <div class="map-tooltip" id="map-tooltip" aria-hidden="true" style="display: none;"></div>
        <div class="map-controls" id="map-controls" role="toolbar" aria-label="Map controls">
          <button type="button" class="map-control-btn" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" class="map-control-btn" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" class="map-control-btn" data-action="reset" title="Reset zoom" aria-label="Reset zoom">⟲</button>
        </div>
      </div>
      <div class="map-legend">
        <span class="map-legend__item">
          <span class="map-legend__swatch map-legend__swatch--data"></span>
          Has named waterbodies
        </span>
        <span class="map-legend__item">
          <span class="map-legend__swatch" style="background: #c8d8e3;"></span>
          Statewide species regs apply
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
    ? `https://github.com/tsteinke11306/angler/blob/main/data/2026-Michigan-Fishing-Regulations.pdf#page=${pdfPage}`
    : null;
  const wikiHref = record.wikipedia_title
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(record.wikipedia_title.replace(/ /g, "_"))}`
    : null;

  // Build the Type regulation section (only for PDF entries with a Type)
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
    // Wikipedia-only entry — no specific trout regulation
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Trout/salmon designation</h3>
        <p class="detail__body">This waterbody is not listed in the 2026 Michigan trout/salmon regulations. The statewide species rules (below) apply to all waters in ${esc(record.county)} County unless a county-specific exception is listed.</p>
      </div>
    `;
  }

  // Build the species section: statewide rules + county exceptions
  const species = data.species?.statewide ?? [];
  const countyExceptions = data.species?.county_exceptions?.[record.county] ?? null;
  const speciesSectionExpanded = currentSpecies !== null;

  const speciesItemsHtml = species
    .map((sp) => {
      const isSelected = currentSpecies === sp.id;
      const collapsed = speciesSectionExpanded && !isSelected;
      const openAttr = collapsed ? "" : "open";
      const headerClass = `species-list__toggle ${isSelected ? "species-list__toggle--active" : ""}`;
      return `
        <details class="species-list__item" ${openAttr} ${isSelected ? "data-selected-species" : ""}>
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
      <h3 class="detail__section-title">All Michigan species</h3>
      <p class="detail__hint">Statewide rules apply unless a county-specific exception is listed below.</p>
      <div class="species-list">${speciesItemsHtml}</div>
    </div>
    ${
      countyExceptions
        ? `<div class="detail__section">
        <h3 class="detail__section-title">${esc(record.county)} County exceptions</h3>
        <p class="detail__body">${esc(countyExceptions).replace(/\n/g, "<br>")}</p>
      </div>`
        : ""
    }
  `;

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

    ${speciesSection}

    <div class="detail__links">
      ${pdfHref ? `<a class="detail__link" href="${pdfHref}" target="_blank" rel="noopener noreferrer">View in original PDF (page ${pdfPage}) →</a>` : ""}
      ${wikiHref ? `<a class="detail__link" href="${wikiHref}" target="_blank" rel="noopener noreferrer">Read on Wikipedia →</a>` : ""}
    </div>

    <div class="detail__citation">
      Source: <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>,
      effective ${esc(data.source.effective)}.
      Waterbody names also from <a href="https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county" target="_blank" rel="noopener noreferrer">Wikipedia</a> (CC BY-SA 4.0).
    </div>
  `;
}

function renderFooter(): string {
  return `
    <footer class="site-footer">
      <p>
        Built from the official <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>.
        This site is a convenience lookup; always verify current rules with the DNR before fishing.
      </p>
      <p style="margin-top: 0.5rem;">
        <a href="https://github.com/tsteinke11306/angler" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
        · Data last updated from the ${new Date().toLocaleDateString()} PDF parse.
      </p>
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

  // Update tab aria-selected
  const tabSearch = document.getElementById("tab-search")!;
  const tabMap = document.getElementById("tab-map")!;
  tabSearch.setAttribute("aria-selected", String(target === "search"));
  tabMap.setAttribute("aria-selected", String(target === "map"));

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

  // Wheel zoom — zoom toward the cursor position
  if (zoomable) {
    zoomable.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      // Cursor position relative to the target's center
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      // Adjust translation so the cursor stays anchored to the same point
      const k = newScale / scale;
      setTransform(newScale, cx - k * cx + tx, cy - k * cy + ty);
    }, { passive: false });
  }

  // Drag-to-pan
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTx = 0;
  let panStartTy = 0;

  if (zoomable) {
    zoomable.addEventListener("mousedown", (e: MouseEvent) => {
      // Don't start a pan if the user clicked on a county path or label —
      // those have their own click handlers.
      const target = e.target as Element;
      if (target.closest("[data-county]")) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartTx = tx;
      panStartTy = ty;
      zoomable.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!isPanning) return;
      tx = panStartTx + (e.clientX - panStartX);
      ty = panStartTy + (e.clientY - panStartY);
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

  // Control buttons (+/-/reset)
  const controls = document.getElementById("map-controls");
  if (controls) {
    controls.addEventListener("click", (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".map-control-btn");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "zoom-in") {
        const rect = target.getBoundingClientRect();
        setTransform(scale * 1.4, tx + rect.width * 0.15, ty + rect.height * 0.15);
      } else if (action === "zoom-out") {
        const rect = target.getBoundingClientRect();
        setTransform(scale / 1.4, tx - rect.width * 0.1, ty - rect.height * 0.1);
      } else if (action === "reset") {
        resetTransform();
      }
    });
  }

  // ----- County click handler -----
  // For each <path> with a data-county attribute, attach a click handler
  const paths = container.querySelectorAll<SVGPathElement>("path[data-county]");
  paths.forEach((path) => {
    const county = path.getAttribute("data-county")!;

    // Add an accessible title for screen readers
    const wbCount =
      data.waterbodies?.filter((w) => w.county === county).length ?? 0;
    const label = `${county} County — ${wbCount} waterbod${wbCount === 1 ? "y" : "ies"}`;
    path.setAttribute("aria-label", label);
    path.setAttribute("role", "button");
    path.setAttribute("tabindex", "0");

    const onActivate = () => {
      // Set a county filter (not a text query) and switch to the search
      // view. The search view shows ONLY that county's waterbodies, so
      // "Manistee" no longer matches the river too. The user can then
      // click the river (or the county again) to see its details.
      currentCountyFilter = county;
      currentQuery = "";
      selectedResult = null;
      currentSpecies = null;
      switchView("search", data);
      // After the view switches, the search input is empty and the
      // results list is empty. Populate it with this county's waterbodies.
      const results = data.waterbodies?.filter((w) => w.county === county) ?? [];
      const resultsContainer = document.getElementById("results-container");
      if (resultsContainer) {
        resultsContainer.innerHTML = renderResults(
          // Convert waterbodies to Result shape (sort: PDF trout first)
          results.map((w) => ({
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
            matchedField: "name",
          }))
        );
        attachResultHandlers(data);
        if (results.length > 0) {
          selectedResult = results[0] as unknown as Result;
          updateDetailForSelected(data);
        } else {
          // Shouldn't happen (every county has waterbodies now) but
          // handle gracefully.
          showSpeciesPanelForCounty(county, data);
        }
      } else {
        showSpeciesPanelForCounty(county, data);
      }
    };

    path.addEventListener("click", onActivate);
    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });

    // Tooltip handlers — show county name on hover
    path.addEventListener("mouseenter", (e) => {
      const tooltip = document.getElementById("map-tooltip");
      if (!tooltip) return;
      const county = path.getAttribute("data-county");
      if (!county) return;
      tooltip.textContent = county + " County";
      tooltip.style.display = "block";
      tooltip.setAttribute("aria-hidden", "false");
      // Position near cursor (will be updated on mousemove)
      const rect = (e.target as SVGElement).getBoundingClientRect();
      const containerRect = (document.getElementById("map-zoomable") as HTMLElement).getBoundingClientRect();
      tooltip.style.left = (rect.left - containerRect.left + rect.width / 2) + "px";
      tooltip.style.top = (rect.top - containerRect.top - 8) + "px";
    });
    path.addEventListener("mousemove", (e) => {
      const tooltip = document.getElementById("map-tooltip");
      if (!tooltip || tooltip.style.display === "none") return;
      const containerRect = (document.getElementById("map-zoomable") as HTMLElement).getBoundingClientRect();
      tooltip.style.left = (e.clientX - containerRect.left + 12) + "px";
      tooltip.style.top = (e.clientY - containerRect.top - 8) + "px";
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
      const results = search(currentQuery, data, 50);
      const result = results.find((r) => r.name === name && r.county === county && r.kind === kind);
      if (!result) return;
      selectedResult = result;
      buttons.forEach((b) => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      updateDetailForSelected(data);
      // Scroll the detail panel into view on mobile
      const detailContainer = document.getElementById("detail-container");
      if (window.innerWidth < 880) {
        detailContainer?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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
}

/**
 * Render a detail panel for a county that has no named waterbodies. Shows
 * the statewide species regulations + any per-county exceptions we parsed.
 * This is what users see when they click a "light blue" county on the map
 * (one that doesn't have trout/salmon waters in the PDF).
 */
function showSpeciesPanelForCounty(county: string, data: RegsData) {
  const detailContainer = document.getElementById("detail-container");
  if (!detailContainer) return;
  detailContainer.innerHTML = `<div class="detail">${renderCountySpeciesPanel(county, data)}</div>`;
}

function renderCountySpeciesPanel(county: string, data: RegsData): string {
  const species = data.species?.statewide ?? [];
  const exceptions = data.species?.county_exceptions?.[county] ?? null;

  return `
    <h2 class="detail__title">${esc(county)} County</h2>
    <p class="detail__subtitle">No named waterbodies in this PDF. Statewide species regulations apply.</p>

    <div class="detail__section">
      <h3 class="detail__section-title">Species regulations</h3>
      <p class="detail__body">
        Click any species below to see its statewide rules, or check the
        county-specific exceptions at the bottom of this panel.
      </p>
      <div class="species-list">
        ${species
          .map(
            (sp) => `
          <div class="species-list__item">
            <h4 class="species-list__name">${esc(sp.name)}</h4>
            <dl class="species-list__regs">
              <dt>Min size</dt><dd>${esc(sp.min_size)}</dd>
              <dt>Daily limit</dt><dd>${esc(sp.daily_limit)}</dd>
              <dt>Seasons</dt>
              <dd>${sp.possession_seasons.map((s) => esc(s)).join("<br>")}</dd>
              ${sp.notes ? `<dt>Notes</dt><dd>${esc(sp.notes)}</dd>` : ""}
            </dl>
          </div>
        `
          )
          .join("")}
      </div>
    </div>

    ${
      exceptions
        ? `<div class="detail__section">
        <h3 class="detail__section-title">County-specific exceptions</h3>
        <p class="detail__body">${esc(exceptions).replace(/\n/g, "<br>")}</p>
      </div>`
        : `<div class="detail__section">
        <h3 class="detail__section-title">County-specific exceptions</h3>
        <p class="detail__body--ocr">No specific exceptions are listed in the PDF for ${esc(county)} County. The statewide species rules above apply to all waters in this county.</p>
      </div>`
    }

    <div class="detail__citation">
      Source: <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>,
      effective ${esc(data.source.effective)}.
    </div>
  `;
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
  if (favicon) favicon.href = logoUrl;

  // Initial render: search view is default
  currentView = "search";
  root.innerHTML = `
    ${renderHeader()}
    <main class="main">
      <div class="layout">
        <div>
          ${renderStats(data)}
          ${renderViewTabs(currentView)}
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
