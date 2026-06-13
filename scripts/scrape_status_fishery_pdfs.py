#!/usr/bin/env python3
"""
Scrape Michigan DNR Status of the Fishery Resource Report PDFs
and extract fish species data for unmatched waterbodies.

URL: https://www2.dnr.state.mi.us/publications/pdfs/DNRFishLibrary/StatusoftheFisheryResourceReports/
"""

import json
import os
import re
import urllib.request
from collections import defaultdict
from difflib import SequenceMatcher

try:
    import PyPDF2
except ImportError:
    os.system("pip install PyPDF2 -q")
    import PyPDF2

# Base URL for PDFs
BASE_URL = "https://www2.dnr.state.mi.us/publications/pdfs/DNRFishLibrary/StatusoftheFisheryResourceReports/"

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

# Create variations (lowercase, singular)
def make_search_patterns():
    patterns = {}
    for sp in FISH_SPECIES:
        base = sp.lower()
        patterns[sp] = [base]
        # Handle compound names
        if ' ' in base:
            patterns[sp].append(base.replace(' ', ''))
    return patterns

SEARCH_PATTERNS = make_search_patterns()


def normalize_name(name):
    """Normalize a waterbody name for matching."""
    name = name.strip().lower()
    name = re.sub(r'\s*\([^)]*\)', '', name)
    name = re.sub(r'\s+(lake|pond|reservoir|dam|pool|marsh|swamp|basin|river|creek|stream|bay|harbor|channel|impoundment|slough)(s)?$', '', name)
    name = re.sub(r"['']s\b", '', name)
    name = name.replace("'", "").replace("'", "")
    name = re.sub(r'\b(of michigan|in michigan|county|township|michigan)\b', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    alpha_only = re.sub(r'[^a-z0-9]', '', name)
    return alpha_only


def parse_directory_listing():
    """Parse the HTML directory listing to find all PDF files."""
    html = urllib.request.urlopen(BASE_URL).read().decode('utf-8', errors='ignore')
    
    pdf_links = []
    # Find all .pdf links in the HTML
    for match in re.finditer(r'<A HREF="([^"]+\.pdf)">([^<]+)</A>', html):
        href = match.group(1)
        filename = href.split('/')[-1]
        # Skip the informational PDF
        if 'Status of the Fishery' in filename:
            continue
        pdf_links.append(filename)
    
    return pdf_links


def extract_waterbody_from_filename(filename):
    """Extract waterbody name from PDF filename like '0038_1993_PontiacLake.pdf'."""
    # Remove extension
    name = filename.replace('.pdf', '')
    # Remove leading number and year pattern: XXXX_YEAR_
    match = re.match(r'\d+_\d+_(.+)$', name)
    if match:
        return match.group(1)
    return name


def download_pdf(filename, output_dir='/tmp/status_fishery_pdfs'):
    """Download a single PDF."""
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    
    if os.path.exists(filepath):
        return filepath
    
    url = BASE_URL + filename
    try:
        urllib.request.urlretrieve(url, filepath)
        return filepath
    except Exception as e:
        print(f"  Failed to download {filename}: {e}")
        return None


def extract_text_from_pdf(filepath):
    """Extract text from a PDF using PyPDF2."""
    try:
        with open(filepath, 'rb') as f:
            reader = PyPDF2.PdfReader(f)
            text = ""
            for page in reader.pages:
                try:
                    text += page.extract_text() or ""
                except:
                    pass
            return text
    except Exception as e:
        print(f"  Failed to read {filepath}: {e}")
        return ""


def find_species_in_text(text):
    """Search for fish species mentions in the extracted text."""
    text_lower = text.lower()
    found = set()
    
    for species_name, patterns in SEARCH_PATTERNS.items():
        for pattern in patterns:
            # Use word boundary matching
            if re.search(r'\b' + re.escape(pattern) + r'\b', text_lower):
                found.add(species_name)
                break
    
    return sorted(found)


def load_app_waterbodies():
    """Load our app's waterbodies and which ones need species data."""
    with open('/root/angl3r/data/regs.json') as f:
        regs = json.load(f)
    
    # Get current species data
    with open('/root/angl3r/public/data/species_by_waterbody.json') as f:
        species_data = json.load(f)
    
    # Find unmatched lakes/ponds
    unmatched = set()
    all_waterbodies = {}  # county -> {normalized_name -> original_name}
    
    for wb in regs['waterbodies']:
        if wb['kind'] not in ('lake', 'pond'):
            continue
        county = wb['county']
        name = wb['name']
        norm = normalize_name(name)
        
        if county not in all_waterbodies:
            all_waterbodies[county] = {}
        all_waterbodies[county][norm] = name
        
        # Check if already matched
        entry = species_data.get(county, {}).get(name, {})
        if not entry.get('source'):
            unmatched.add((county, name, norm))
    
    return unmatched, all_waterbodies


def match_pdf_to_waterbody(pdf_name, unmatched_waterbodies, all_waterbodies):
    """Try to match a PDF filename to one of our waterbodies."""
    pdf_wb = extract_waterbody_from_filename(pdf_name)
    pdf_norm = normalize_name(pdf_wb)
    
    # First, try exact normalized match against unmatched waterbodies
    for county, name, norm in unmatched_waterbodies:
        if norm == pdf_norm:
            return county, name, pdf_wb, 1.0
    
    # Then try substring/fuzzy match
    best_score = 0
    best_match = None
    
    for county, name, norm in unmatched_waterbodies:
        if pdf_norm in norm or norm in pdf_norm:
            score = min(len(pdf_norm), len(norm)) / max(len(pdf_norm), len(norm))
            if score > best_score and score >= 0.5:
                best_score = score
                best_match = (county, name, pdf_wb, score)
        else:
            score = SequenceMatcher(None, pdf_norm, norm).ratio()
            if score > best_score and score >= 0.75:
                best_score = score
                best_match = (county, name, pdf_wb, score)
    
    return best_match


def main():
    print("Loading app waterbodies...")
    unmatched, all_waterbodies = load_app_waterbodies()
    print(f"  Unmatched lakes/ponds: {len(unmatched)}")
    
    print("\nParsing DNR directory listing...")
    pdf_files = parse_directory_listing()
    print(f"  Found {len(pdf_files)} PDF files")
    
    # Match PDFs to unmatched waterbodies
    matched_pdfs = []
    for pdf in pdf_files:
        result = match_pdf_to_waterbody(pdf, unmatched, all_waterbodies)
        if result:
            matched_pdfs.append((pdf, result))
    
    print(f"  {len(matched_pdfs)} PDFs match unmatched waterbodies")
    
    # Sort by match score and limit to top 50
    matched_pdfs.sort(key=lambda x: x[1][3] if len(x[1]) > 3 else 0, reverse=True)
    to_process = matched_pdfs[:50]
    
    # Download and parse PDFs
    results = {}
    for pdf_file, match_info in to_process:
        county, name, pdf_wb, score = match_info
        
        print(f"\nProcessing: {pdf_file} -> {county} / {name} (score={score:.2f})")
        
        filepath = download_pdf(pdf_file)
        if not filepath:
            continue
        
        text = extract_text_from_pdf(filepath)
        if not text:
            continue
        
        species = find_species_in_text(text)
        print(f"  Found {len(species)} species: {', '.join(species[:10])}{'...' if len(species) > 10 else ''}")
        
        if species:
            if county not in results:
                results[county] = {}
            results[county][name] = {
                'dataset_match': pdf_wb,
                'match_score': round(score, 2),
                'species': species,
                'source': 'dnr-status-fishery-pdf',
                'dataset': 'status_fishery',
                'pdf_file': pdf_file,
                'text_length': len(text)
            }
    
    # Save results
    output_path = '/root/angl3r/data/status_fishery_species.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\n\nWrote {output_path}")
    print(f"Total waterbodies with new species data: {sum(len(v) for v in results.values())}")
    
    # Summary by county
    print("\nCoverage by county:")
    for county in sorted(results.keys()):
        print(f"  {county}: {len(results[county])} waterbodies")


if __name__ == '__main__':
    main()
