// Search and match logic — pure functions, no DOM access.

import type { Lake, Stream, RegsData } from "./types";

/** A single search result that can be a lake or a stream. */
export interface Result {
  kind: "lake" | "stream";
  name: string;
  county: string;
  type: string;
  source_page: number;
  /** Match quality: 0 = perfect, higher = worse. Used for ranking. */
  matchDistance: number;
  /** The matched substring (for highlighting). */
  matchedField: "name" | "county";
}

/**
 * Search the data for entries matching the query. Matches both lakes and
 * streams. Uses a simple ranking:
 *   - exact match → 0
 *   - prefix match → 1
 *   - substring match → 2
 *   - fuzzy (Levenshtein ≤ 2) → 3
 * County matches rank below name matches.
 */
export function search(query: string, data: RegsData, limit = 50): Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: Result[] = [];

  for (const lake of data.lakes) {
    const r = score(lake.name, q, "name");
    const rc = score(lake.county, q, "county");
    const best = pickBest(r, rc);
    if (best) {
      results.push({
        kind: "lake",
        name: lake.name,
        county: lake.county,
        type: lake.type,
        source_page: lake.source_page,
        matchDistance: best.distance,
        matchedField: best.field,
      });
    }
  }

  for (const stream of data.streams) {
    const r = score(stream.name, q, "name");
    const rc = score(stream.county, q, "county");
    const best = pickBest(r, rc);
    if (best) {
      results.push({
        kind: "stream",
        name: stream.name,
        county: stream.county,
        type: stream.type,
        source_page: stream.source_page,
        matchDistance: best.distance,
        matchedField: best.field,
      });
    }
  }

  // Sort: name matches first, then by distance, then alphabetically
  results.sort((a, b) => {
    if (a.matchedField !== b.matchedField) {
      return a.matchedField === "name" ? -1 : 1;
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

/** Look up the (name, county) combination in the data; return the full record. */
export function findExact(
  data: RegsData,
  kind: "lake" | "stream",
  name: string,
  county: string
): Lake | Stream | null {
  const arr = kind === "lake" ? data.lakes : data.streams;
  return arr.find((x) => x.name === name && x.county === county) ?? null;
}
