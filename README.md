# Angler — Michigan Fishing Regulations

A fast, mobile-first lookup site for Michigan fishing regulations. Search by
lake name, stream section, or county. Regulations come from the official
[DNR 2026 Fishing Regulations](https://www.michigan.gov/dnr/things-to-do/fishing)
PDF; the broader waterbody list comes from
[Wikipedia's category tree](https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county)
(CC BY-SA 4.0). The site is rebuilt automatically when the PDF is updated.

🌐 **Live site:** https://tsteinke11306.github.io/angler/

**At a glance:** 1,174 named waterbodies across all 83 Michigan counties,
14 fish species with statewide regulations, and per-county exceptions for
the 45 counties that have them.

## How it works

1. The Michigan DNR publishes a fresh fishing regulations PDF every spring
2. Drop the new PDF in `data/` and commit
3. The GitHub Action re-parses the PDF, regenerates `data/regs.json`, rebuilds
   the site, and deploys to GitHub Pages
4. The site loads the JSON as a static asset (no backend, no API)
5. The waterbody list comes from a one-time crawl of Wikipedia's category
   tree (saved to `data/wikipedia_waterbodies.json`). Re-run the crawl if
   you want a fresh list (see `scripts/fetch_wiki.py` if you write one).

## Tech stack

- **Vite + vanilla TypeScript** — no framework, fast and small
- **CSS only** — no Tailwind, no UI library
- **Python** for the PDF parser (`pdftotext` + table-extraction heuristics)
- **Wikipedia MediaWiki API** for the broad waterbody list
- **GitHub Pages** for hosting, **GitHub Actions** for CI/CD

## Local development

```bash
# First, install system deps (Linux)
sudo apt-get install -y poppler-utils tesseract-ocr
pip3 install --break-system-packages pdfminer.six pypdf

# Install JS deps
npm install

# Parse the PDF (outputs to data/regs.json and public/data/regs.json)
python3 scripts/parse_pdf.py
cp data/regs.json public/data/regs.json

# Run the dev server (with hot reload)
npm run dev
# Open the URL printed in the terminal (usually http://localhost:5173/angler/)
```

## Data sources and quality

The site combines two sources:

| Source | What it gives | Count | License |
|---|---|---|---|
| [DNR 2026 PDF](https://www.michigan.gov/dnr/things-to-do/fishing) | Trout/salmon waterbodies, Type A–F & 1–4 regs, species tables, county exceptions | 292 waterbodies, 14 species, 45 counties with exceptions | Public domain (state govt) |
| [Wikipedia category tree](https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county) | Named waterbodies (lakes, rivers, creeks, ponds, bays, etc.) per county | 882 waterbodies | CC BY-SA 4.0 |

**Total: 1,174 named waterbodies across all 83 Michigan counties.**

Wikipedia provides the broader list of named waterbodies; the PDF provides
the actual regulations. PDF-sourced entries get a Type regulation section +
a link to the original PDF page; Wikipedia-sourced entries get a Wikipedia
link and a "no specific trout designation" note.

### Known limitations

- **~90% recall** on the PDF trout listings (104 lakes, 188 streams). The
  remaining ~10% are usually on pages where multiple counties share a row.
- **Stream section descriptions** can have minor cross-contamination
  between adjacent entries due to the 2-column PDF layout. The (name,
  county, type) tuple is always correct; only the section description
  might leak.
- **45 of 83 counties have species-specific exceptions parsed.** The
  other 38 counties genuinely aren't listed in the PDF's County
  Exceptions section — the statewide species rules apply to them.
- **Per-waterbody species data** is not included. The PDF doesn't break
  down species by waterbody except via the trout Type system. Wikipedia
  articles are spotty on this. The site shows the statewide species rules
  for each waterbody; for a specific species-in-waterbody answer, the
  [DNR's fish stocking database](https://www.michigan.gov/dnr/things-to-do/fishing/fish-stocking) is the authoritative source.

If you find a specific waterbody that's missing or wrong, please open an
issue or PR.

## Repo layout

```
angler/
├── data/
│   ├── 2026-Michigan-Fishing-Regulations.pdf     # the source PDF
│   ├── wikipedia_waterbodies.json                # the Wikipedia crawl output
│   └── regs.json                                 # generated, parsed data
├── public/
│   ├── data/regs.json                            # copy consumed by the site
│   ├── topo-bg.svg                               # hero background pattern
│   ├── angler-icon.svg                           # favicon
│   └── .nojekyll                                 # skip Jekyll processing
├── scripts/
│   └── parse_pdf.py                              # PDF + Wikipedia → JSON
├── src/
│   ├── main.ts                                   # app entry
│   ├── search.ts                                 # search/match logic
│   ├── types.ts                                  # TypeScript types
│   └── styles.css                                # all styles
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .github/workflows/deploy.yml                  # CI/CD
```

## Updating for a new year

When the DNR releases the new PDF (usually in February/March):

1. Save the new PDF as `data/<year>-Michigan-Fishing-Regulations.pdf`
2. Update the year in `scripts/parse_pdf.py` (the `PDF_PATH` constant)
3. Update the year in `.github/workflows/deploy.yml` and `vite.config.ts`
4. Commit and push — the action will regenerate everything and deploy
