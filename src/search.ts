// Search and match logic — pure functions, no DOM access.

import type { RegsData, Waterbody } from "./types";

/** A single search result — represents any waterbody from either the
 * PDF trout/salmon listings or the Wikipedia named-waterbodies list. */
export interface Result {
  kind: "lake" | "river" | "stream" | "creek" | "pond" | "bay" | "harbor" | "channel";
  name: string;
  county: string;
  /** "pdf" = trout/salmon water with specific regs, "wikipedia" = named body, general regs apply */
  source: "pdf" | "wikipedia";
  /** For PDF entries: the Type code (A-F, 1-4, GR, BTRA, SC). For Wikipedia: undefined. */
  type?: string;
  /** PDF source page. Undefined for Wikipedia. */
  source_page?: number;
  /** Stream section description (for PDF streams). Undefined for lakes. */
  section?: string;
  /** Stream seasonal closure (for PDF streams). Undefined for lakes. */
  closure?: string;
  /** Wikipedia article title (if known). Used for linking. */
  wikipedia_title?: string;
  /** Match quality: 0 = perfect, higher = worse. Used for ranking. */
  matchDistance: number;
  /** The matched substring (for highlighting). */
  matchedField: "name" | "county";
}

/**
 * Search the data for entries matching the query. Matches all waterbodies
 * (from both PDF and Wikipedia). Uses a simple ranking:
 *   - exact match → 0
 *   - prefix match → 1
 *   - substring match → 2
 *   - fuzzy (Levenshtein ≤ 2) → 3
 * County matches rank below name matches.
 *
 * PDF waterbodies (with specific trout regulations) sort to the top of
 * the result list when there's a tie, so the most useful results surface
 * first.
 */
export function search(query: string, data: RegsData, limit = 50): Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: Result[] = [];

  for (const wb of data.waterbodies ?? []) {
    const r = score(wb.name, q, "name");
    const rc = score(wb.county, q, "county");
    const best = pickBest(r, rc);
    if (best) {
      results.push({
        kind: wb.kind as Result["kind"],
        name: wb.name,
        county: wb.county,
        source: wb.source as "pdf" | "wikipedia",
        type: wb.type,
        source_page: wb.pdf_record?.source_page,
        section: wb.section,
        closure: wb.closure,
        wikipedia_title: wb.wikipedia_title,
        matchDistance: best.distance,
        matchedField: best.field,
      });
    }
  }

  // Sort: name matches first, then PDF over Wikipedia (more specific regs),
  // then by distance, then alphabetically.
  results.sort((a, b) => {
    if (a.matchedField !== b.matchedField) {
      return a.matchedField === "name" ? -1 : 1;
    }
    if (a.source !== b.source) {
      return a.source === "pdf" ? -1 : 1;
    }
    if (a.matchDistance !== b.matchDistance) {
      return a.matchDistance - b.matchDistance;
    }
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, limit);
}

interface Score {
  field: "name" | "county";
  distance: number;
}

function score(text: string, q: string, field: "name" | "county"): Score | null {
  const t = text.toLowerCase();
  if (t === q) return { field, distance: 0 };
  if (t.startsWith(q)) return { field, distance: 1 };
  if (t.includes(q)) return { field, distance: 2 };
  // Fuzzy: allow up to 2 char Levenshtein for short queries only
  if (q.length >= 4) {
    const d = levenshtein(t, q, 2);
    if (d <= 2) return { field, distance: 3 + d };
  }
  return null;
}

function pickBest(a: Score | null, b: Score | null): Score | null {
  if (!a) return b;
  if (!b) return a;
  return a.distance <= b.distance ? a : b;
}

/**
 * Bounded Levenshtein distance. Returns the distance, or `max + 1` if it
 * exceeds the bound (so we can early-exit).
 */
function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Two-row DP for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Group results by county for display. */
export function groupByCounty(results: Result[]): Map<string, Result[]> {
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const key = r.county;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return groups;
}

/** Look up a (name, county) combination in the unified waterbodies array. */
export function findExact(
  data: RegsData,
  _kind: string,
  name: string,
  county: string
): Waterbody | null {
  // _kind is unused now since the waterbodies array is unified; we keep
  // the parameter for backward compatibility with existing callers.
  const found = data.waterbodies?.find(
    (x) => x.name === name && x.county === county
  );
  return found ?? null;
}
