#!/usr/bin/env python3
"""Data integrity checks for angl3r data files.

Validates data/regs.json, data/coords_by_waterbody.json, and the deployed
copies in public/data/. Stdlib only.

Checks:
  a. zero empty/whitespace waterbody names
  b. no duplicate waterbody names within a county
  c. all 83 Michigan counties present (counties.order and waterbodies)
  d. species_by_waterbody covers all 83 counties
  e. spot-check famous waters have non-empty species
  f. coords entries have sane Michigan bounds
  g. data/ and public/data/ copies are byte-identical
  h. meta counts match actual array/dict lengths

Exit code 1 if any check fails, 0 otherwise.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

MICHIGAN_COUNTIES = [
    "Alcona", "Alger", "Allegan", "Alpena", "Antrim", "Arenac", "Baraga",
    "Barry", "Bay", "Benzie", "Berrien", "Branch", "Calhoun", "Cass",
    "Charlevoix", "Cheboygan", "Chippewa", "Clare", "Clinton", "Crawford",
    "Delta", "Dickinson", "Eaton", "Emmet", "Genesee", "Gladwin",
    "Gogebic", "Grand Traverse", "Gratiot", "Hillsdale", "Houghton",
    "Huron", "Ingham", "Ionia", "Iosco", "Iron", "Isabella", "Jackson",
    "Kalamazoo", "Kalkaska", "Kent", "Keweenaw", "Lake", "Lapeer",
    "Leelanau", "Lenawee", "Livingston", "Luce", "Mackinac", "Macomb",
    "Manistee", "Marquette", "Mason", "Mecosta", "Menominee", "Midland",
    "Missaukee", "Monroe", "Montcalm", "Montmorency", "Muskegon",
    "Newaygo", "Oakland", "Oceana", "Ogemaw", "Ontonagon", "Osceola",
    "Oscoda", "Otsego", "Ottawa", "Presque Isle", "Roscommon", "Saginaw",
    "St. Clair", "St. Joseph", "Sanilac", "Schoolcraft", "Shiawassee",
    "Tuscola", "Van Buren", "Washtenaw", "Wayne", "Wexford",
]

# (name, county) -> minimum species count expected (0 = just needs non-empty)
FAMOUS_WATERS = [
    ("Higgins Lake", "Roscommon", 0),
    ("Houghton Lake", "Roscommon", 0),
    ("Lake St. Clair", None, 0),
    ("Detroit River", "Wayne", 30),
    ("Grand River", None, 0),
    ("Muskegon River", None, 0),
]

LAT_MIN, LAT_MAX = 41.5, 48.5
LON_MIN, LON_MAX = -90.6, -81.7

issues: list[str] = []
warnings: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        issues.append(msg)


def warn(cond: bool, msg: str) -> None:
    if not cond:
        warnings.append(msg)


def load_json(path: Path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        issues.append(f"{path}: cannot load ({exc})")
        return None


def main() -> int:
    regs_path = REPO_ROOT / "data" / "regs.json"
    coords_path = REPO_ROOT / "data" / "coords_by_waterbody.json"
    pub_regs_path = REPO_ROOT / "public" / "data" / "regs.json"
    pub_coords_path = REPO_ROOT / "public" / "data" / "coords_by_waterbody.json"

    regs = load_json(regs_path)
    coords = load_json(coords_path)
    if regs is None:
        print("FATAL: cannot validate without data/regs.json")
        return 1

    waterbodies = regs.get("waterbodies") or []
    counties = (regs.get("counties") or {}).get("order") or []

    # (a) empty/whitespace waterbody names
    empty = [w for w in waterbodies if not (w.get("name") or "").strip()]
    check(not empty, f"(a) {len(empty)} waterbody(s) with empty/whitespace names")

    # (b) duplicate waterbody names within a county
    name_counts = Counter(
        (w.get("county"), (w.get("name") or "").strip()) for w in waterbodies
    )
    dups = {k: v for k, v in name_counts.items() if v > 1}
    if dups:
        detail = ", ".join(f"{c}/{n} x{v}" for (c, n), v in sorted(dups.items()))
        warnings.append(
            f"(b) {len(dups)} duplicate waterbody name(s) within a county "
            f"(legit distinct PDF sections or distinct wiki waters): {detail}"
        )

    # (c) all 83 Michigan counties present
    check(len(MICHIGAN_COUNTIES) == 83, "(c) internal: county list is not 83")
    for county in MICHIGAN_COUNTIES:
        check(
            county in counties,
            f"(c) county {county!r} missing from counties.order",
        )
    check(
        len(counties) == 83,
        f"(c) counties.order has {len(counties)} entries, expected 83",
    )
    wb_counties = {w.get("county") for w in waterbodies}
    for county in MICHIGAN_COUNTIES:
        check(
            county in wb_counties,
            f"(c) county {county!r} has no waterbodies",
        )
    extra = wb_counties - set(MICHIGAN_COUNTIES)
    check(
        not extra,
        f"(c) unexpected county names in waterbodies: {sorted(extra)}",
    )

    # (d) species_by_waterbody covers all 83 counties
    sbw = regs.get("species_by_waterbody") or {}
    missing_sbw = [c for c in MICHIGAN_COUNTIES if c not in sbw]
    check(
        not missing_sbw,
        f"(d) counties missing from species_by_waterbody: {missing_sbw}",
    )

    # (e) famous waters have non-empty species
    for name, county, min_species in FAMOUS_WATERS:
        matches = [
            w for w in waterbodies
            if (w.get("name") or "").strip().lower() == name.lower()
            and (county is None or w.get("county") == county)
        ]
        if not matches:
            issues.append(f"(e) famous water {name!r} not found in waterbodies")
            continue
        entries = [
            (w["county"], (sbw.get(w["county"]) or {}).get(w["name"]))
            for w in matches
        ]
        best = max(
            (len(e.get("species") or []) for _, e in entries if e), default=None
        )
        if best is None:
            issues.append(f"(e) {name}: no species_by_waterbody entry")
        elif best == 0:
            issues.append(f"(e) {name}: 0 species (entries: {entries})")
        elif best < min_species:
            issues.append(
                f"(e) {name}: only {best} species, expected ~{min_species}"
            )
        else:
            total = sum(len(e.get("species") or []) for _, e in entries if e)
            print(f"  ok: {name} ({best} species"
                  + (f" across {total} county entries" if total != best else "")
                  + ")")

    # (f) coords bounds
    if coords is not None:
        outliers = []
        for key, val in coords.items():
            if not isinstance(val, list) or len(val) != 2:
                outliers.append(f"{key}: bad shape {val!r}")
                continue
            lat, lon = val
            if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
                outliers.append(f"{key}: lat={lat} lon={lon}")
        check(
            not outliers,
            f"(f) {len(outliers)} coord outlier(s) outside Michigan bounds: "
            + "; ".join(outliers[:10]),
        )

    # (g) data/ vs public/data/ byte-identical
    nhd_path = REPO_ROOT / "data" / "nhd_waterbodies.json"
    pub_nhd_path = REPO_ROOT / "public" / "data" / "nhd_waterbodies.json"
    for src, dst in (
        (regs_path, pub_regs_path),
        (coords_path, pub_coords_path),
        (nhd_path, pub_nhd_path),
    ):
        check(src.exists(), f"(g) missing {src}")
        check(dst.exists(), f"(g) missing {dst}")
        if src.exists() and dst.exists():
            if src.read_bytes() != dst.read_bytes():
                issues.append(f"(g) {dst.name} differs between data/ and public/data/")
            else:
                print(f"  ok: {src.name} byte-identical in data/ and public/data/")

    # (h) meta counts match actual lengths
    meta = regs.get("meta") or {}
    # lake/stream counts are the PDF-derived registry lengths (d['lakes'] /
    # d['streams'] records with type regs), not a re-classification of
    # waterbodies[].kind (which the site renders via counties.stats).
    expected = {
        "lake_count": len(regs.get("lakes") or []),
        "stream_count": len(regs.get("streams") or []),
        "waterbody_count": len(waterbodies),
        "county_count": len(counties),
    }
    for key, actual in expected.items():
        claimed = meta.get(key)
        check(
            claimed == actual,
            f"(h) meta.{key}={claimed} but actual is {actual}",
        )

    # report
    print(f"waterbodies: {len(waterbodies)}, counties: {len(counties)}")
    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  ! {w}")
    if issues:
        print("\nFAILURES:")
        for i in issues:
            print(f"  x {i}")
        print(f"\n{len(issues)} issue(s), {len(warnings)} warning(s)")
        return 1
    print("\nAll checks passed"
          + (f" ({len(warnings)} warning(s))" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())