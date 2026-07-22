#!/usr/bin/env python3
"""
Scrape Michigan DNR Status of the Fishery Resource Report PDFs
and extract fish species data for unmatched waterbodies.

Uses pdftotext (poppler-utils) for fast text extraction and curl for downloads.
"""

import json
import os
import re
import subprocess
from collections import defaultdict
from difflib import SequenceMatcher

BASE_URL = "https://www2.dnr.state.mi.us/publications/pdfs/DNRFishLibrary/StatusoftheFisheryResourceReports/"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
MAX_DOWNLOADS = 200
PDF_DIR = "/tmp/status_fishery_pdfs"
OUTPUT_PATH = "/root/angl3r/data/status_fishery_species.json"
REGS_PATH = "/root/angl3r/data/regs.json"

# Known fish species names to search for in PDFs
FISH_SPECIES = [
    'Largemouth Bass', 'Smallmouth Bass', 'Walleye', 'Northern Pike',
    'Flathead Catfish', 'Channel Catfish', 'Muskellunge', 'Tiger Muskellunge',
    'Yellow Perch', 'Bluegill', 'Pumpkinseed', 'Rock Bass', 'Green Sunfish',
    'White Bass', 'Cisco', 'Lake Whitefish', 'Round Whitefish', 'Rainbow Smelt',
    'Burbot', 'Brown Trout', 'Rainbow Trout', 'Brook Trout', 'Lake Trout',
    'Chinook Salmon', 'Coho Salmon', 'Atlantic Salmon', 'Splake',
    'Black Crappie', 'White Crappie', 'Redear Sunfish', 'Hybrid Sunfish',
    'Common Carp', 'Sucker', 'Sturgeon', 'Lake Sturgeon', 'Bullhead',
    'Brown Bullhead', 'Yellow Bullhead', 'Black Bullhead',
    'Warmouth', 'Sauger', 'Freshwater Drum', 'Gar', 'Longnose Gar',
    'Bowfin', 'Minnow', 'Shiner', 'Darter', 'Killifish', 'Whitefish',
    'Lake Herring', 'Tullibee', 'Mooneye', 'Goldeye', 'Paddlefish',
]

# Additional species commonly found in Michigan fishery reports
ADDITIONAL_SPECIES = [
    'Steelhead', 'Tiger Trout', 'Golden Shiner', 'White Sucker',
    'Redhorse', 'Mudpuppy', 'Brook Silverside', 'Central Mudminnow',
    'Creek Chub', 'Common Shiner', 'Bluntnose Minnow',
    'Johnny Darter', 'Logperch', 'Mottled Sculpin', 'Slimy Sculpin',
    'Northern Redbelly Dace', 'Pearl Dace', 'Hornyhead Chub',
    'Stoneroller', 'Banded Killifish', 'Blacknose Dace', 'Longnose Dace',
    'Sea Lamprey', 'Silver Lamprey', 'Brook Lamprey', 'Chestnut Lamprey',
    'Bigmouth Buffalo', 'Smallmouth Buffalo', 'River Redhorse',
    'Golden Redhorse', 'Shorthead Redhorse', 'Silver Redhorse',
    'Greater Redhorse', 'Longnose Sucker', 'Spottail Shiner',
    'Sand Shiner', 'Quillback', 'Siscowet', 'Spotted Gar',
    'Fathead Minnow', 'Fathead', 'Emerald Shiner', 'River Chub',
    'Banded Darter', 'Iowa Darter', 'Rainbow Darter', 'Fantail Darter',
    'Least Darter', 'Mudminnow', 'Brook Stickleback',
    'Northern Hogsucker', 'Hogsucker',
    'American Brook Lamprey', 'Northern Brook Lamprey',
    'Spotfin Shiner', 'Blacknose Shiner', 'Spotted Sucker',
    'Silver Chub', 'River Carpsucker', 'Highfin Carpsucker',
    'Northern Pike', 'Grass Pickerel', 'Redfin Pickerel',
    'Blackside Darter', 'Slenderhead Darter', 'Western Sand Darter',
    'Southern Redbelly Dace', 'Finescale Dace', 'Lake Chub',
    'Brassy Minnow', 'Western Mudminnow',
]

ALL_SPECIES = FISH_SPECIES + ADDITIONAL_SPECIES


def normalize_name(name):
    """Normalize a waterbody name for matching."""
    name = name.strip().lower()
    # Remove fully-enclosed parens
    name = re.sub(r'\s*\([^)]*\)', '', name)
    # Remove unclosed parens and everything after (e.g. "Lake Charlevoix (including Round")
    name = re.sub(r'\s*\(.*$', '', name)
    # Remove trailing comma + direction/section info
    name = re.sub(r',\s*(north|south|east|west|upper|lower|t\d+n|s\d+)\s*$', '', name)
    # Strip trailing waterbody type words
    name = re.sub(r'\s+(lake|pond|reservoir|dam|pool|marsh|swamp|basin|river|creek|stream|bay|harbor|channel|impoundment|slough|flooding)s?$', '', name)
    name = re.sub(r"[''`]s\b", '', name)
    name = name.replace("'", "").replace("'", "")
    name = re.sub(r'\b(of michigan|in michigan|county|township|michigan)\b', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    alpha_only = re.sub(r'[^a-z0-9]', '', name)
    return alpha_only


def extract_waterbody_from_filename(filename):
    """Extract waterbody name from PDF filename like '0439_2025_Rainbow_Lake.pdf'."""
    name = filename.replace('.pdf', '')
    # Remove leading number_year pattern
    name = re.sub(r'^\d{4}_\d{4}_', '', name)
    # Replace underscores with spaces
    name = name.replace('_', ' ')
    # Split camelCase: insert space before uppercase following lowercase
    name = re.sub(r'([a-z])([A-Z])', r'\1 \2', name)
    # Also split sequences like "LakeDiane" -> "Lake Diane"
    name = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', name)
    return name.strip()


def extract_year_from_filename(filename):
    """Extract year from PDF filename."""
    match = re.match(r'\d{4}_(\d{4})_', filename)
    if match:
        return int(match.group(1))
    return 0


def fetch_directory_listing():
    """Fetch and parse the directory listing using curl."""
    result = subprocess.run(
        ['curl', '-s', '-A', USER_AGENT, BASE_URL],
        capture_output=True, text=True, timeout=120
    )
    html = result.stdout

    pdf_files = []
    for match in re.finditer(r'<A HREF="([^"]+\.pdf)">([^<]+)</A>', html, re.IGNORECASE):
        href = match.group(1)
        filename = href.split('/')[-1]
        # URL-decode
        filename = filename.replace('%20', ' ')
        # Skip non-report files
        if 'Status of the Fishery' in filename:
            continue
        if filename.startswith('~$'):
            continue
        pdf_files.append(filename)

    return pdf_files


def download_pdf(filename, output_dir):
    """Download a PDF using curl."""
    os.makedirs(output_dir, exist_ok=True)
    safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    filepath = os.path.join(output_dir, safe_name)

    if os.path.exists(filepath) and os.path.getsize(filepath) > 100:
        return filepath

    url = BASE_URL + filename.replace(' ', '%20')
    try:
        result = subprocess.run(
            ['curl', '-s', '-L', '-A', USER_AGENT, '-o', filepath, '--max-time', '60', url],
            capture_output=True, timeout=90
        )
        if os.path.exists(filepath) and os.path.getsize(filepath) > 100:
            return filepath
        if os.path.exists(filepath):
            os.remove(filepath)
        return None
    except Exception:
        if os.path.exists(filepath):
            os.remove(filepath)
        return None


def extract_text_from_pdf(filepath):
    """Extract text from PDF using pdftotext (poppler-utils)."""
    try:
        result = subprocess.run(
            ['pdftotext', '-q', filepath, '-'],
            capture_output=True, text=True, timeout=120
        )
        return result.stdout
    except Exception:
        return ""


def find_species_in_text(text):
    """Search for fish species mentions in the extracted text."""
    text_lower = text.lower()
    found = set()

    for species_name in ALL_SPECIES:
        base = species_name.lower()
        patterns = [base]
        if ' ' in base:
            patterns.append(base.replace(' ', ''))

        for pattern in patterns:
            if re.search(r'\b' + re.escape(pattern) + r'\b', text_lower):
                found.add(species_name)
                break

    return sorted(found)


def load_unmatched_waterbodies():
    """Load waterbodies that need species data (lakes/ponds with null source)."""
    with open(REGS_PATH) as f:
        regs = json.load(f)

    sbw = regs.get('species_by_waterbody', {})
    unmatched = []  # list of (county, name, norm)
    matched_names = set()

    for wb in regs.get('waterbodies', []):
        if wb.get('kind') not in ('lake', 'pond'):
            continue
        county = wb.get('county')
        name = wb.get('name')
        norm = normalize_name(name)

        entry = sbw.get(county, {}).get(name, {})
        if not entry.get('source'):
            unmatched.append((county, name, norm))
        else:
            matched_names.add((county, name))

    return unmatched, matched_names


def match_pdfs_to_waterbodies(pdf_files, unmatched_waterbodies):
    """
    Match PDFs to unmatched waterbodies.
    Returns list of (pdf_file, county, name, pdf_wb, score, year).
    For ambiguous matches (same name, multiple counties), returns all possibilities.
    """
    # Group unmatched by normalized name
    unmatched_by_norm = defaultdict(list)
    for county, name, norm in unmatched_waterbodies:
        unmatched_by_norm[norm].append((county, name))

    # Group PDFs by normalized name
    pdfs_by_norm = defaultdict(list)
    for pdf in pdf_files:
        pdf_wb = extract_waterbody_from_filename(pdf)
        pdf_norm = normalize_name(pdf_wb)
        if pdf_norm:
            year = extract_year_from_filename(pdf)
            pdfs_by_norm[pdf_norm].append((pdf, pdf_wb, year))

    matches = []  # (pdf_file, county, name, pdf_wb, score, year, ambiguous)

    # Phase 1: Exact normalized matches
    matched_wb = set()

    for norm, wb_list in unmatched_by_norm.items():
        if norm not in pdfs_by_norm:
            continue

        # Sort PDFs by year descending (most recent first)
        pdf_list = sorted(pdfs_by_norm[norm], key=lambda x: x[2], reverse=True)

        is_ambiguous = len(wb_list) > 1

        if not is_ambiguous:
            # Simple case: one waterbody for this name
            county, name = wb_list[0]
            pdf, pdf_wb, year = pdf_list[0]
            matches.append((pdf, county, name, pdf_wb, 1.0, year, False))
            matched_wb.add((county, name))
        else:
            # Ambiguous: multiple counties have same lake name
            # Try to match each PDF to a county (will verify county in text later)
            used_pdfs = set()
            for county, name in wb_list:
                if (county, name) in matched_wb:
                    continue
                # Try to find an unused PDF for this county
                for pdf, pdf_wb, year in pdf_list:
                    if pdf not in used_pdfs:
                        matches.append((pdf, county, name, pdf_wb, 1.0, year, True))
                        matched_wb.add((county, name))
                        used_pdfs.add(pdf)
                        break

    # Phase 2: Fuzzy matches for remaining unmatched waterbodies
    remaining = [(c, n, nm) for c, n, nm in unmatched_waterbodies if (c, n) not in matched_wb]

    for county, name, norm in remaining:
        best_score = 0
        best_match = None

        for pdf, pdf_wb, year in [(p, pw, y) for pn, plist in pdfs_by_norm.items() for p, pw, y in plist]:
            pdf_norm = normalize_name(pdf_wb)
            if not pdf_norm:
                continue

            # Skip if this PDF already matched exactly
            if any(m[0] == pdf for m in matches):
                continue

            # Substring match
            if pdf_norm in norm or norm in pdf_norm:
                score = min(len(pdf_norm), len(norm)) / max(len(pdf_norm), len(norm)) if max(len(pdf_norm), len(norm)) > 0 else 0
                if score > best_score and score >= 0.6:
                    best_score = score
                    best_match = (pdf, pdf_wb, year)
            else:
                score = SequenceMatcher(None, pdf_norm, norm).ratio()
                if score > best_score and score >= 0.75:
                    best_score = score
                    best_match = (pdf, pdf_wb, year)

        if best_match:
            pdf, pdf_wb, year = best_match
            matches.append((pdf, county, name, pdf_wb, best_score, year, False))
            matched_wb.add((county, name))

    return matches


def verify_county_in_text(text, county):
    """Check if county name appears in the PDF text."""
    text_lower = text.lower()
    county_lower = county.lower()
    # Check for county name with or without "County" suffix
    if county_lower in text_lower:
        return True
    return False


def main():
    print("=== DNR Status of the Fishery Resource Report Scraper ===")
    print()

    # Load existing results
    existing_results = {}
    if os.path.exists(OUTPUT_PATH):
        with open(OUTPUT_PATH) as f:
            existing_results = json.load(f)
        existing_count = sum(len(v) for v in existing_results.values())
        print(f"Loaded {existing_count} existing entries from {OUTPUT_PATH}")

    # Load unmatched waterbodies
    print("Loading app waterbodies...")
    unmatched, matched = load_unmatched_waterbodies()
    print(f"  Total lakes/ponds: {len(unmatched) + len(matched)}")
    print(f"  With species data: {len(matched)}")
    print(f"  Unmatched (need data): {len(unmatched)}")

    # Fetch directory listing
    print("\nFetching DNR directory listing...")
    pdf_files = fetch_directory_listing()
    print(f"  Found {len(pdf_files)} PDF files")

    # Match PDFs to unmatched waterbodies
    print("\nMatching PDFs to waterbodies...")
    matches = match_pdfs_to_waterbodies(pdf_files, unmatched)

    exact_matches = [m for m in matches if m[4] >= 1.0]
    fuzzy_matches = [m for m in matches if m[4] < 1.0]
    ambiguous_matches = [m for m in matches if m[6]]

    print(f"  Total matched: {len(matches)}")
    print(f"    Exact matches: {len(exact_matches)}")
    print(f"    Fuzzy matches: {len(fuzzy_matches)}")
    print(f"    Ambiguous (need county verification): {len(ambiguous_matches)}")

    # Sort by score descending, then year descending
    matches.sort(key=lambda x: (x[4], x[5]), reverse=True)
    to_process = matches[:MAX_DOWNLOADS]
    print(f"  Processing top {len(to_process)} (limit {MAX_DOWNLOADS})")

    # Download and process PDFs
    results = dict(existing_results)  # Start with existing results
    processed = 0
    species_found_count = 0
    failed_downloads = 0
    no_species_count = 0
    county_mismatch_count = 0

    print("\nDownloading and processing PDFs...")

    for pdf_file, county, name, pdf_wb, score, year, is_ambiguous in to_process:
        processed += 1
        if processed % 20 == 0:
            print(f"  Progress: {processed}/{len(to_process)} ({species_found_count} with species)")

        # Download PDF
        filepath = download_pdf(pdf_file, PDF_DIR)
        if not filepath:
            failed_downloads += 1
            continue

        # Extract text
        text = extract_text_from_pdf(filepath)
        if not text.strip():
            print(f"  [SKIP] No text: {pdf_file}")
            continue

        # For ambiguous matches, verify county in text
        if is_ambiguous:
            if not verify_county_in_text(text, county):
                county_mismatch_count += 1
                continue

        # Find species
        species = find_species_in_text(text)

        if species:
            if county not in results:
                results[county] = {}
            results[county][name] = {
                'species': species,
                'source': 'dnr-status-fishery-pdf',
                'pdf_file': pdf_file,
                'match_score': round(score, 2),
                'pdf_waterbody': pdf_wb,
                'year': year,
                'text_length': len(text)
            }
            species_found_count += 1
        else:
            no_species_count += 1

        # Clean up PDF to save disk space
        try:
            os.remove(filepath)
        except:
            pass

    # Save results
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(results, f, indent=2)

    # Summary
    total_entries = sum(len(v) for v in results.values())
    new_entries = species_found_count

    print()
    print("=" * 60)
    print("FINAL SUMMARY")
    print("=" * 60)
    print(f"PDFs found in DNR directory:     {len(pdf_files)}")
    print(f"PDFs matched to waterbodies:     {len(matches)}")
    print(f"  - Exact name matches:          {len(exact_matches)}")
    print(f"  - Fuzzy matches:                {len(fuzzy_matches)}")
    print(f"  - Ambiguous (multi-county):    {len(ambiguous_matches)}")
    print(f"PDFs downloaded & processed:     {processed}")
    print(f"  - Failed downloads:             {failed_downloads}")
    print(f"  - County mismatches (skipped):  {county_mismatch_count}")
    print(f"  - No species found:             {no_species_count}")
    print(f"  - Species extracted (NEW):      {species_found_count}")
    print(f"  - Existing entries preserved:  {sum(len(v) for v in existing_results.values())}")
    print(f"Total entries in output JSON:    {total_entries}")
    print(f"")
    print(f"Coverage improvement:")
    print(f"  Lakes/ponds previously with data: {len(matched)}")
    print(f"  Lakes/ponds newly covered:       {species_found_count}")
    print(f"  Total lakes/ponds with data:     {len(matched) + species_found_count}")
    print(f"  Lakes/ponds still unmatched:     {len(unmatched) - species_found_count}")
    print(f"")
    print(f"Results saved to: {OUTPUT_PATH}")
    print()
    print("Coverage by county (new entries only):")
    new_by_county = defaultdict(int)
    for county, name, norm in unmatched:
        if county in results and name in results.get(county, {}) and results[county][name].get('source') == 'dnr-status-fishery-pdf':
            # Check if this is a new entry (not in existing_results)
            if county not in existing_results or name not in existing_results.get(county, {}):
                new_by_county[county] += 1
    for county in sorted(new_by_county.keys()):
        print(f"  {county}: {new_by_county[county]}")


if __name__ == '__main__':
    main()