// Types matching the JSON output of scripts/parse_pdf.py

export interface Lake {
  name: string;
  county: string;
  type: string;          // "A" - "F"
  source_page: number;
}

export interface Stream {
  name: string;
  county: string;
  type: string;          // "1" - "4" | "GR" | "BTRA" | "SC"
  section: string;       // free-text section description
  closure: string;       // seasonal closure detail (rare)
  source_page: number;
}

export interface RegulationDoc {
  id: string;
  title: string;
  category: "general" | "inland_lake" | "inland_stream" | "exception" | "great_lakes" | "special";
  body: string;
  source_pages: number[];
}

export interface TypeTables {
  lake_types: { _raw: string } & Record<string, string>;
  stream_types: { _raw: string } & Record<string, string>;
  _ocr_quality: string;
}

export interface RegsData {
  source: {
    title: string;
    publisher: string;
    effective: string;
    pdf: string;
  };
  meta: {
    lake_count: number;
    stream_count: number;
    county_count: number;
    type_tables_have_ocr: boolean;
  };
  lakes: Lake[];
  streams: Stream[];
  documents: RegulationDoc[];
  type_tables: TypeTables;
  counties: {
    order: string[];
    stats: Record<string, { lakes: number; streams: number }>;
  };
}

// Human-friendly descriptions of regulation Types (these come from the
// scanned pp. 42-43 of the PDF — we display the OCR text in the UI but
// also keep short titles here for badges).
export const LAKE_TYPE_TITLES: Record<string, string> = {
  A: "Catch-and-Release, Artificial Lure",
  B: "Trout/Salmon, Daily Limit",
  C: "Trout/Salmon, Reduced Limit",
  D: "Brook Trout Focus",
  E: "Special Restrictions",
  F: "Reduced Limit, Special Gear",
};

export const STREAM_TYPE_TITLES: Record<string, string> = {
  "1": "Type 1 — Standard Inland Stream",
  "2": "Type 2 — Quality Trout Stream",
  "3": "Type 3 — Premium Trout Stream",
  "4": "Type 4 — Exceptional Trout Stream",
  GR: "Gear Restricted Stream",
  BTRA: "Brook Trout Restoration Area",
  SC: "Seasonal Closure",
};
