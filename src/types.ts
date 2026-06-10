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

export interface TypeTableEntry {
  label: string;
  count?: string;
  season?: string;
  tackle?: string;
  daily_limit?: string;
  size_limits?: Record<string, string>;
  plain: string;
}

export interface Species {
  id: string;
  name: string;
  min_size: string;
  daily_limit: string;
  possession_seasons: string[];
  notes: string | null;
}

export interface SpeciesTables {
  statewide: Species[];
  county_exceptions: { [county: string]: string };  // raw text from PDF
}

export interface TypeTables {
  lake_types: {
    [letter: string]: TypeTableEntry;
  };
  stream_types: {
    [num: string]: TypeTableEntry;
  };
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
    waterbody_count?: number;
    county_count: number;
    type_tables_have_ocr: boolean;
    species_count?: number;
    counties_with_exceptions?: number;
    /** Historical survey dataset metadata (optional). */
    survey_source?: {
      title: string;
      publisher: string;
      doi: string;
      license: string;
      description: string;
    };
  };
  lakes: Lake[];
  streams: Stream[];
  /** Unified list of all named Michigan waterbodies (PDF + Wikipedia). */
  waterbodies: Waterbody[];
  /** Wikipedia category source metadata. */
  wikipedia_source?: {
    url: string;
    license: string;
    attribution: string;
    note: string;
  };
  documents: RegulationDoc[];
  type_tables: TypeTables;
  species: SpeciesTables;
  /** Historical fish survey data mapped per waterbody (county -> name -> entry). */
  species_by_waterbody?: {
    [county: string]: {
      [name: string]: {
        dataset_match?: string;
        match_score?: number;
        survey_records?: number;
        survey_years?: string[];
        species: string[];
        extras: string[];
        source: string | null;
        note?: string;
      };
    };
  };
  counties: {
    order: string[];
    stats: Record<string, {
      lakes: number;
      streams: number;
      waterbodies?: number;
      has_general_species: boolean;
      has_exceptions: boolean;
    }>;
  };
}

export interface Waterbody {
  name: string;
  county: string;
  source: "pdf" | "wikipedia";
  kind: "lake" | "river" | "stream" | "creek" | "pond" | "bay" | "harbor" | "channel";
  /** Type code for PDF entries (A-F, 1-4, GR, BTRA, SC). */
  type?: string;
  /** Section description for PDF streams. */
  section?: string;
  /** Closure info for PDF streams. */
  closure?: string;
  /** Wikipedia article title for linking. */
  wikipedia_title?: string;
  /** PDF record (only present when source === "pdf"). */
  pdf_record?: Lake | Stream;
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
