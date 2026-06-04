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
import type { RegsData, Stream } from "./types";
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
// build time. This avoids a runtime fetch and means the site works fully
// offline. The JSON is ~125KB, well under any reasonable limit.
import regsJson from "../public/data/regs.json";

let DATA: RegsData = regsJson as RegsData;

async function loadData(): Promise<RegsData> {
  return DATA;
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
  return `
    <div class="stats">
      <span><strong>${data.meta.lake_count}</strong> inland lakes</span>
      <span><strong>${data.meta.stream_count}</strong> trout/salmon streams</span>
      <span><strong>${data.meta.county_count}</strong> counties</span>
      <span>Source: <strong>${esc(data.source.title)}</strong></span>
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
  // Build a set of counties that have waterbodies OR species data in the dataset.
  // Every county gets the general warmwater species baseline, so all 83
  // counties are "populated" — they all have species regs to show.
  const countiesWithData = new Set<string>();
  for (const lake of data.lakes) countiesWithData.add(lake.county);
  for (const stream of data.streams) countiesWithData.add(stream.county);
  // All counties get species data via the statewide baseline, so all 83
  // counties should be highlighted. But for the trout/salmon listings,
  // only the 59 with lakes/streams have those. We color based on whether
  // the county has ANYTHING specific (waterbodies) — every county shows
  // the same species baseline, so empty vs populated is really about
  // whether the county has named waterbodies.
  const countiesWithWaterbodies = new Set<string>();
  for (const lake of data.lakes) countiesWithWaterbodies.add(lake.county);
  for (const stream of data.streams) countiesWithWaterbodies.add(stream.county);

  // Annotate the SVG: add data-has-data or data-empty to each path.
  // We do a simple regex pass — the SVG was authored by us (or our
  // subagent) so the structure is stable.
  let annotated = miCountiesSvg;
  annotated = annotated.replace(
    /<path\s+([^>]*?)data-county="([^"]+)"([^>]*?)\/?>/g,
    (_match, before, county, after) => {
      // Every county has the general warmwater species baseline. Counties
      // with named waterbodies are highlighted more prominently.
      const has = countiesWithWaterbodies.has(county);
      const flag = has ? ' data-has-data="true"' : ' data-has-species="true"';
      return `<path ${before}data-county="${county}"${after}${flag}/>`;
    }
  );

  return `
    <div class="map-view">
      <div class="map-view__header">
        <h2 class="map-view__title">Click a county</h2>
        <p class="map-view__hint">
          ${countiesWithWaterbodies.size} counties have named waterbodies. All 83 counties have statewide species regulations.
        </p>
      </div>
      <div class="map-svg-container" id="map-svg-container">${annotated}</div>
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
          <span class="result__kind result__kind--${r.kind}">${r.kind === "lake" ? "Lake" : "Stream"} · ${esc(r.type)}</span>
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

  const isStream = result.kind === "stream";
  const stream = isStream ? (record as Stream) : null;
  const typeCode = result.type;

  // Get the structured Type regulation data (parsed from pp. 44-45)
  const typeTable = isStream
    ? data.type_tables.stream_types[typeCode]
    : data.type_tables.lake_types[typeCode];
  const typeTitle = isStream
    ? STREAM_TYPE_TITLES[typeCode] ?? `Type ${typeCode}`
    : LAKE_TYPE_TITLES[typeCode] ?? `Type ${typeCode}`;

  // Link to the PDF page (we use the public/ data PDF for the GitHub Pages
  // deployment; the link is relative to the repo)
  const pdfPage = record.source_page;
  const pdfHref = `https://github.com/tsteinke11306/angler/blob/main/data/2026-Michigan-Fishing-Regulations.pdf#page=${pdfPage}`;

  // Build the Type regulation section
  let typeSection = "";
  if (typeTable && typeTable.plain) {
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Type ${esc(typeCode)} regulation</h3>
        <pre class="detail__body detail__body--type">${esc(typeTable.plain)}</pre>
      </div>
    `;
  } else {
    // Fallback for missing Type (shouldn't happen for valid A-F / 1-4)
    typeSection = `
      <div class="detail__section">
        <h3 class="detail__section-title">Type ${esc(typeCode)} regulation</h3>
        <p class="detail__body--ocr">No structured regulation data found for this Type. See the original PDF for details.</p>
      </div>
    `;
  }

  // Build the species section: statewide rules + county exceptions
  // If a species is currently selected via the chip filter, expand and
  // highlight it.
  const species = data.species?.statewide ?? [];
  const countyExceptions = data.species?.county_exceptions?.[result.county] ?? null;
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
        <h3 class="detail__section-title">${esc(result.county)} County exceptions</h3>
        <p class="detail__body">${esc(countyExceptions).replace(/\n/g, "<br>")}</p>
      </div>`
        : ""
    }
  `;

  return `
    <h2 class="detail__title">${esc(result.name)}</h2>
    <p class="detail__subtitle">${esc(result.county)} County · ${isStream ? "Stream" : "Lake"}</p>

    <div class="detail__badges">
      <span class="badge ${isStream ? "badge--stream" : ""}">Type ${esc(typeCode)} — ${esc(typeTitle)}</span>
      ${stream?.section ? `<span class="badge">${esc(stream.section.slice(0, 60))}${stream.section.length > 60 ? "…" : ""}</span>` : ""}
    </div>

    ${stream?.section
      ? `<div class="detail__section">
           <h3 class="detail__section-title">Section of stream</h3>
           <p class="detail__body">${esc(stream.section)}</p>
         </div>`
      : ""
    }

    ${stream?.closure
      ? `<div class="detail__section">
           <h3 class="detail__section-title">Seasonal closure</h3>
           <p class="detail__body"><span class="badge badge--warning">${esc(stream.closure)}</span></p>
         </div>`
      : ""
    }

    ${typeSection}

    ${speciesSection}

    <a class="detail__link" href="${pdfHref}" target="_blank" rel="noopener noreferrer">
      View in original PDF (page ${pdfPage}) →
    </a>

    <div class="detail__citation">
      Source: <a href="https://michigan.gov/DNR" target="_blank" rel="noopener noreferrer">Michigan DNR 2026 Fishing Regulations</a>,
      effective ${esc(data.source.effective)}.
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
  return `
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

  let searchTimer: number | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      currentQuery = searchInput.value;
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

  // If we already have a query, run it
  if (currentQuery) {
    const results = doSearch(data);
    resultsContainer.innerHTML = renderResults(results);
    attachResultHandlers(data);
  }
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

  // For each <path> with a data-county attribute, attach a click handler
  const paths = container.querySelectorAll<SVGPathElement>("path[data-county]");
  paths.forEach((path) => {
    const county = path.getAttribute("data-county")!;
    const hasData = path.getAttribute("data-has-data") === "true";

    // Add an accessible title for screen readers
    const lakeCount = data.lakes.filter((l) => l.county === county).length;
    const streamCount = data.streams.filter((s) => s.county === county).length;
    let label = county + " County";
    if (hasData) {
      label += ` — ${lakeCount} lake${lakeCount === 1 ? "" : "s"}, ${streamCount} stream${streamCount === 1 ? "" : "s"}`;
    } else {
      label += " — no trout/salmon waters in this PDF";
    }
    path.setAttribute("aria-label", label);
    path.setAttribute("role", "button");
    path.setAttribute("tabindex", "0");

    const onActivate = () => {
      if (!hasData) {
        // Empty county (no named waterbodies) — still show the species
        // panel since every county has the statewide species baseline.
        // Fall through to the same handler.
      }
      // Set the search query to the county name and switch to search view
      currentQuery = county;
      selectedResult = null;
      currentSpecies = null;
      switchView("search", data);
      // The search view re-renders with the county name as the filter.
      // We need to give the DOM a tick to mount before the input event
      // can fire, so manually populate the results.
      const results = search(currentQuery, data, 50);
      const resultsContainer = document.getElementById("results-container");
      if (resultsContainer) {
        resultsContainer.innerHTML = renderResults(results);
        attachResultHandlers(data);
        if (results.length > 0) {
          selectedResult = results[0];
          updateDetailForSelected(data);
        } else {
          // No waterbodies in this county. Show a placeholder detail panel
          // with the species regulations for this county instead.
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
