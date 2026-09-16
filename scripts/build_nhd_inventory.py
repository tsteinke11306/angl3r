#!/usr/bin/env python3
"""
Build data/nhd_waterbodies.json from the USGS NHD Michigan state GDB.

Produces the "complete named waters" inventory: every named lake,
reservoir, river, creek, and drain in Michigan (1:24,000 NHD), deduped
against regs.json (existing site records win — they carry regs/species
data). Names + geometry only; no species or regulation data. The site
lazy-loads this file; it is NOT merged into regs.json.

Usage:
  python3 scripts/build_nhd_inventory.py [--gdb-zip /tmp/NHD_H_Michigan_State_GDB.zip]

Requirements: fiona, shapely  (pip3 install fiona shapely)

Pipeline:
  1. NHDWaterbody polygons  -> named lakes/reservoirs (ftype 390/436),
     county set = counties whose polygons the feature intersects
  2. NHDFlowline paths      -> named streams (ftype 460/558/336),
     county set = union over segment midpoints
  3. Drop features with no county (verified: these are out-of-state
     border artifacts of the state GDB)
  4. Dedup (name, county) pairs already present in regs.json
  5. Emit data/ + public/data/ JSON + a .gz for the lazy fetch
"""

import argparse
import gzip
import json
import os
import pickle
import re
import subprocess
import sys
import tempfile
import urllib.request
from collections import defaultdict

NHD_URL = ("https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/"
           "NHD/State/GDB/NHD_H_Michigan_State_GDB.zip")
BAD_NAME = re.compile(r"^(unnamed|unknown)", re.I)
LAKE_FTYPES = {390, 436}          # LakePond, Reservoir
STREAM_FTYPES = {460, 558, 336}   # StreamRiver, ArtificialPath, CanalDitch


def download_if_missing(zip_path: str) -> None:
    if os.path.exists(zip_path) and os.path.getsize(zip_path) > 300_000_000:
        print(f"using existing {zip_path}")
        return
    print(f"downloading {NHD_URL} (~389MB)...")
    req = urllib.request.Request(NHD_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(zip_path, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    print("download complete")


def extract_gdb(zip_path: str) -> str:
    gdb_path = zip_path.replace(".zip", ".gdb")
    if os.path.exists(gdb_path):
        return gdb_path
    dest = os.path.dirname(zip_path)
    print("extracting...")
    subprocess.run(["unzip", "-o", "-q", zip_path, "-d", dest], check=True)
    return gdb_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gdb-zip", default="/tmp/NHD_H_Michigan_State_GDB.zip")
    parser.add_argument("--regs", default="data/regs.json")
    parser.add_argument("--out-data", default="data/nhd_waterbodies.json")
    parser.add_argument("--out-public", default="public/data/nhd_waterbodies.json")
    parser.add_argument("--cache-dir", default="/tmp")
    args = parser.parse_args()

    try:
        import fiona  # noqa: F401
        from shapely.geometry import shape
        from shapely.strtree import STRtree
        from shapely.ops import unary_union
    except ImportError:
        print("pip3 install fiona shapely", file=sys.stderr)
        return 1

    download_if_missing(args.gdb_zip)
    gdb = extract_gdb(args.gdb_zip)

    with open("public/data/mi-counties-geojson.json") as f:
        gj = json.load(f)
    county_geoms = [shape(feat["geometry"]) for feat in gj["features"]]
    county_names = [feat["properties"]["name"] for feat in gj["features"]]
    ctree = STRtree(county_geoms)

    def counties_for_geom(geom):
        out = set()
        try:
            idxs = ctree.query(geom)
        except Exception:
            return out
        for i in idxs:
            g = county_geoms[i]
            try:
                if geom.intersects(g):
                    out.add(county_names[i])
            except Exception:
                continue
        return out

    with open(args.regs) as f:
        site_pairs = set((w["name"], w["county"]) for w in json.load(f)["waterbodies"])

    # ---- lakes -----------------------------------------------------------
    cache = os.path.join(args.cache_dir, "nhd_lakes_final.pkl")
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            lakes = pickle.load(f)
        print(f"loaded {len(lakes)} lakes from cache")
    else:
        agg = defaultdict(lambda: {"counties": set(), "area_sqkm": 0.0, "pt": None})
        with fiona.open(gdb, layer="NHDWaterbody") as src:
            for feat in src:
                p = feat["properties"]
                name = (p["gnis_name"] or "").strip()
                if not name or BAD_NAME.match(name) or p["ftype"] not in LAKE_FTYPES:
                    continue
                geom = shape(feat["geometry"])
                rec = agg[name]
                rec["counties"] |= counties_for_geom(geom)
                a = p["areasqkm"] or 0
                if a > rec["area_sqkm"]:
                    rec["area_sqkm"] = a
                    c = geom.centroid
                    rec["pt"] = (round(c.y, 5), round(c.x, 5))
        lakes = {k: {**v, "counties": sorted(v["counties"])}
                 for k, v in agg.items() if v["counties"]}
        with open(cache, "wb") as f:
            pickle.dump(lakes, f)
        print(f"extracted {len(lakes)} in-state named lakes")

    # ---- streams -----------------------------------------------------------
    cache = os.path.join(args.cache_dir, "nhd_streams_final.pkl")
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            streams = pickle.load(f)
        print(f"loaded {len(streams)} streams from cache")
    else:
        agg = defaultdict(lambda: {"counties": set(), "km": 0.0, "pt": None,
                                   "ftypes": set()})
        with fiona.open(gdb, layer="NHDFlowline") as src:
            for feat in src:
                p = feat["properties"]
                name = (p["gnis_name"] or "").strip()
                if not name or BAD_NAME.match(name) or p["ftype"] not in STREAM_FTYPES:
                    continue
                geom = shape(feat["geometry"])
                rec = agg[name]
                rec["km"] += p["lengthkm"] or 0
                rec["ftypes"].add(p["ftype"])
                if rec["pt"] is None and geom.length > 0:
                    c = geom.interpolate(0.5, normalized=True)
                    rec["pt"] = (round(c.y, 5), round(c.x, 5))
                try:
                    mid = geom.interpolate(0.5, normalized=True)
                except Exception:
                    continue
                for i in ctree.query(mid):
                    if county_geoms[i].contains(mid):
                        rec["counties"].add(county_names[i])
                        break
        streams = {k: {**v, "counties": sorted(v["counties"]),
                       "ftypes": sorted(v["ftypes"])}
                   for k, v in agg.items() if v["counties"]}
        with open(cache, "wb") as f:
            pickle.dump(streams, f)
        print(f"extracted {len(streams)} in-state named streams")

    # ---- records -----------------------------------------------------------
    records = []
    for name, v in lakes.items():
        for co in v["counties"]:
            rec = {
                "name": name, "county": co, "kind": "lake", "source": "nhd",
                "area_sqkm": round(v["area_sqkm"], 4),
                "note": ("Named feature from USGS NHD. Statewide regulations "
                         "apply; no lake-specific survey data."),
            }
            if v["pt"]:
                rec["lat"], rec["lon"] = v["pt"]
            records.append(rec)

    def stream_kind(v, name):
        # Prefer the feature's own name suffix; fall back to length.
        low = name.lower()
        if low.endswith(("creek", "drain", "brook", "ditch", "run")):
            return "creek"
        if low.endswith("river"):
            return "river"
        return "river" if v["km"] >= 30 else "creek"

    for name, v in streams.items():
        for co in v["counties"]:
            rec = {
                "name": name, "county": co, "kind": stream_kind(v, name),
                "source": "nhd", "length_km": round(v["km"], 1),
                "nhd_ftypes": v["ftypes"],
                "note": ("Named feature from USGS NHD. Statewide regulations "
                         "apply; no survey data for this water."),
            }
            if v["pt"]:
                rec["lat"], rec["lon"] = v["pt"]
            records.append(rec)

    new_records = [r for r in records if (r["name"], r["county"]) not in site_pairs]
    print(f"records: {len(records)} total, {len(new_records)} after dedup vs regs.json")

    out = {
        "meta": {
            "source": {
                "title": "USGS National Hydrography Dataset (NHD) — Michigan State Extract",
                "publisher": "U.S. Geological Survey",
                "url": "https://www.usgs.gov/national-hydrography/access-national-hydrography-products",
                "license": "public domain",
                "description": ("Named lakes, reservoirs, rivers, creeks, and "
                                "drains from NHD 1:24,000 hydrography. Names "
                                "and geometry only — no species or regulation "
                                "data. Statewide regulations apply to all waters."),
            },
            "record_count": len(new_records),
            "unique_names": len(set(r["name"] for r in new_records)),
        },
        "waterbodies": sorted(new_records, key=lambda r: (r["county"], r["name"])),
    }

    os.makedirs(os.path.dirname(args.out_data), exist_ok=True)
    with open(args.out_data, "w") as f:
        json.dump(out, f, indent=1)
    with open(args.out_public, "w") as f:
        json.dump(out, f, indent=1)
    with open(args.out_public + ".gz", "wb") as f:
        f.write(gzip.compress(json.dumps(out).encode(), 9))
    sizes = {p: os.path.getsize(p) for p in
             (args.out_data, args.out_public, args.out_public + ".gz")}
    for p, s in sizes.items():
        print(f"wrote {p}: {s:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())