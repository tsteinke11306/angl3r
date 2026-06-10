#!/usr/bin/env python3
"""
Map CHANGES-UM historical fish survey data (78 years of Michigan lake surveys)
to angl3r waterbodies. Produces species-by-waterbody data that can be merged
into regs.json.

Dataset: Zenodo DOI 10.5281/zenodo.15389937
License: CC BY 4.0
"""

import argparse
import csv
import io
import json
import re
import zipfile
from collections import defaultdict
from difflib import SequenceMatcher

# Standard species columns in the CHANGES-UM dataset
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


def normalize_name(name):
    """Strip suffixes/parentheticals for matching."""
    name = name.lower().strip()
    name = re.sub(r'\s+(lake|pond|reservoir|dam|pool|marsh|swamp)$', '', name)
    name = re.sub(r'\s*\(.*\)', '', name)
    name = re.sub(r'[^a-z0-9]', '', name)
    return name


def load_survey_data(zip_path):
    """Load and aggregate CHANGES-UM survey data by (county, lake)."""
    lake_species = defaultdict(lambda: {
        'species': set(),
        'extras': set(),
        'records': 0,
        'years': set(),
        'survey_ids': []
    })

    with zipfile.ZipFile(zip_path, 'r') as z:
        with z.open('CHANGES-UM-summ_fishc_grow-8415f9f/Lake_SUMM/summ_data_Apr2025.csv') as f:
            reader = csv.DictReader(io.TextIOWrapper(f))
            for row in reader:
                county = row['county'].strip().title()
                lake = row['lakename'].strip().title()
                key = (county, lake)

                lake_species[key]['records'] += 1
                lake_species[key]['survey_ids'].append(row.get('subject_id', ''))

                year = row.get('begin_date_year', '').strip()
                if year and year != 'NA':
                    lake_species[key]['years'].add(year)

                for col in SPECIES_COLS:
                    if row.get(col) == '1':
                        lake_species[key]['species'].add(SPECIES_NAME_MAP[col])

                extras = row.get('fish_extras', '').strip()
                if extras and extras != 'NA':
                    lake_species[key]['extras'].add(extras)

    return lake_species


def find_best_match(wb_name, wb_county, ds_lakes):
    """Find the best dataset match for a waterbody name."""
    wb_norm = normalize_name(wb_name)

    best_match = None
    best_score = 0

    for (ds_county, ds_lake), ds_data in ds_lakes.items():
        if ds_county != wb_county:
            continue

        ds_norm = normalize_name(ds_lake)

        # Exact match
        if wb_norm == ds_norm:
            return (ds_lake, ds_data, 1.0)

        # Substring match
        if wb_norm in ds_norm or ds_norm in wb_norm:
            score = 0.9
            if score > best_score:
                best_score = score
                best_match = (ds_lake, ds_data, score)
            continue

        # Fuzzy match
        score = SequenceMatcher(None, wb_norm, ds_norm).ratio()
        if score > best_score and score >= 0.75:
            best_score = score
            best_match = (ds_lake, ds_data, score)

    return best_match


def build_species_by_waterbody(regs_json_path, survey_zip_path, target_county=None):
    """Build species-by-waterbody mapping for all or one county."""
    with open(regs_json_path) as f:
        regs = json.load(f)

    survey_data = load_survey_data(survey_zip_path)

    # Build result: keyed by county, then by waterbody name
    result = defaultdict(dict)
    stats = {'matched': 0, 'unmatched': 0, 'no_species_data': 0}

    for wb in regs['waterbodies']:
        if target_county and wb['county'] != target_county:
            continue

        # Only match lakes/ponds for now (streams have different ecology)
        if wb['kind'] not in ('lake', 'pond'):
            continue

        ds_lakes_for_county = {
            k: v for k, v in survey_data.items()
            if k[0] == wb['county']
        }

        match = find_best_match(wb['name'], wb['county'], ds_lakes_for_county)

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
                'source': 'changes-um-zenodo'
            }

            if not species and not extras:
                stats['no_species_data'] += 1

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
        description='Map CHANGES-UM fish survey data to angl3r waterbodies'
    )
    parser.add_argument('--regs', default='data/regs.json',
                        help='Path to regs.json')
    parser.add_argument('--survey-zip', default='/tmp/summ_fishc_grow.zip',
                        help='Path to CHANGES-UM Zenodo ZIP')
    parser.add_argument('--county', default=None,
                        help='Process only one county (default: all)')
    parser.add_argument('--output', default='data/species_by_waterbody.json',
                        help='Output JSON file')
    parser.add_argument('--inject', action='store_true',
                        help='Inject result into regs.json')
    args = parser.parse_args()

    print(f"Loading survey data from {args.survey_zip}...")
    result, stats = build_species_by_waterbody(
        args.regs, args.survey_zip, args.county
    )

    print(f"\nResults:")
    print(f"  Waterbodies matched: {stats['matched']}")
    print(f"  Waterbodies unmatched: {stats['unmatched']}")
    print(f"  Matched but no species data: {stats['no_species_data']}")

    with open(args.output, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"\nWrote {args.output}")

    if args.inject:
        with open(args.regs) as f:
            regs = json.load(f)

        regs['species_by_waterbody'] = result
        regs['meta']['survey_source'] = {
            'title': 'CHANGES-UM Historical Fish Survey Data',
            'publisher': 'University of Michigan / Michigan DNR',
            'doi': '10.5281/zenodo.15389937',
            'license': 'CC BY 4.0',
            'description': '78 years of digitized fish presence/absence data for Michigan lakes'
        }

        with open(args.regs, 'w') as f:
            json.dump(regs, f, indent=2)
        print(f"Injected into {args.regs}")


if __name__ == '__main__':
    main()
