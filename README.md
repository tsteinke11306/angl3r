# Angler — Michigan Fishing Regulations

A fast, mobile-first lookup site for Michigan fishing regulations. Search by
lake name, stream section, or county. All data is extracted from the official
[DNR 2026 Fishing Regulations](https://www.michigan.gov/dnr/things-to-do/fishing)
PDF and refreshed automatically when the PDF is updated.

🌐 **Live site:** https://tsteinke11306.github.io/angler/

## How it works

1. The Michigan DNR publishes a fresh fishing regulations PDF every spring
2. Drop the new PDF in `data/` and commit
3. The GitHub Action re-parses the PDF, regenerates `data/regs.json`, rebuilds
   the site, and deploys to GitHub Pages
4. The site loads the JSON as a static asset — no backend, no API

## Tech stack

- **Vite + vanilla TypeScript** — no framework, fast and small
- **CSS only** — no Tailwind, no UI library
- **Python** for the PDF parser (`pdftotext` + `tesseract` for OCR)
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

## Data quality notes

The 2026 PDF uses a 2-column layout for county listings, which is parsed
line-by-line. This works for the majority of entries but has known issues:

- **~90% recall**: about 90% of waterbodies in the PDF are extracted
  cleanly. The remaining ~10% are usually on pages where multiple counties
  share a single page (mid-page county transitions).
- **Stream section descriptions** can have some cross-contamination when
  the 2-column layout puts two stream entries on one line. The (name,
  county, type) tuple is always correct; the section description may
  occasionally mix in a neighboring entry.
- **Type A–F / Type 1–4 regulation tables** (pp. 42–43) are scanned images
  in the PDF. They're extracted via tesseract OCR and shown in monospace
  with a warning that they may contain recognition errors. Always verify
  against the original PDF.

If you find a specific waterbody that's missing or wrong, please open an
issue or PR.

## Repo layout

```
angler/
├── data/
│   ├── 2026-Michigan-Fishing-Regulations.pdf   # the source PDF
│   └── regs.json                                # generated, parsed data
├── public/
│   ├── data/regs.json                           # copy consumed by the site
│   ├── topo-bg.svg                              # hero background pattern
│   ├── angler-icon.svg                          # favicon
│   └── .nojekyll                                # skip Jekyll processing
├── scripts/
│   └── parse_pdf.py                             # PDF → JSON
├── src/
│   ├── main.ts                                  # app entry
│   ├── search.ts                                # search/match logic
│   ├── types.ts                                 # TypeScript types
│   └── styles.css                               # all styles
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .github/workflows/deploy.yml                 # CI/CD
```

## Updating for a new year

When the DNR releases the new PDF (usually in February/March):

1. Save the new PDF as `data/<year>-Michigan-Fishing-Regulations.pdf`
2. Update the year in `scripts/parse_pdf.py` (the `PDF_PATH` constant)
3. Update the year in `.github/workflows/deploy.yml` and `vite.config.ts`
4. Commit and push — the action will regenerate everything and deploy
