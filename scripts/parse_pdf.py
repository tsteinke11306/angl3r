#!/usr/bin/env python3
"""
parse_pdf.py — Extract Michigan fishing regulations from the annual DNR PDF.

Input:  data/<year>-Michigan-Fishing-Regulations.pdf
Output: data/regs.json  (committed to repo, consumed by the static site)

The PDF is the 2026 edition, 76 pages, made in Adobe InDesign. Text extraction
is mostly clean via `pdftotext -layout` except for the two Type regulation
tables (physical pages 42-43) which are scanned images and need OCR.

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
    "Kent", "Keweenaw", "Lake", "LARP", "Lapeer", "Leelanau", "Lenawee",
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

    # Cleanup: collapse whitespace in section descriptions
    for s in streams:
        s.section = re.sub(r"\s+", " ", s.section).strip()
        s.closure = re.sub(r"\s+", " ", s.closure).strip()

    return lakes, streams, county_order


def parse_general_fishing_regs(pages: dict[int, str]) -> list[RegulationDoc]:
    """
    Parse the General Fishing Regulations section (physical pages 14-15).

    These are the species-specific regs (walleye, bass, pike, etc.) — the
    fallback when a lake/stream isn't classified as trout water.
    """
    docs = []
    text = "\n".join(pages.get(p, "") for p in [14, 15])
    # The general regs are organized by species with size limits, seasons,
    # creel limits. We capture the whole text block as one doc and let the
    # frontend display it.
    docs.append(RegulationDoc(
        id="general",
        title="General Fishing Regulations",
        category="general",
        body=text.strip(),
        source_pages=[14, 15],
    ))
    return docs


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

    These are county-specific overrides of the general fishing regs.
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


def parse_type_regulation_tables() -> dict:
    """
    OCR the two scanned pages (42, 43) that contain:
      - p. 42: Inland Lake Type A-F regulation table
      - p. 43: Inland Stream Type 1-4 regulation table

    These pages are images, so we extract them as JPEGs and run tesseract.
    The output is the raw OCR text — the frontend renders it in a styled
    block. A more sophisticated parse (extracting the table cells) is a
    future improvement.
    """
    import tempfile

    out = {"lake_types": {}, "stream_types": {}, "_ocr_quality": "low"}

    for page in [42, 43]:
        img_dir = OCR_DIR / f"page_{page}"
        img_dir.mkdir(exist_ok=True)
        # Extract images
        subprocess.run(
            ["pdfimages", "-j", "-f", str(page), "-l", str(page),
             str(PDF_PATH), str(img_dir / "img")],
            check=True, capture_output=True,
        )
        # Run tesseract on each JPEG
        for img in sorted(img_dir.glob("*.jpg")):
            ocr_out = img_dir / (img.stem + "_ocr")
            subprocess.run(
                ["tesseract", str(img), str(ocr_out), "-l", "eng", "--psm", "6"],
                check=True, capture_output=True,
            )
            ocr_text = (ocr_out.with_suffix(".txt")).read_text()
            if page == 42:
                out["lake_types"]["_raw"] = ocr_text
            else:
                out["stream_types"]["_raw"] = ocr_text

    return out


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

    print(f"[parse] OCRing Type regulation tables (pp. 42-43)...")
    type_tables = parse_type_regulation_tables()
    print(f"[parse]   → OCR complete")

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
            "county_count": len(county_order),
            "type_tables_have_ocr": True,
        },
        "lakes": [asdict(l) for l in lakes],
        "streams": [asdict(s) for s in streams],
        "documents": [asdict(d) for d in general + special + exceptions],
        "type_tables": type_tables,
        "counties": {
            "order": county_order,
            "stats": {
                c: {"lakes": lakes_by_county.get(c, 0), "streams": streams_by_county.get(c, 0)}
                for c in county_order
            },
        },
    }

    OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"[parse] Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
