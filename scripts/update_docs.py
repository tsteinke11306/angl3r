#!/usr/bin/env python3
"""
Update regs.json with improved parsed text for General Fishing Regs,
Great Lakes Trout & Salmon, and Lake Sturgeon sections.
"""
import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = REPO_ROOT / "data" / "2026-Michigan-Fishing-Regulations.pdf"
OUTPUT_PATH = REPO_ROOT / "data" / "regs.json"

def run_pdftotext(pages: list[int]) -> str:
    """Extract text from specific physical pages using pdftotext -layout."""
    args = ["pdftotext", "-layout", "-f", str(pages[0]), "-l", str(pages[-1]), str(PDF_PATH), "-"]
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout

def remove_page_footers(text: str) -> str:
    """Strip footer lines like '  12\n  2026 Michigan Fishing Regulations' from each page block."""
    # Heuristic: remove line-pairs that look like page numbers followed by brochure footer
    lines = text.splitlines()
    out = []
    skip_next = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if skip_next:
            skip_next = False
            continue
        # Detect a line that is just a page number (digit or digit range, maybe with leading spaces)
        if re.fullmatch(r"\s*\d+\s*", stripped):
            # If next line contains "2026 Michigan Fishing Regulations", skip both
            if i + 1 < len(lines) and "2026 Michigan Fishing Regulations" in lines[i + 1]:
                skip_next = True
                continue
        if "2026 Michigan Fishing Regulations" in stripped:
            continue
        out.append(line)
    return "\n".join(out)

def clean_whitespace(text: str) -> str:
    lines = text.splitlines()
    out = []
    prev_blank = True
    for line in lines:
        stripped = line.strip()
        if stripped == "\x0c":
            continue
        if not stripped:
            if not prev_blank:
                out.append("")
            prev_blank = True
            continue
        out.append(line.rstrip())
        prev_blank = False
    return "\n".join(out).strip()

def extract_general_regs() -> str:
    text = run_pdftotext([14, 15])
    text = remove_page_footers(text)
    text = clean_whitespace(text)
    return text

def extract_sturgeon_regs() -> str:
    text = run_pdftotext([17])
    text = remove_page_footers(text)
    text = clean_whitespace(text)
    return text

def extract_great_lakes_regs() -> str:
    # Pages 20 (main table / notes) and 22 (Lake Trout & Splake tables)
    text = run_pdftotext([20, 22])
    text = remove_page_footers(text)
    text = clean_whitespace(text)
    return text

if __name__ == "__main__":
    import re
    with open(OUTPUT_PATH) as f:
        data = json.load(f)

    # Update general doc
    general_body = extract_general_regs()
    for doc in data["documents"]:
        if doc["category"] == "general":
            doc["body"] = general_body
            doc["source_pages"] = [14, 15]
            doc["title"] = "General Fishing Regulations"
            break
    else:
        data["documents"].append({
            "id": "general",
            "title": "General Fishing Regulations",
            "category": "general",
            "body": general_body,
            "source_pages": [14, 15],
        })

    # Update sturgeon doc
    sturgeon_body = extract_sturgeon_regs()
    for doc in data["documents"]:
        if doc["category"] == "special" and "Sturgeon" in doc["title"]:
            doc["body"] = sturgeon_body
            doc["source_pages"] = [17]
            doc["title"] = "Lake Sturgeon Regulations"
            break
    else:
        data["documents"].append({
            "id": "sturgeon",
            "title": "Lake Sturgeon Regulations",
            "category": "special",
            "body": sturgeon_body,
            "source_pages": [17],
        })

    # Update great_lakes doc
    great_lakes_body = extract_great_lakes_regs()
    for doc in data["documents"]:
        if doc["category"] == "great_lakes":
            doc["body"] = great_lakes_body
            doc["source_pages"] = [20, 22]
            doc["title"] = "Great Lakes Trout & Salmon Regulations"
            break
    else:
        data["documents"].append({
            "id": "great-lakes-trout-salmon",
            "title": "Great Lakes Trout & Salmon Regulations",
            "category": "great_lakes",
            "body": great_lakes_body,
            "source_pages": [20, 22],
        })

    with open(OUTPUT_PATH, "w") as f:
        json.dump(data, f, indent=2)
    print("Updated", OUTPUT_PATH)
