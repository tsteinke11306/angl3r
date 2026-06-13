#!/usr/bin/env python3
"""
Map CHANGES-UM historical fish survey data (FISHc + SUMM + GROW) to angl3r waterbodies.
Produces species-by-waterbody data that can be merged into regs.json.

Dataset: Zenodo DOI 10.5281/zenodo.15389937
License: CC BY 4.0
"""

import argparse
import csv
import io
import json
import os
import re
import zipfile
from collections import defaultdict
from difflib import SequenceMatcher

SPECIES_COLS = [
    'banded_killifish', 'black_bullhead', 'black_crappie', 'blackchin_shiner',
    'blacknose_shiner', 'bluegill', 'bluntnose_minnow', 'bowfin', 'brook_silverside',
    'brook_trout', 'brown_bullhead', 'brown_trout', 'bullhead_species', 'cisco',
    'common_carp', 'common_shiner', 'golden_shiner', 'grass_pickerel', 'iowa_darter',
    'johnny_darter', 'lake_chubsucker', 'largemouth_bass', 'longnose_gar',
    'mimic_shiner', 'northern_pike', 'pumpkinseed', 'rainbow_trout', 'rock_bass',
    'smallmouth_bass', 'spotted_gar', 'walleye', 'white_sucker', 'yellow_bullhead',
    'yellow_perch'
]

SPECIES_NAME_MAP = {
    'banded_killifish': 'Banded Killifish',
    'black_bullhead': 'Black Bullhead',
    'black_crappie': 'Black Crappie',
    'blackchin_shiner': 'Blackchin Shiner',
    'blacknose_shiner': 'Blacknose Shiner',
    'bluegill': 'Bluegill',
    'bluntnose_minnow': 'Bluntnose Minnow',
    'bowfin': 'Bowfin',
    'brook_silverside': 'Brook Silverside',
    'brook_trout': 'Brook Trout',
    'brown_bullhead': 'Brown Bullhead',
    'brown_trout': 'Brown Trout',
    'bullhead_species': 'Bullhead (unspecified)',
    'cisco': 'Cisco',
    'common_carp': 'Common Carp',
    'common_shiner': 'Common Shiner',
    'golden_shiner': 'Golden Shiner',
    'grass_pickerel': 'Grass Pickerel',
    'iowa_darter': 'Iowa Darter',
    'johnny_darter': 'Johnny Darter',
    'lake_chubsucker': 'Lake Chubsucker',
    'largemouth_bass': 'Largemouth Bass',
    'longnose_gar': 'Longnose Gar',
    'mimic_shiner': 'Mimic Shiner',
    'northern_pike': 'Northern Pike',
    'pumpkinseed': 'Pumpkinseed',
    'rainbow_trout': 'Rainbow Trout',
    'rock_bass': 'Rock Bass',
    'smallmouth_bass': 'Smallmouth Bass',
    'spotted_gar': 'Spotted Gar',
    'walleye': 'Walleye',
    'white_sucker': 'White Sucker',
    'yellow_bullhead': 'Yellow Bullhead',
    'yellow_perch': 'Yellow Perch'
}

# GROW species mapping (snake_case -> display name)
GROW_SPECIES_MAP = {
    'bluegill': 'Bluegill',
    'yellow_perch': 'Yellow Perch',
    'largemouth_bass': 'Largemouth Bass',
    'northern_pike': 'Northern Pike',
    'pumpkinseed': 'Pumpkinseed',
    'black_crappie': 'Black Crappie',
    'walleye': 'Walleye',
    'rock_bass': 'Rock Bass',
    'smallmouth_bass': 'Smallmouth Bass',
    'cisco': 'Cisco',
    'white_sucker': 'White Sucker',
    'rainbow_trout': 'Rainbow Trout',
    'brown_trout': 'Brown Trout',
    'brook_trout': 'Brook Trout',
    'lake_trout': 'Lake Trout',
    'tiger_muskie': 'Tiger Muskellunge',
    'muskellunge': 'Muskellunge',
    'green_sunfish': 'Green Sunfish',
    'splake': 'Splake',
    'lake_whitefish': 'Lake Whitefish',
    'hybrid_sunfish': 'Hybrid Sunfish',
    'redear_sunfish': 'Redear Sunfish',
    'rainbow_smelt': 'Rainbow Smelt',
    'white_crappie': 'White Crappie',
    'warmouth': 'Warmouth',
    'common_carp': 'Common Carp',
    'white_bass': 'White Bass',
    'northern_longear_sunfish': 'Northern Longear Sunfish',
    'coho_salmon': 'Coho Salmon',
    'round_whitefish': 'Round Whitefish',
    'chinook_salmon': 'Chinook Salmon',
    'sauger': 'Sauger',
    'lake_sturgeon': 'Lake Sturgeon',
    'freshwater_drum': 'Freshwater Drum',
    'brown_bullhead': 'Brown Bullhead',
    'burbot': 'Burbot',
}

DIRECTIONAL_WORDS = {'upper', 'lower', 'north', 'south', 'east', 'west',
                     'big', 'little', 'upperlower', 'northsouth', 'new', 'old'}


def normalize_name(name):
    name = name.strip().lower()
    name = re.sub(r'\s*\([^)]*\)', '', name)
    name = re.sub(r'\s+(lake|pond|reservoir|dam|pool|marsh|swamp|basin|river|creek|'
                  r'stream|bay|harbor|channel|impoundment|slough)(s)?$', '', name)
    name = re.sub(r"['']s\b", '', name)
    name = name.replace("'", "").replace("'", "")
    name = re.sub(r'\b(of michigan|in michigan|county|township|michigan)\b', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    alpha_only = re.sub(r'[^a-z0-9]', '', name)
    return name, alpha_only


def expand_variations(name):
    base, alpha = normalize_name(name)
    variations = {base, alpha}
    parts = re.split(r'[-\s]', base)
    for part in parts:
        part = part.strip()
        if len(part) > 2 and part not in DIRECTIONAL_WORDS:
            variations.add(part)
            variations.add(re.sub(r'[^a-z0-9]', '', part))
    for direction in ['upper', 'lower', 'north', 'south', 'east', 'west', 'big', 'little']:
        if base.startswith(direction + ' '):
            remainder = base[len(direction):].strip()
            variations.add(remainder)
            variations.add(re.sub(r'[^a-z0-9]', '', remainder))
            variations.add(direction + re.sub(r'[^a-z0-9]', '', remainder))
    if 'chain' in base:
        chain_parts = re.split(r'[-\s]', base)
        for part in chain_parts:
            if len(part) > 2 and part not in {'of', 'lakes', 'lake', 'chain'}:
                variations.add(part)
    return variations


def load_summ_fishc_data(zip_path, dataset):
    """Load SUMM or FISHc survey data."""
    lake_species = defaultdict(lambda: {
        'species': set(),
        'extras': set(),
        'records': 0,
        'years': set(),
        'dataset': dataset,
    })

    if dataset == 'summ':
        path = 'CHANGES-UM-summ_fishc_grow-8415f9f/Lake_SUMM/summ_data_Apr2025.csv'
        encoding = 'utf-8'
        fish_cols = SPECIES_COLS
    else:
        path = 'CHANGES-UM-summ_fishc_grow-8415f9f/FISHc/FISHc_data/final_data/fishc_qaqc_Apr2025.csv'
        encoding = 'latin-1'
        fish_cols = SPECIES_COLS

    with zipfile.ZipFile(zip_path, 'r') as z:
        with z.open(path) as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding=encoding))
            for row in reader:
                county = row['county'].strip().title()
                lake = row['lakename'].strip().title()
                key = (county, lake)

                lake_species[key]['records'] += 1
                lake_species[key]['dataset'] = dataset

                year = row.get('begin_date_year', '').strip()
                if year and year != 'NA':
                    lake_species[key]['years'].add(year)

                for col in fish_cols:
                    if row.get(col) == '1':
                        lake_species[key]['species'].add(SPECIES_NAME_MAP[col])

                extras = row.get('fish_extras', '').strip()
                if extras and extras != 'NA':
                    lake_species[key]['extras'].add(extras)

    return lake_species


def load_grow_data(zip_path):
    """Load GROW growth-measurement data. Each record has one species."""
    lake_species = defaultdict(lambda: {
        'species': set(),
        'extras': set(),
        'records': 0,
        'years': set(),
        'dataset': 'grow',
    })

    path = 'CHANGES-UM-summ_fishc_grow-8415f9f/GROW_general/grow_qaqc_Apr2025.csv'

    with zipfile.ZipFile(zip_path, 'r') as z:
        with z.open(path) as f:
            reader = csv.DictReader(io.TextIOWrapper(f))
            for row in reader:
                county = row['county'].strip().title()
                lake = row['lakename'].strip().title()
                key = (county, lake)

                lake_species[key]['records'] += 1
                lake_species[key]['dataset'] = 'grow'

                year = row.get('begin_date_year', '').strip()
                if year and year != 'NA':
                    lake_species[key]['years'].add(year)

                sp = row.get('species', '').strip()
                if sp and sp != 'NA' and sp in GROW_SPECIES_MAP:
                    lake_species[key]['species'].add(GROW_SPECIES_MAP[sp])

    return lake_species


def merge_datasets(summ_data, fishc_data, grow_data):
    """Merge all three datasets, preferring SUMM > FISHc > GROW."""
    merged = {}

    # Start with all GROW data (lowest priority)
    for key, data in grow_data.items():
        merged[key] = dict(data)
        merged[key]['species'] = set(data['species'])
        merged[key]['extras'] = set(data['extras'])

    # Overlay FISHc data
    for key, data in fishc_data.items():
        if key not in merged:
            merged[key] = dict(data)
            merged[key]['species'] = set(data['species'])
            merged[key]['extras'] = set(data['extras'])
        else:
            # Merge extras, keep FISHc dataset marker but add GROW species
            merged[key]['species'].update(data['species'])
            merged[key]['extras'].update(data['extras'])
            merged[key]['records'] += data['records']
            merged[key]['years'].update(data['years'])
            merged[key]['dataset'] = 'fishc'

    # Overlay SUMM data (highest priority)
    for key, data in summ_data.items():
        if key not in merged:
            merged[key] = dict(data)
            merged[key]['species'] = set(data['species'])
            merged[key]['extras'] = set(data['extras'])
        else:
            merged[key]['species'].update(data['species'])
            merged[key]['extras'].update(data['extras'])
            merged[key]['records'] += data['records']
            merged[key]['years'].update(data['years'])
            merged[key]['dataset'] = 'summ'

    return merged


def find_best_match(wb_name, wb_county, ds_lakes):
    wb_variations = expand_variations(wb_name)
    wb_main_alpha = normalize_name(wb_name)[1]

    best_match = None
    best_score = 0

    for (ds_county, ds_lake), ds_data in ds_lakes.items():
        if ds_county != wb_county:
            continue

        ds_variations = expand_variations(ds_lake)
        ds_main_alpha = normalize_name(ds_lake)[1]

        # Strategy 1: Exact alpha match
        if wb_main_alpha == ds_main_alpha:
            return (ds_lake, ds_data, 1.0)

        # Strategy 2: Variation overlap
        overlap = wb_variations & ds_variations
        if overlap:
            longest_match = max(overlap, key=len)
            score = min(1.0, len(longest_match) / max(len(wb_main_alpha), len(ds_main_alpha)) * 1.2)
            if score > best_score:
                best_score = score
                best_match = (ds_lake, ds_data, score)
            continue

        # Strategy 3: Substring with length sanity
        if wb_main_alpha in ds_main_alpha or ds_main_alpha in wb_main_alpha:
            ratio = min(len(wb_main_alpha), len(ds_main_alpha)) / max(len(wb_main_alpha), len(ds_main_alpha))
            if ratio >= 0.5:
                score = 0.85
                if score > best_score:
                    best_score = score
                    best_match = (ds_lake, ds_data, score)
                continue

        # Strategy 4: Fuzzy
        score = SequenceMatcher(None, wb_main_alpha, ds_main_alpha).ratio()
        if score > best_score and score >= 0.75:
            best_score = score
            best_match = (ds_lake, ds_data, score)

    return best_match


def build_species_by_waterbody(regs_json_path, survey_zip_path, target_county=None):
    with open(regs_json_path) as f:
        regs = json.load(f)

    # Load manual name corrections
    manual_mapping = {}
    manual_path = os.path.join(os.path.dirname(regs_json_path), '..', 'references', 'manual_lake_name_mapping.json')
    if os.path.exists(manual_path):
        with open(manual_path) as f:
            raw = json.load(f)
        for county, lakes in raw.items():
            if county.startswith('_'):
                continue
            for our_name, ds_name in lakes.items():
                manual_mapping[(county, our_name)] = ds_name
        print(f"Loaded {len(manual_mapping)} manual name corrections")

    # Load all datasets
    print("Loading SUMM dataset...")
    summ_data = load_summ_fishc_data(survey_zip_path, 'summ')
    print(f"  SUMM: {len(summ_data)} unique lakes")

    print("Loading FISHc dataset...")
    fishc_data = load_summ_fishc_data(survey_zip_path, 'fishc')
    print(f"  FISHc: {len(fishc_data)} unique lakes")

    print("Loading GROW dataset...")
    grow_data = load_grow_data(survey_zip_path)
    print(f"  GROW: {len(grow_data)} unique lakes")

    merged_data = merge_datasets(summ_data, fishc_data, grow_data)
    print(f"  Combined: {len(merged_data)} unique lakes")

    # Pre-group by county
    ds_by_county = defaultdict(dict)
    for (county, lake), data in merged_data.items():
        ds_by_county[county][(county, lake)] = data

    result = defaultdict(dict)
    stats = {'matched': 0, 'unmatched': 0, 'no_species_data': 0, 'manual': 0, 'summ': 0, 'fishc': 0, 'grow': 0}

    for wb in regs['waterbodies']:
        if target_county and wb['county'] != target_county:
            continue
        if wb['kind'] not in ('lake', 'pond'):
            continue

        # Skip PDF parsing artifacts
        bad_patterns = ['list of lakes', 'upstream limit', 'downstream limit',
                       'feet downstream', 'power line crossing',
                       'include more than one', 'from dam to',
                       'r32w', 't56n', 'whenever weir is in place']
        wb_lower = wb['name'].lower()
        skip = False
        for pattern in bad_patterns:
            if pattern in wb_lower:
                skip = True
                break
        if skip:
            result[wb['county']][wb['name']] = {
                'species': [],
                'extras': [],
                'source': None,
                'note': 'Not a real waterbody (PDF parsing artifact)'
            }
            stats['unmatched'] += 1
            continue

        ds_lakes_for_county = ds_by_county.get(wb['county'], {})

        manual_ds_name = manual_mapping.get((wb['county'], wb['name']))
        if manual_ds_name:
            for (ds_county, ds_lake), ds_data in ds_lakes_for_county.items():
                if ds_lake == manual_ds_name:
                    match = (ds_lake, ds_data, 1.0)
                    stats['manual'] += 1
                    break
            else:
                match = None
        else:
            match = find_best_match(wb['name'], wb['county'], ds_lakes_for_county)

        if match:
            ds_lake, ds_data, score = match

            # Skip low-confidence matches
            if score < 0.5:
                match = None

        if match:
            ds_lake, ds_data, score = match
            species = sorted(ds_data['species'])
            extras = sorted(ds_data['extras'])

            entry = {
                'dataset_match': ds_lake,
                'match_score': round(score, 2),
                'survey_records': ds_data['records'],
                'survey_years': sorted(ds_data['years']) if ds_data['years'] else [],
                'species': species,
                'extras': extras,
                'source': 'changes-um-zenodo',
                'dataset': ds_data.get('dataset', 'unknown')
            }

            if not species and not extras:
                stats['no_species_data'] += 1

            dataset = ds_data.get('dataset', 'unknown')
            if dataset in stats:
                stats[dataset] += 1

            result[wb['county']][wb['name']] = entry
            stats['matched'] += 1
        else:
            result[wb['county']][wb['name']] = {
                'species': [],
                'extras': [],
                'source': None,
                'note': 'No historical survey data available'
            }
            stats['unmatched'] += 1

    return dict(result), stats


def main():
    parser = argparse.ArgumentParser(
        description='Map CHANGES-UM fish survey data (FISHc + SUMM + GROW) to angl3r waterbodies'
    )
    parser.add_argument('--regs', default='data/regs.json',
                        help='Path to regs.json')
    parser.add_argument('--survey-zip', default='/tmp/summ_fishc_grow.zip',
                        help='Path to CHANGES-UM Zenodo ZIP')
    parser.add_argument('--county', default=None,
                        help='Process only one county (default: all)')
    parser.add_argument('--output', default='public/data/species_by_waterbody.json',
                        help='Output JSON file')
    parser.add_argument('--inject', action='store_true',
                        help='Inject result into regs.json')
    args = parser.parse_args()

    result, stats = build_species_by_waterbody(
        args.regs, args.survey_zip, args.county
    )

    print(f"\nResults:")
    print(f"  Waterbodies matched: {stats['matched']}")
    print(f"    From SUMM: {stats['summ']}")
    print(f"    From FISHc: {stats['fishc']}")
    print(f"    From GROW: {stats['grow']}")
    print(f"    From manual mapping: {stats['manual']}")
    print(f"  Waterbodies unmatched: {stats['unmatched']}")
    print(f"  Matched but no species data: {stats['no_species_data']}")

    if not args.inject:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\nWrote {args.output}")

    if args.inject:
        with open(args.regs) as f:
            regs = json.load(f)

        regs['species_by_waterbody'] = result
        if 'meta' not in regs:
            regs['meta'] = {}
        regs['meta']['survey_source'] = {
            'title': 'CHANGES-UM Historical Fish Survey Data',
            'publisher': 'University of Michigan / Michigan DNR',
            'doi': '10.5281/zenodo.15389937',
            'license': 'CC BY 4.0',
            'description': '78 years of digitized fish presence/absence data for Michigan lakes (FISHc + SUMM + GROW datasets)'
        }

        with open(args.regs, 'w') as f:
            json.dump(regs, f, indent=2)
        print(f"Injected into {args.regs}")


if __name__ == '__main__':
    main()
