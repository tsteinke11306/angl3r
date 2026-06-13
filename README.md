# angl3r — Michigan Fishing Regulations

A fast, mobile-first lookup site for Michigan fishing regulations. Search by
lake name, stream section, or county. Regulations come from the official
[DNR 2026 Fishing Regulations](https://www.michigan.gov/dnr/things-to-do/fishing)
PDF; the broader waterbody list comes from
[Wikipedia's category tree](https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county)
(CC BY-SA 4.0). Historical fish survey data comes from the
[CHANGES-UM dataset](https://doi.org/10.5281/zenodo.15389937) (CC BY 4.0),
supplemented by the DNR fish stocking database and Status of the Fishery
reports. The site is rebuilt automatically when the PDF is updated.

🌐 **Live site:** https://tsteinke11306.github.io/angl3r/

**At a glance:** 1,158 named waterbodies across all 83 Michigan counties,
14 fish species with statewide regulations, per-county exceptions for
45 counties, and historical species data for ~71% of waterbodies.

## How it works

1. The Michigan DNR publishes a fresh fishing regulations PDF every spring.
2. Drop the new PDF in `data/` and commit.
3. The GitHub Action re-parses the PDF, regenerates `data/regs.json`, rebuilds
   the site, and deploys to GitHub Pages.
4. The site loads the JSON as a static asset (no backend, no API).
5. The waterbody list comes from a one-time crawl of Wikipedia's category
   tree (saved to `data/wikipedia_waterbodies.json`).

## Tech stack

- **Vite + vanilla TypeScript** — no framework, fast and small
- **CSS only** — no Tailwind, no UI library
- **Python** for the PDF parser (`pdftotext` + table-extraction heuristics)
- **Wikipedia MediaWiki API** for the broad waterbody list
- **GitHub Pages** for hosting, **GitHub Actions** for CI/CD

## Local development

```bash
# First, install system deps (Linux)
sudo apt-get install -y poppler-utils

# Optional: use a virtual environment instead of --break-system-packages
python3 -m venv .venv
source .venv/bin/activate
pip install pdfminer.six pypdf fuzzywuzzy python-Levenshtein

# Install JS deps
npm install

# Parse the PDF (outputs to data/regs.json)
python3 scripts/parse_pdf.py

# Map historical species data into regs.json
python3 scripts/map_species_by_waterbody.py \
  --regs data/regs.json \
  --survey-zip /path/to/summ_fishc_grow-v1.0.0.zip \
  --inject

# Copy the generated data into public/ for the dev server
cp data/regs.json public/data/regs.json

# Run the dev server (with hot reload)
npm run dev
# Open the URL printed in the terminal (usually http://localhost:5173/angl3r/)
```

## Data sources and quality

The site combines several sources:

| Source | What it gives | Count | License |
|---|---|---|---|
| [DNR 2026 PDF](https://www.michigan.gov/dnr/things-to-do/fishing) | Trout/salmon waterbodies, Type A–F & 1–4 regs, species tables, county exceptions | 292 waterbodies, 14 species, 45 counties with exceptions | Public domain (state govt) |
| [Wikipedia category tree](https://en.wikipedia.org/wiki/Category:Bodies_of_water_of_Michigan_by_county) | Named waterbodies (lakes, rivers, creeks, ponds, bays, etc.) per county | 866 waterbodies | CC BY-SA 4.0 |
| [CHANGES-UM historical surveys](https://doi.org/10.5281/zenodo.15389937) | Fish species presence from 78 years of DNR surveys | ~44% of lake/pond records | CC BY 4.0 |
| DNR Fish Stocking CSV | Stocked species by waterbody (1979–2026) | 46 additional lakes + 490 river segments | Public domain (state govt) |
| DNR Status of the Fishery reports | Biologist survey species lists | 18 additional lakes | Public domain (state govt) |

**Total: 1,158 named waterbodies across all 83 Michigan counties.**

Wikipedia provides the broader list of named waterbodies; the PDF provides
the actual regulations. PDF-sourced entries get a Type regulation section +
a link to the original PDF page; Wikipedia-sourced entries get a Wikipedia
link and a "no specific trout designation" note. Historical species data is
shown in the detail panel when available, with confirmed species highlighted
and sorted to the top.

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
- **Historical species coverage is ~71%** of waterbodies. Small or
  under-surveyed lakes may show "No historical survey data available."
  The DNR fish stocking database remains the authoritative source for
  recently stocked waters.

If you find a specific waterbody that's missing or wrong, please open an
issue or PR.

## Repo layout

```
angl3r/
├── data/
│   ├── 2026-Michigan-Fishing-Regulations.pdf     # the source PDF
│   ├── wikipedia_waterbodies.json                # the Wikipedia crawl output
│   └── regs.json                                 # generated, parsed data
├── public/
│   ├── data/regs.json                            # copy consumed by the site
│   ├── topo-bg.svg                               # hero background pattern
│   ├── angler-icon.svg                           # favicon source
│   ├── logo.png                                  # site logo + favicon
│   └── .nojekyll                                 # skip Jekyll processing
├── scripts/
│   ├── parse_pdf.py                              # PDF + Wikipedia → JSON
│   ├── map_species_by_waterbody.py               # CHANGES-UM → species_by_waterbody
│   ├── scrape_status_fishery_pdfs.py             # DNR Status Fishery reports scraper
│   └── update_docs.py                            # Re-extract regulation docs from PDF
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

1. Save the new PDF as `data/<year>-Michigan-Fishing-Regulations.pdf`.
2. Update the year in `scripts/parse_pdf.py` (the `PDF_PATH` constant) and
   in `.github/workflows/deploy.yml`.
3. Update the effective date and source title in `scripts/parse_pdf.py` if
   they changed.
4. Commit and push — the action will regenerate everything and deploy.

