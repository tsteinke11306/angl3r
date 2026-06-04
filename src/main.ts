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
import type { RegsData, Lake, Stream } from "./types";
import { LAKE_TYPE_TITLES, STREAM_TYPE_TITLES } from "./types";
import { search, groupByCounty, findExact, type Result } from "./search";

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

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

function renderHeader(): string {
  return `
    <header class="site-header">
      <div class="site-header__inner">
        <img src="/angler-icon.svg" alt="" class="site-logo" />
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
  const lake = !isStream ? (record as Lake) : null;

  // Find the relevant general Type regulation doc
  const typeTable = isStream
    ? data.type_tables.stream_types._raw
    : data.type_tables.lake_types._raw;
  const typeTitle = isStream
    ? STREAM_TYPE_TITLES[stream!.type] ?? `Type ${stream!.type}`
    : LAKE_TYPE_TITLES[lake!.type] ?? `Type ${lake!.type}`;

  // Link to the PDF page (we use the public/ data PDF for the GitHub Pages
  // deployment; the link is relative to the repo)
  const pdfPage = record.source_page;
  const pdfHref = `https://github.com/tsteinke11306/angler/blob/main/data/2026-Michigan-Fishing-Regulations.pdf#page=${pdfPage}`;

  return `
    <h2 class="detail__title">${esc(result.name)}</h2>
    <p class="detail__subtitle">${esc(result.county)} County · ${isStream ? "Stream" : "Lake"}</p>

    <div class="detail__badges">
      <span class="badge ${isStream ? "badge--stream" : ""}">Type ${esc(result.type)} — ${esc(typeTitle)}</span>
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

    <div class="detail__section">
      <h3 class="detail__section-title">Type ${esc(result.type)} regulation</h3>
      <p class="detail__body--ocr">${esc(typeTable)}<br><br><em>This text was extracted from the PDF by OCR. It may contain recognition errors. Always verify against the official source linked below.</em></p>
    </div>

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
// Main app
// ---------------------------------------------------------------------------

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

  // Initial render
  root.innerHTML = `
    ${renderHeader()}
    <main class="main">
      <div class="layout">
        <div>
          ${renderStats(data)}
          ${renderSearchBox()}
          <div id="results-container">${renderResults([])}</div>
        </div>
        <div id="detail-container">
          <div class="detail">${renderDetailPlaceholder()}</div>
        </div>
      </div>
    </main>
    ${renderFooter()}
  `;

  const searchInput = document.getElementById("search-input") as HTMLInputElement;
  const resultsContainer = document.getElementById("results-container")!;
  const detailContainer = document.getElementById("detail-container")!;

  // Debounced search
  let searchTimer: number | null = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      currentQuery = searchInput.value;
      const results = search(currentQuery, data, 50);
      resultsContainer.innerHTML = renderResults(results);
      attachResultHandlers();
      // Auto-select the first result if nothing is selected
      if (!selectedResult && results.length > 0) {
        selectedResult = results[0];
        detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(results[0], data)}</div>`;
        // Mark the first result as selected
        const firstBtn = resultsContainer.querySelector(".result") as HTMLElement;
        if (firstBtn) firstBtn.setAttribute("aria-selected", "true");
      } else if (selectedResult) {
        // Update the detail panel for the currently selected result
        detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(selectedResult, data)}</div>`;
      }
    }, 80);
  });

  // Keyboard nav: arrow keys to move through results, Enter to select
  searchInput.addEventListener("keydown", (e) => {
    const buttons = Array.from(resultsContainer.querySelectorAll<HTMLElement>(".result"));
    if (buttons.length === 0) return;
    const currentIdx = selectedResult
      ? buttons.findIndex((b) =>
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

  // Click handler for results (delegated)
  function attachResultHandlers() {
    const buttons = resultsContainer.querySelectorAll<HTMLElement>(".result");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.kind as "lake" | "stream";
        const name = btn.dataset.name!;
        const county = btn.dataset.county!;
        // Find the result object to get source_page
        const results = search(currentQuery, data, 50);
        const result = results.find((r) => r.name === name && r.county === county && r.kind === kind);
        if (!result) return;
        selectedResult = result;
        buttons.forEach((b) => b.setAttribute("aria-selected", "false"));
        btn.setAttribute("aria-selected", "true");
        detailContainer.innerHTML = `<div class="detail">${renderDetailForResult(result, data)}</div>`;
        // Scroll the detail panel into view on mobile
        if (window.innerWidth < 880) {
          detailContainer.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  }
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
