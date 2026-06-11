#!/usr/bin/env python3
"""
parse_pdf.py — Extract Michigan fishing regulations from the annual DNR PDF.

Input:  data/<year>-Michigan-Fishing-Regulations.pdf
Output: data/regs.json  (committed to repo, consumed by the static site)

The PDF is the 2026 edition, 76 pages, made in Adobe InDesign. Text extraction
is mostly clean via `pdftotext -layout` (or `-tsv` for table extraction on
the Type regulation pages 44-45).

This script is idempotent — running it twice produces identical output.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = REPO_ROOT / "data" / "2026-Michigan-Fishing-Regulations.pdf"
OUTPUT_PATH = REPO_ROOT / "data" / "regs.json"
OCR_DIR = REPO_ROOT / "data" / "ocr_cache"
OCR_DIR.mkdir(exist_ok=True)

# Michigan counties (alphabetical) — used to detect county boundaries in the
# county listings. Comes from the official Michigan list (83 counties).
MICHIGAN_COUNTIES = [
    "Alcona", "Alger", "Allegan", "Alpena", "Antrim", "Arenac", "Baraga",
    "Barry", "Bay", "Benzie", "Berrien", "Branch", "Calhoun", "Cass",
    "Charlevoix", "Cheboygan", "Chippewa", "Clare", "Clinton", "Crawford",
    "Delta", "Dickinson", "Eaton", "Emmet", "Genesee", "Gladwin", "Gogebic",
    "Grand Traverse", "Gratiot", "Hillsdale", "Houghton", "Huron", "Ingham",
    "Ionia", "Iosco", "Iron", "Isabella", "Jackson", "Kalamazoo", "Kalkaska",
    "Kent", "Keweenaw", "Lake", "Lapeer", "Leelanau", "Lenawee",
    "Livingston", "Luce", "Mackinac", "Macomb", "Manistee", "Marquette",
    "Mason", "Mecosta", "Menominee", "Midland", "Missaukee", "Monroe",
    "Montcalm", "Montmorency", "Muskegon", "Newaygo", "Oakland", "Oceana",
    "Ogemaw", "Ontonagon", "Osceola", "Oscoda", "Otsego", "Ottawa",
    "Presque Isle", "Roscommon", "Saginaw", "St. Clair", "St. Joseph",
    "Sanilac", "Schoolcraft", "Shiawassee", "Tuscola", "Van Buren",
    "Washtenaw", "Wayne", "Wexford",
]
# Some appear with a slash variant in the PDF — handle both.
COUNTY_LOOKUP = {c.lower(): c for c in MICHIGAN_COUNTIES}
COUNTY_LOOKUP["larp"] = "Lapeer"  # 'LARP' is the Lake & Reservoir Program, not a county

# Lake regulation Types (from p. 42) — referenced by letter
LAKE_TYPES = ["A", "B", "C", "D", "E", "F"]

# Stream regulation Types (from p. 43) — referenced by number, plus special
STREAM_TYPES = ["1", "2", "3", "4", "GR", "BTRA", "SC"]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Lake:
    name: str
    county: str
    type: str
    # source page in the PDF (for citation)
    source_page: int
    clean_name: str = ""


@dataclass
class Stream:
    name: str
    county: str
    type: str
    # Free-text section description: e.g. "from Evans Rd. downstream to 4001 Bridge."
    section: str
    # Closure detail (for SC type) or empty
    closure: str = ""
    source_page: int = 0
    clean_name: str = ""


def clean_waterbody_name(name: str) -> str:
    """Clean up OCR artifacts from waterbody names parsed from the PDF.

    Common issues:
      - 'Dam.                                                      Portage Lake'
      - 'SC - Closed to Fishing — Year-round                 Moccasin Lake'
      - 'feet downstream from the DNR weir in                Just Lake'
      - 'from Evans Rd. downstream to 4001 Bridge.' (section bleed)

    Strategy: split on 2+ spaces; the rightmost non-empty chunk that looks
    like a real lake name (contains 'Lake', 'Pond', or ends in a name word)
    is the actual waterbody. Everything else is a left-column artifact or
    stream-section description that leaked across columns.
    """
    # Collapse tabs, multiple spaces
    s = re.sub(r"\s+", " ", name).strip()

    # If there's no large whitespace gap, it's probably clean
    if "  " not in name:
        return s

    # Split on 2+ spaces — this usually separates left artifact from right name
    chunks = re.split(r"\s{2,}", name)
    chunks = [c.strip() for c in chunks if c.strip()]

    if not chunks:
        return s

    # Prefer the rightmost chunk that contains "Lake" or "Pond"
    for chunk in reversed(chunks):
        lower = chunk.lower()
        if "lake" in lower or "pond" in lower or "basin" in lower:
            return chunk

    # Fallback: return the rightmost chunk (most likely the real name)
    return chunks[-1]


@dataclass
class RegulationDoc:
    """A regulation document: a section of the PDF, parsed into structured text."""
    id: str          # machine id, e.g. "general", "type-a-lake", "type-2-stream"
    title: str       # human title
    category: str    # "general" | "inland_lake" | "inland_stream" | "exception" | "great_lakes" | "special"
    body: str        # plain text body
    source_pages: list[int] = field(default_factory=list)


# ---------------------------------------------------------------------------
# PDF extraction helpers
# ---------------------------------------------------------------------------

def run_pdftotext(*args: str) -> str:
    """Run pdftotext with the given args and return stdout."""
    cmd = ["pdftotext", "-layout", *args, str(PDF_PATH), "-"]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


def extract_page_range(start: int, end: int) -> str:
    """Extract physical page range (1-indexed, inclusive)."""
    return run_pdftotext("-f", str(start), "-l", str(end))


def extract_all_pages() -> dict[int, str]:
    """Extract every page, return {physical_page: text}."""
    # Get the actual page count first.
    info = subprocess.run(
        ["pdfinfo", str(PDF_PATH)], capture_output=True, text=True, check=True
    ).stdout
    m = re.search(r"Pages:\s+(\d+)", info)
    if not m:
        raise RuntimeError("Could not determine page count from pdfinfo")
    total = int(m.group(1))
    out = {}
    for p in range(1, total + 1):
        text = run_pdftotext("-f", str(p), "-l", str(p))
        if text.strip():
            out[p] = text
    return out


# ---------------------------------------------------------------------------
# Parsers for specific sections
# ---------------------------------------------------------------------------

def _is_running_header(stripped: str) -> bool:
    """Detect the vertical sidebar text that runs along the left edge of every
    county listings page. It's the words INLAND TROUT & SALMON REGULATIONS,
    laid out vertically and split mid-word by the layout engine."""
    # The full phrase is "I N L A N D T R O U T & S A L M O N R E G U L AT I O N S"
    # split into single words across many lines. We catch the fragments.
    if re.match(r"^(I\s+N\s+L\s+A\s+N(\s+D)?|T\s+R\s+O\s+U(\s+T)?|S\s+A\s+L\s+M(\s+O\s+N)?|R\s+E\s+G\s+U\s+L(\s+A\s+T(\s+I\s+O\s+N(\s+S)?)?)?)\s*$", stripped):
        return True
    if stripped in {"&", "N D"}:
        return True
    return False


def _is_column_header_line(stripped: str) -> bool:
    """The 2-column layout produces lines like
    'Lakes...Type...Anna River...4' or
    'Streams...Type...Au Train River...4'
    where the second half is real data but the first half is a column header.
    We detect and skip these by checking for the header text patterns."""
    # When the line contains 'Lakes' or 'Streams' AND 'Type' AND something
    # else, it's a header line.
    if ("Lakes" in stripped or "Streams" in stripped) and "Type" in stripped:
        # Confirm it's a header by checking it contains one of the known
        # words at the start (i.e., not in the middle of a section)
        if re.match(r"^(Lakes|Streams)\s+", stripped) or stripped.startswith(("Lakes", "Streams")):
            return True
        # Some header lines don't have leading whitespace before the words
        if re.search(r"\b(Lakes|Streams)\b.*\bType\b", stripped):
            return True
    return False


def _is_intro_text(stripped: str) -> bool:
    """The explanatory text on page 50 and a few catch-all phrases."""
    keys = [
        "Michigan.gov", "County Listing", "Below is a listing",
        "the lake name", "the stream name", "Type 1 streams",
        "SC indicates", "Michigan.gov/dnr", "Inland Trout/Salmon maps",
        "respective regulation", "designates the Type", "fishing closure",
        "available online", "Please see", "Check the county",
        "MANAGING", "MANAGED", "For a complete listing",
        "All types of natural",
    ]
    return any(k in stripped for k in keys)


def _strip_leading_header(line: str) -> str:
    """The vertical sidebar text on county listings pages runs along the left
    edge, starting at column 0. Real content starts at column ~24. We strip
    a leading run of header text (whitespace + uppercase letters with spaces
    between) so the rest of the line is just real content."""
    # The header fragments are sequences of single uppercase letters separated
    # by spaces, possibly with ampersands or "N D" etc. We scan from the
    # start and skip past any prefix that looks like a header fragment.
    i = 0
    n = len(line)
    # Skip leading whitespace
    while i < n and line[i] == " ":
        i += 1
    # Now we're at the start of a word. If it's a single uppercase letter
    # followed by space and another single uppercase letter (the header
    # pattern), keep skipping.
    header_re = re.compile(
        r"^(?:[A-Z]\s+|&\s*|N\s+D\s+|T\s+R\s+O\s+U\s+T?\s*|S\s+A\s+L\s+M\s+O?\s*|R\s+E\s+G\s+U\s+L(?:\s+A\s+T(?:\s+I\s+O\s+N(?:\s+S)?)?)?\s*|I\s+N\s+L\s+A\s+N\s*D?\s*)+"
    )
    m = header_re.match(line, i)
    if m and m.end() - i < 25:  # only strip if the "header" is short
        i = m.end()
    return line[i:]


def _extract_entries_from_line(s: str) -> list[tuple[str, str]]:
    """
    Extract (name, type) pairs from a single line. A line may contain 0 or 1
    entry (the 2-column layout mostly puts one entry per line; the rare
    2-entries-on-one-line case gets handled as one entry + one continuation,
    which we accept as a tradeoff for cleaner overall data).

    Returns entries in left-to-right order.
    """
    out = []
    # Lake: <Name>  <A-F> at end of a "name region"
    m = re.search(r"^(.+?)\s+([A-F])\s*$", s)
    if m and m.group(1).strip() and m.group(1).strip() != "Type":
        out.append((m.group(1).strip(), m.group(2)))
        return out
    # Stream: <Name>  <1-4|GR|BTRA|SC> at end of a "name region"
    m = re.search(r"^(.+?)\s+([1-4]|GR|BTRA|SC)\s*$", s)
    if m and m.group(1).strip() and m.group(1).strip() != "Type":
        out.append((m.group(1).strip(), m.group(2)))
    return out


def parse_county_listings(pages: dict[int, str]) -> tuple[list[Lake], list[Stream], list[str]]:
    """
    Parse physical pages 50-67 (county listings of lakes & streams).

    Strategy:
      1. Strip the left-edge running header (the vertical INLAND TROUT &
         SALMON REGULATIONS text) using _strip_leading_header.
      2. Track (current_county, current_sub). current_sub is set when we
         see "Lakes" or "Streams" as a section header.
      3. For each line, if it ends with A-F it's a lake entry, if it ends
         with 1-4/GR/BTRA/SC it's a stream entry. We trust the line shape
         to determine which kind it is, not the current_sub.
      4. If the line contains BOTH a column header (Lakes/Streams/Type) AND
         a real entry (the 2-column artifact case), extract only the real
         entry by stripping the header prefix.

    Returns (lakes, streams, county_order).
    """
    lakes: list[Lake] = []
    streams: list[Stream] = []
    county_order: list[str] = []

    current_county: Optional[str] = None
    pending_stream: Optional[Stream] = None

    county_pages = list(range(50, 68))

    for page in county_pages:
        text = pages.get(page, "")
        for raw_line in text.splitlines():
            content = _strip_leading_header(raw_line)
            s = content.strip()
            if not s:
                continue
            if _is_running_header(s):
                continue
            if _is_intro_text(s):
                continue

            # County header: check if the first whitespace-delimited word
            # of the line is a Michigan county. This handles both:
            #   "Alcona"  (just the county name)
            #   "Alcona   Streams   Type"  (county + 2-column header)
            first_word = s.split()[0] if s.split() else ""
            # Two-word counties: "Grand Traverse", "St. Clair", "St. Joseph"
            # Try the first two words for those.
            first_two = " ".join(s.split()[:2]) if len(s.split()) >= 2 else first_word
            if first_two in MICHIGAN_COUNTIES:
                new_county = first_two
            elif first_word in MICHIGAN_COUNTIES:
                new_county = first_word
            else:
                new_county = None
            if new_county is not None:
                if new_county not in county_order:
                    county_order.append(new_county)
                if current_county != new_county:
                    # Finalize the previous county's pending stream
                    pending_stream = None
                    current_county = new_county
                continue

            # Column-header line that ALSO contains a real entry: e.g.
            # "Lakes   Type   Anna River   4" — the right half is a real
            # stream. Strip the header prefix and try to match the rest.
            if _is_column_header_line(s):
                # Try to extract a real entry from the right half of the
                # line. The header occupies the first ~50 chars; the real
                # entry is at column ~50 onward.
                m = re.match(
                    r"^(?:Lakes|Streams)\s+Type\s+(.+?)\s{2,}([1-4]|GR|BTRA|SC)\s*$",
                    s,
                )
                if m and current_county:
                    pending_stream = Stream(
                        name=m.group(1).strip(),
                        county=current_county,
                        type=m.group(2),
                        section="",
                        source_page=page,
                    )
                    streams.append(pending_stream)
                # Lake column header with a real entry on the right? In the
                # PDF, the "Lakes" header line is followed by "Type" then
                # the first real stream entry, so we just handled that.
                # Pure column headers (e.g. "Lakes   Type" alone) are
                # filtered out by not matching the above.
                continue

            if current_county is None:
                continue

            # Section header lines (standalone)
            if s in ("Lakes", "Streams", "Type"):
                continue

            # Try to extract entries from this line
            entries = _extract_entries_from_line(s)
            for name, type_code in entries:
                # A name that's just "Type" is a header artifact
                if name.lower() == "type":
                    continue
                # Letters A-F → lake
                if re.match(r"^[A-F]$", type_code):
                    lakes.append(Lake(
                        name=name,
                        county=current_county,
                        type=type_code,
                        source_page=page,
                    ))
                    # A new lake entry doesn't terminate a pending stream
                    # (the lake and stream sections are separate)
                # Numbers/GR/BTRA/SC → stream
                else:
                    # A new stream entry implicitly finalizes the previous
                    # pending stream (its section description is whatever
                    # was accumulated before this point).
                    pending_stream = Stream(
                        name=name,
                        county=current_county,
                        type=type_code,
                        section="",
                        source_page=page,
                    )
                    streams.append(pending_stream)

            # If we didn't find an entry but have a pending stream, treat
            # this line as a continuation of the stream's section
            # description. Only allow a few lines of continuation before
            # we assume the section is complete (a long sequence of
            # continuation lines usually means we missed a stream entry).
            if not entries and pending_stream is not None and pending_stream.county == current_county:
                # Don't append if the line is itself a county header (already
                # handled) or a column header (already handled). It must be
                # either a description fragment or noise.
                if not pending_stream.section:
                    pending_stream.section = s
                else:
                    pending_stream.section += " " + s
                # Reset pending_stream after a few lines of description to
                # avoid runaway cross-contamination when we miss a stream
                # entry boundary. We track this by checking if the
                # description is "complete" — it usually ends in a period.
                if pending_stream.section.count(".") >= 1 and len(pending_stream.section) > 30:
                    pending_stream = None

    # Cleanup: collapse whitespace in section descriptions and clean up
    # cross-column artifacts in waterbody names.
    for s in streams:
        s.section = re.sub(r"\s+", " ", s.section).strip()
        s.closure = re.sub(r"\s+", " ", s.closure).strip()
        s.clean_name = clean_waterbody_name(s.name)

    for l in lakes:
        l.clean_name = clean_waterbody_name(l.name)

    return lakes, streams, county_order


# Statewide species regulations from the General Fishing Regulations table
# (physical pp. 14-15). This is the "fallback" for any water that isn't a
# designated trout/salmon water. Each species has min size, daily limit, and
# possession season. The table is hand-curated from the 2026 PDF.
STATEWIDE_SPECIES_REGS = [
    {
        "id": "largemouth-bass",
        "name": "Largemouth Bass",
        "min_size": "14\"",
        "daily_limit": "5 (in combination with Smallmouth Bass)",
        "possession_seasons": [
            "3rd Sat. in June – Dec. 31: L. St. Clair, St. Clair R., Detroit R.",
            "Sat. before Memorial Day – Dec. 31: All other waters including Great Lakes",
        ],
        "notes": "Catch-and-immediate-release allowed all year. Special 4th-Sat-in-June opener for L. St. Clair, St. Clair R., Detroit R.",
    },
    {
        "id": "smallmouth-bass",
        "name": "Smallmouth Bass",
        "min_size": "14\"",
        "daily_limit": "5 (in combination with Largemouth Bass)",
        "possession_seasons": [
            "3rd Sat. in June – Dec. 31: L. St. Clair, St. Clair R., Detroit R.",
            "Sat. before Memorial Day – Dec. 31: All other waters including Great Lakes",
        ],
        "notes": "Catch-and-immediate-release allowed all year.",
    },
    {
        "id": "walleye",
        "name": "Walleye",
        "min_size": "15\"",
        "daily_limit": "5",
        "possession_seasons": [
            "May 15 – March 15: Upper Peninsula Great Lakes and inland waters, and St. Marys R.",
            "Last Sat. in April – March 15: Lower Peninsula inland waters",
            "Open All Year: Lower Peninsula Great Lakes, L. St. Clair, St. Clair R., Detroit R.",
        ],
        "notes": "Protected Slot Limit (PSL) waters: release all 15\"-18\" walleye, possession limit 5 with no more than 1 over 23\". Special L. Huron MH-4: 8 daily, 13\" min. L. Erie/Detroit R./L. St. Clair/St. Clair R.: 6 daily through Apr 30, 2027.",
    },
    {
        "id": "northern-pike",
        "name": "Northern Pike",
        "min_size": "24\"",
        "daily_limit": "2",
        "possession_seasons": [
            "May 15 – March 15: Upper Peninsula Great Lakes and inland waters, and St. Marys R.",
            "Last Sat. in April – March 15: Lower Peninsula inland waters",
            "Open All Year: Lower Peninsula Great Lakes, L. St. Clair, St. Clair R., Detroit R.",
        ],
        "notes": None,
    },
    {
        "id": "flathead-catfish",
        "name": "Flathead Catfish",
        "min_size": "15\"",
        "daily_limit": "5",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "channel-catfish",
        "name": "Channel Catfish",
        "min_size": "12\"",
        "daily_limit": "10",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "muskellunge",
        "name": "Muskellunge (including Tiger Muskellunge)",
        "min_size": "42\" (50\" in some waters — see NOTE 4)",
        "daily_limit": "1 per angler per license year (mandatory registration)",
        "possession_seasons": [
            "1st Sat. in June – March 15: All Great Lakes and inland waters and St. Marys R.",
            "1st Sat. in June – Dec. 31: L. St. Clair, St. Clair R., Detroit R.",
        ],
        "notes": "Catch-and-immediate-release allowed all year. Special 50\" minimum size applies to: L. Bellaire, Clam L., Torch L., Elk L. (above Elk Rapids Dam), L. Skegemog, Thornapple R. (M-50 bridge to McCann Rd), Chicagon L., and more. Harvest must be registered within 24 hours via Michigan.gov/RegisterFish, Hunt Fish app, or 888-636-7778.",
    },
    {
        "id": "yellow-perch",
        "name": "Yellow Perch",
        "min_size": "No size limit",
        "daily_limit": "25",
        "possession_seasons": ["Open All Year"],
        "notes": "Some waters have lower limits (e.g. L. Gogebic: 25 with no more than 5 over 12\").",
    },
    {
        "id": "sunfishes",
        "name": "Sunfishes (Bluegill, Pumpkinseed, Rock Bass, etc.)",
        "min_size": "No size limit",
        "daily_limit": "25 in any combination of the listed species",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "white-bass",
        "name": "White Bass",
        "min_size": "No size limit",
        "daily_limit": "25 on Great Lakes, L. St. Clair, St. Marys R., St. Clair R., Detroit R.; 10 on inland waters",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "cisco-whitefish",
        "name": "Cisco, Lake Whitefish, Round Whitefish",
        "min_size": "No size limit",
        "daily_limit": "10 in any combination on Great Lakes, Connecting Waters and Type F lakes; 5 in any combination on other inland waters",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "smelt",
        "name": "Smelt",
        "min_size": "No size limit",
        "daily_limit": "2 gallons",
        "possession_seasons": ["Open All Year"],
        "notes": "See p. 23 for General Netting Regulations.",
    },
    {
        "id": "burbot",
        "name": "Burbot (Eelpout)",
        "min_size": "No size limit",
        "daily_limit": "5",
        "possession_seasons": ["Open All Year"],
        "notes": None,
    },
    {
        "id": "all-others",
        "name": "All other species (bullheads, carp, suckers, etc.)",
        "min_size": "No size limit",
        "daily_limit": "No possession limit",
        "possession_seasons": ["Open All Year"],
        "notes": "Includes all nongame fish not listed above.",
    },
]


def parse_general_fishing_regs(pages: dict[int, str]) -> list[RegulationDoc]:
    """
    Parse the General Fishing Regulations section (physical pages 14-15).

    These are the species-specific regs (walleye, bass, pike, etc.) — the
    baseline for any water that isn't classified as trout water. We extract
    each species into a structured record with min size, daily limit, and
    possession season. The full text is also included as a RegulationDoc
    for the "view the raw PDF page" feature.
    """
    docs = []
    text = "\n".join(pages.get(p, "") for p in [14, 15])
    # Keep the full text as a doc too (for reference / fallback)
    docs.append(RegulationDoc(
        id="general-raw",
        title="General Fishing Regulations (raw text)",
        category="general",
        body=text.strip(),
        source_pages=[14, 15],
    ))
    return docs


def get_species_regulations() -> list[dict]:
    """
    Return the structured statewide species regulations. This data is
    hand-curated from the 2026 PDF General Fishing Regulations table
    (physical pp. 14-15). For per-county overrides, see parse_county_exceptions.
    """
    return STATEWIDE_SPECIES_REGS


def parse_special_regs(pages: dict[int, str]) -> list[RegulationDoc]:
    """Parse Lake Sturgeon, Bow/Spear, Great Lakes Trout/Salmon, etc."""
    docs = []
    # Lake Sturgeon: physical page 17
    docs.append(RegulationDoc(
        id="lake-sturgeon",
        title="Lake Sturgeon Regulations",
        category="special",
        body=pages.get(17, "").strip(),
        source_pages=[17],
    ))
    # Bow & Spearfishing: physical pages 18-19
    docs.append(RegulationDoc(
        id="bow-spear",
        title="Bow & Spearfishing Regulations",
        category="special",
        body="\n---\n".join(pages.get(p, "") for p in [18, 19]).strip(),
        source_pages=[18, 19],
    ))
    # Great Lakes Trout & Salmon: physical page 20
    docs.append(RegulationDoc(
        id="gl-trout-salmon",
        title="Great Lakes Trout & Salmon Regulations",
        category="great_lakes",
        body=pages.get(20, "").strip(),
        source_pages=[20],
    ))
    return docs


def parse_county_exceptions(pages: dict[int, str]) -> list[RegulationDoc]:
    """
    Parse physical pages 30-33: Exceptions to General Regulations by County.

    These are county-specific overrides of the general fishing regs. The
    page layout is: county name as a header, then free-text paragraphs
    describing the exceptions (gear, season, size limit, etc.) for that
    county. The text often references specific species (bass, walleye, etc.)
    by name.

    We extract a list of (county, exceptions_text) pairs. The frontend
    shows these alongside the statewide species rules.
    """
    docs = []
    text = "\n---\n".join(pages.get(p, "") for p in [30, 31, 32, 33])
    docs.append(RegulationDoc(
        id="county-exceptions",
        title="Exceptions to General Regulations by County",
        category="exception",
        body=text.strip(),
        source_pages=[30, 31, 32, 33],
    ))
    return docs


def get_county_exceptions_by_county() -> dict[str, str]:
    """
    Parse the County Exceptions section and return a {county: exceptions_text}
    dict. The PDF lists counties alphabetically on physical pp. 30-33 in a
    2-COLUMN layout: county name header in the left OR right column, then
    free-text paragraphs below. The county name header line often has the
    FIRST line of the OTHER column's content glued onto the same line in
    pdftotext output, e.g. "                      Allegan                            unweighted hook..."

    We detect a county header by: take the first whitespace-bounded token
    of the line, and if it's a county name, treat the line as a header.
    Then capture the text up to the next header.

    This is used to surface per-county overrides when a user picks a county
    on the map or filters by species.
    """
    text_pages = []
    for p in [30, 31, 32, 33]:
        page_text = run_pdftotext("-f", str(p), "-l", str(p))
        text_pages.append(page_text)
    full_text = "\n".join(text_pages)

    county_set = set(MICHIGAN_COUNTIES)
    lines = full_text.splitlines()

    # First pass: find lines where the FIRST whitespace-delimited token
    # is a county name. This catches both left-column and right-column
    # county headers.
    line_to_county: dict[int, str] = {}
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        first_token = stripped.split()[0]
        if first_token in county_set:
            line_to_county[i] = first_token

    # For each match, capture the text up to the next match (or end of doc)
    out: dict[str, str] = {}
    sorted_lines = sorted(line_to_county.keys())
    for i, line_idx in enumerate(sorted_lines):
        county = line_to_county[line_idx]
        start = line_idx + 1
        end = sorted_lines[i + 1] if i + 1 < len(sorted_lines) else len(lines)
        chunk_lines = lines[start:end]
        # The right-column content is glued onto the left column's data lines.
        # Each line has whitespace from ~col 70 onwards, then real text. We
        # find the LONGEST run of consecutive spaces in the line and split
        # there. This works because the column gutter has more spaces than
        # any intra-column spacing.
        cleaned = []
        for cl in chunk_lines:
            # Find the longest whitespace run (the column gutter)
            # Skip leading whitespace
            content_start = len(cl) - len(cl.lstrip())
            rest = cl[content_start:]
            if not rest.strip():
                # Line is all whitespace
                continue
            # Find the longest run of spaces in the line (the column gutter)
            m = re.search(r" {6,}", rest)
            if m:
                # Split at the longest whitespace run
                col_split = content_start + m.start()
                left = cl[:col_split].rstrip()
            else:
                # No clear gutter — keep the whole line
                left = cl.rstrip()
            # If the left side is empty, skip
            if not left.strip():
                continue
            cleaned.append(left)
        chunk = "\n".join(cleaned).strip()
        # Clean up page footer artifacts
        chunk = re.sub(r"\s*\d+\s*\n\s*2026 Michigan Fishing Regulations\s*", " ", chunk)
        chunk = re.sub(r"\n{3,}", "\n\n", chunk)
        # Skip if we already have a longer entry (keep the longest)
        if len(chunk) > len(out.get(county, "")):
            out[county] = chunk
    return out


def parse_type_regulation_tables() -> dict:
    """
    Extract the Type A-F (lakes) and Type 1-4 (streams) regulation tables
    from physical pages 44 and 45 of the PDF. These pages have text
    extractable cleanly (no OCR needed).

    Page layout (physical):
      - Page 44: Inland Lake Type A-F regulations table
      - Page 45: Inland Stream Type 1-4 regulations table + BTRA list

    The table is heavily column-formatted with rotated headers. We use
    pdftotext -tsv to get word positions, then group words by y-coordinate
    (row) and x-coordinate (column) to extract the table cells.
    """
    out: dict = {"lake_types": {}, "stream_types": {}, "_ocr_quality": "high"}

    lake_words = _extract_words_tsv(44, 44)
    out["lake_types"] = _parse_lake_type_table(lake_words)

    stream_words = _extract_words_tsv(45, 45)
    out["stream_types"] = _parse_stream_type_table(stream_words)

    return out


def _extract_words_tsv(start: int, end: int) -> list[dict]:
    """Extract word positions from physical page range via pdftotext -tsv."""
    result = subprocess.run(
        ["pdftotext", "-tsv", "-f", str(start), "-l", str(end), str(PDF_PATH), "-"],
        capture_output=True, text=True, check=True,
    )
    words = []
    for line in result.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        try:
            text = parts[11]
            if text in ("###FLOW###", "###LINE###", "###PAGE###", ""):
                continue
            words.append({
                "left": float(parts[6]),
                "top": float(parts[7]),
                "text": text,
            })
        except (ValueError, IndexError):
            continue
    return words


def _is_sidebar(w: dict) -> bool:
    """
    Detect the vertical sidebar text on the left edge (x < 25). The sidebar
    consists of single uppercase letters or punctuation like '&', 'N', 'D'
    that are part of the running header. Multi-character tokens (like "(13")
    are data, not sidebar.
    """
    if w["left"] >= 25:
        return False
    if len(w["text"]) > 1:
        return False
    if w["text"] in "ABCDEFGHIJKLMNOPQRSTUVWXYZ&ND":
        return True
    return False


def _parse_lake_type_table(words: list[dict]) -> dict:
    """
    Parse Lake Types A-F from page 44. The table is fragmented across
    multiple y-coords because of date wrapping. We anchor on each type
    letter (A-F) and gather surrounding data within tolerance.
    """
    out: dict = {}
    data = [w for w in words if not _is_sidebar(w)]

    # Find type letter positions: a single capital letter at x ~ 48
    type_letters = [w for w in data
                    if w["text"] in "ABCDEF" and 45 <= w["left"] <= 55]
    # De-dupe by y (5-point tolerance), keep only data-region letters
    seen = set()
    unique = []
    for w in type_letters:
        yk = round(w["top"] / 5) * 5
        if yk not in seen and 200 <= w["top"] <= 450:
            seen.add(yk)
            unique.append(w)

    for lw in unique:
        letter = lw["text"]
        ay = lw["top"]
        # Data row: count is ~9 below the letter, season-wrap is up to 18
        # below. We use 0-14 range to stay in this row.
        nearby = [w for w in data if 0 < w["top"] - ay < 14]

        # Count: text like "(60" — pdftotext gives us "(60" with the
        # opening paren attached and the closing paren as a separate word.
        count = None
        for w in nearby:
            if 30 < w["left"] < 50:
                m = re.match(r"^\((\d+)$", w["text"])
                if m:
                    count = m.group(1)
                    break

        # Daily limit
        daily = None
        for w in nearby:
            if 170 < w["left"] < 200:
                if re.match(r"^\d+/\d+[\*\^]?$", w["text"]):
                    daily = w["text"]
                    break
                if w["text"] in ("1", "3", "5"):
                    daily = w["text"]
                    break

        # Size limits (5 columns at x ~ 209, 241, 276, 310, 347)
        sizes = {}
        for w in nearby:
            if re.match(r'^\d+"$', w["text"]):
                x = w["left"]
                if 200 <= x <= 220:   sizes["brook_trout"] = w["text"]
                elif 230 <= x <= 250: sizes["brown_trout"] = w["text"]
                elif 265 <= x <= 285: sizes["rainbow_trout"] = w["text"]
                elif 300 <= x <= 320: sizes["lake_trout"] = w["text"]
                elif 335 <= x <= 355: sizes["atlantic_chinook_coho_pink_salmon"] = w["text"]

        # Season: text at x 65-170 in the row
        season_words = []
        for w in nearby:
            if 65 < w["left"] < 170:
                if w["text"] in ("All", "except", "minnows", "5/3*", "5/3^", "1", "3", "5", "**"):
                    continue
                if re.match(r'^\d+"$', w["text"]):
                    continue
                season_words.append((w["top"], w["left"], w["text"]))
        season_words.sort()
        season = re.sub(r"\s+", " ", " ".join(w[2] for w in season_words)).strip()

        # Tackle
        tackle_words = []
        for w in nearby:
            if 100 < w["left"] < 170 and w["text"] in ("All", "except", "minnows"):
                tackle_words.append(w["text"])
        tackle = " ".join(tackle_words).strip() if tackle_words else "All"

        out[letter] = {
            "label": f"Type {letter}",
            "count": f"{count or '?'} lakes",
            "season": season or "See PDF",
            "tackle": tackle,
            "daily_limit": daily or "See PDF",
            "size_limits": sizes,
            "plain": (
                f"Type {letter} ({count or '?'} lakes)\n"
                f"Season: {season or 'See PDF'}\n"
                f"Tackle: {tackle}\n"
                f"Daily/possession limit: {daily or 'See PDF'}\n"
                f"Brook Trout min: {sizes.get('brook_trout', '—')}\n"
                f"Brown Trout min: {sizes.get('brown_trout', '—')}\n"
                f"Rainbow Trout min: {sizes.get('rainbow_trout', '—')}\n"
                f"Lake Trout min: {sizes.get('lake_trout', '—')}\n"
                f"Atlantic/Chinook/Coho/Pink Salmon min: {sizes.get('atlantic_chinook_coho_pink_salmon', '—')}"
            ),
        }
    return out


def _parse_stream_type_table(words: list[dict]) -> dict:
    """
    Parse Stream Types 1-4 from page 45. Similar to lake table, but with
    3 size columns (brook, brown, salmon/lake/rainbow/splake) instead of 5.
    """
    out: dict = {}
    data = [w for w in words if not _is_sidebar(w)]

    # Type numbers at x ~ 39
    type_nums = [w for w in data if w["text"] in "1234" and 35 <= w["left"] <= 45]
    seen = set()
    unique = []
    for w in type_nums:
        yk = round(w["top"] / 5) * 5
        if yk not in seen and 150 <= w["top"] <= 450:
            seen.add(yk)
            unique.append(w)

    for nw in unique:
        num = nw["text"]
        ay = nw["top"]
        # Stream data row spans both above and below the type number
        # (season text is above, count and sizes are below). Exclude the
        # type number word itself so we don't pick it up as the count.
        nearby = [w for w in data
                  if not (w["left"] == nw["left"] and w["top"] == nw["top"] and w["text"] == nw["text"])
                  and abs(w["top"] - ay) < 25]

        # Count
        count = None
        for w in nearby:
            if 15 < w["left"] < 50:
                m = re.match(r"^\(?(\d+,?\d*)$", w["text"])
                if m:
                    count = m.group(1)
                    break

        # Season: the table has TWO season columns (Fishing Season,
        # Possession Season) side by side. We extract the LEFT column only
        # (Fishing Season), which is at x < 100. The right column (at
        # x > 100) is the Possession Season and is usually identical or
        # a more specific version of the same rule.
        season_words = []
        for w in nearby:
            if 60 < w["left"] < 100 and abs(w["top"] - ay) < 25:
                if re.match(r'^\d+"$', w["text"]):
                    continue
                season_words.append((w["top"], w["left"], w["text"]))
        season_words.sort()
        season = re.sub(r"\s+", " ", " ".join(w[2] for w in season_words)).strip()

        # Sizes (3 columns for streams: brook, brown, salmon/lake/rainbow/splake)
        # The "15" or greater" column at x=331 is the daily-limit text, not a size.
        sizes = {}
        for w in nearby:
            if re.match(r'^\d+"$', w["text"]) and abs(w["top"] - ay) < 25:
                x = w["left"]
                if 160 <= x <= 190:   sizes["brook_trout"] = w["text"]
                elif 200 <= x <= 220: sizes["brown_trout"] = w["text"]
                elif 240 <= x <= 270: sizes["salmon_lake_trout_rainbow_splake"] = w["text"]

        out[num] = {
            "label": f"Type {num}",
            "count": f"{count or '?'} streams",
            "season": season or "See PDF",
            "size_limits": sizes,
            "daily_limit": "5 fish daily, but no more than 3 trout 15\" or greater. See pp. 48–65 for exceptions.",
            "plain": (
                f"Type {num} ({count or '?'} streams)\n"
                f"Season: {season or 'See PDF'}\n"
                f"Brook Trout min: {sizes.get('brook_trout', '—')}\n"
                f"Brown Trout min: {sizes.get('brown_trout', '—')}\n"
                f"Salmon/Lake Trout/Rainbow Trout/Splake min: {sizes.get('salmon_lake_trout_rainbow_splake', '—')}\n"
                f"Daily limit: 5 fish, but no more than 3 trout 15\" or greater"
            ),
        }

    out["BTRA"] = {
        "label": "Brook Trout Restoration Areas (BTRA)",
        "plain": (
            "Brook Trout Restoration Areas have stricter regulations than the "
            "Type 1-4 streams they overlap with:\n"
            "  - Possession season: Last Saturday in April – Sep. 30\n"
            "  - Min size for Brook Trout, Lake Trout, Splake: 20\"\n"
            "  - Daily possession: 1 fish total combined (Brook/Lake/Splake)"
        ),
    }
    return out


# ---------------------------------------------------------------------------
# Wikipedia waterbody merge
# ---------------------------------------------------------------------------

WIKI_PATH = REPO_ROOT / "data" / "wikipedia_waterbodies.json"


def _normalize_name(name: str) -> str:
    """Normalize a waterbody name for fuzzy matching:
    - Lowercase
    - Strip parenthetical qualifiers like "(Michigan)" or "(Alcona County)"
    - Collapse whitespace
    """
    s = name.lower()
    s = re.sub(r"\s*\([^)]*\)\s*", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def merge_wikipedia_waterbodies(
    pdf_lakes: list, pdf_streams: list
) -> list[dict]:
    """
    Build a unified waterbodies array combining the PDF trout/salmon
    listings with the broader Wikipedia list of all named Michigan
    bodies of water. Each entry has:
      - name: display name
      - county: the Michigan county
      - source: "pdf" (trout/salmon water with specific regs), "wikipedia" (named body, no specific regs)
      - kind: "lake" | "river" | "stream" | "pond" | "bay" | "harbor" | "channel" | "creek" (best guess from name)
      - wikipedia_title: the original Wikipedia article title (if from wiki)
      - pdf_record: optional reference to the PDF lake/stream record (if from PDF)

    For waterbodies that appear in BOTH PDF and Wikipedia, we keep the
    PDF entry (it has the trout regulation) but include the Wikipedia
    title for linkability.
    """
    if not WIKI_PATH.exists():
        print(f"[parse]   (Wikipedia data not found at {WIKI_PATH} — skipping merge)")
        return []

    with WIKI_PATH.open() as f:
        wiki = json.load(f)

    # Build a normalized-name -> (county, wiki_title) lookup
    wiki_lookup: dict[tuple[str, str], str] = {}
    for county, names in wiki.get("counties", {}).items():
        for n in names:
            norm = _normalize_name(n)
            wiki_lookup[(norm, county)] = n

    # Build a set of PDF entries' normalized (name, county) for de-dup
    pdf_keys: set[tuple[str, str]] = set()
    pdf_entries: list[dict] = []
    for l in pdf_lakes:
        display_name = l.clean_name or l.name
        key = (_normalize_name(display_name), l.county)
        pdf_keys.add(key)
        pdf_entries.append({
            "name": display_name,
            "county": l.county,
            "source": "pdf",
            "kind": "lake",
            "type": l.type,
            "pdf_record": asdict(l),
            "wikipedia_title": wiki_lookup.get(key),
        })
    for s in pdf_streams:
        display_name = s.clean_name or s.name
        key = (_normalize_name(display_name), s.county)
        pdf_keys.add(key)
        pdf_entries.append({
            "name": display_name,
            "county": s.county,
            "source": "pdf",
            "kind": _guess_kind(display_name),
            "type": s.type,
            "section": s.section,
            "closure": s.closure,
            "pdf_record": asdict(s),
            "wikipedia_title": wiki_lookup.get(key),
        })

    # Add Wikipedia entries that aren't already in PDF
    wiki_only_count = 0
    for county, names in wiki.get("counties", {}).items():
        for n in names:
            clean_n = clean_waterbody_name(n)
            key = (_normalize_name(clean_n), county)
            if key in pdf_keys:
                continue
            pdf_entries.append({
                "name": clean_n,
                "county": county,
                "source": "wikipedia",
                "kind": _guess_kind(clean_n),
                "wikipedia_title": n,
            })
            wiki_only_count += 1

    print(f"[parse]   → {len(pdf_entries)} total ({len(pdf_keys)} PDF, {wiki_only_count} Wikipedia-only)")
    return pdf_entries


def _guess_kind(name: str) -> str:
    """Best-guess classification from the name. Used for the kind field
    in the waterbodies array so the UI can show appropriate icons."""
    n = name.lower()
    if "river" in n or "riv." in n:
        return "river"
    if "creek" in n or "cr." in n:
        return "creek"
    if "pond" in n:
        return "pond"
    if "bay" in n:
        return "bay"
    if "harbor" in n or "harbour" in n:
        return "harbor"
    if "channel" in n:
        return "channel"
    if "stream" in n:
        return "stream"
    if "brook" in n:
        return "creek"
    if "lake" in n or "lk." in n or "lks." in n:
        return "lake"
    return "lake"  # default


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    print(f"[parse] PDF: {PDF_PATH}")
    print(f"[parse] Output: {OUTPUT_PATH}")
    print(f"[parse] Extracting pages...")
    pages = extract_all_pages()
    print(f"[parse] Got text from {len(pages)} pages")

    print(f"[parse] Parsing county listings (lakes + streams)...")
    lakes, streams, county_order = parse_county_listings(pages)
    print(f"[parse]   → {len(lakes)} lakes, {len(streams)} streams across {len(county_order)} counties")

    print(f"[parse] Parsing general fishing regulations...")
    general = parse_general_fishing_regs(pages)
    print(f"[parse]   → {len(general)} doc(s)")

    print(f"[parse] Parsing special regulations (sturgeon, bow/spear, GL)...")
    special = parse_special_regs(pages)
    print(f"[parse]   → {len(special)} doc(s)")

    print(f"[parse] Parsing county exceptions...")
    exceptions = parse_county_exceptions(pages)
    print(f"[parse]   → {len(exceptions)} doc(s)")

    print(f"[parse] Parsing Type regulation tables (pp. 44-45)...")
    type_tables = parse_type_regulation_tables()
    print(f"[parse]   → {len(type_tables['lake_types'])} lake types, {len(type_tables['stream_types'])} stream types parsed")

    print(f"[parse] Parsing species regulations (statewide + per-county overrides)...")
    species_statewide = get_species_regulations()
    county_exceptions_by_county = get_county_exceptions_by_county()
    print(f"[parse]   → {len(species_statewide)} statewide species, {len(county_exceptions_by_county)} counties with exceptions")

    print(f"[parse] Merging Wikipedia waterbody list (all named MI bodies of water)...")
    waterbodies_merged = merge_wikipedia_waterbodies(lakes, streams)
    print(f"[parse]   → {len(waterbodies_merged)} total waterbodies (PDF trout + Wikipedia named)")

    # Per-county waterbody count from the unified waterbodies array
    waterbodies_by_county = defaultdict(int)
    for wb in waterbodies_merged:
        waterbodies_by_county[wb["county"]] += 1

    # Stats per county (for sanity check)
    lakes_by_county = defaultdict(int)
    streams_by_county = defaultdict(int)
    for l in lakes:
        lakes_by_county[l.county] += 1
    for s in streams:
        streams_by_county[s.county] += 1

    output = {
        "source": {
            "title": "2026 Michigan Fishing Regulations",
            "publisher": "Michigan Department of Natural Resources",
            "effective": "April 1, 2026 – March 31, 2027",
            "pdf": "data/2026-Michigan-Fishing-Regulations.pdf",
        },
        "meta": {
            "lake_count": len(lakes),
            "stream_count": len(streams),
            "waterbody_count": len(waterbodies_merged),
            "county_count": len(county_order),
            "type_tables_have_ocr": True,
            "species_count": len(species_statewide),
            "counties_with_exceptions": len(county_exceptions_by_county),
        },
        "lakes": [asdict(l) for l in lakes],
        "streams": [asdict(s) for s in streams],
        "waterbodies": waterbodies_merged,
        "wikipedia_source": {
            "url": "https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county",
            "license": "CC BY-SA 4.0",
            "attribution": "Wikipedia contributors",
            "note": "Waterbody names only. Wikipedia is not the authoritative source for fishing regulations — see the 2026 Michigan Fishing Regulations PDF for legal rules.",
        },
        "documents": [asdict(d) for d in general + special + exceptions],
        "type_tables": type_tables,
        "species": {
            "statewide": species_statewide,
            "county_exceptions": county_exceptions_by_county,
        },
        "counties": {
            "order": MICHIGAN_COUNTIES,  # all 83 counties, alphabetical
            "stats": {
                c: {
                    "lakes": lakes_by_county.get(c, 0),
                    "streams": streams_by_county.get(c, 0),
                    "waterbodies": waterbodies_by_county.get(c, 0),
                    "has_general_species": True,  # every county gets the general warmwater baseline
                    "has_exceptions": c in county_exceptions_by_county,
                }
                for c in MICHIGAN_COUNTIES  # iterate all 83
            },
        },
    }

    OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"[parse] Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
