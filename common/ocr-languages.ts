// The OCR languages a user can enable for Advanced-protection frame scanning.
// Codes are Tesseract `tessdata_fast` model names (what the model manager
// downloads and what `createWorker` loads). Shared by the renderer (the picker)
// and the main process (defaults + validation), so the two never drift.
//
// Note: this only affects on-screen text *recognition* for blurring. The named-
// entity layer (person/org/location) is English-only regardless — the always-on
// secret + structured-PII detectors are language-agnostic.

export interface OcrLanguage {
  /** Tesseract tessdata_fast model code (also the traineddata filename stem). */
  code: string;
  /** Human label for the picker. */
  label: string;
}

/** Curated set — the largest user bases plus a spread of scripts (Latin, CJK,
 *  Cyrillic, RTL). Every code exists in tesseract-ocr/tessdata_fast. */
export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "nld", label: "Dutch" },
  { code: "rus", label: "Russian" },
  { code: "ukr", label: "Ukrainian" },
  { code: "pol", label: "Polish" },
  { code: "tur", label: "Turkish" },
  { code: "vie", label: "Vietnamese" },
  { code: "ara", label: "Arabic" },
  { code: "hin", label: "Hindi" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
];

/** The always-available base language. */
export const DEFAULT_OCR_LANGUAGE = "eng";

const SUPPORTED = new Set(OCR_LANGUAGES.map((l) => l.code));

export function isSupportedOcrLanguage(code: string): boolean {
  return SUPPORTED.has(code);
}

export function ocrLanguageLabel(code: string): string {
  return OCR_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/**
 * Clean a requested language list: keep only supported codes, drop duplicates
 * (first occurrence wins — order matters to Tesseract, primary language first),
 * and never return empty (falls back to English).
 */
export function normalizeOcrLanguages(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of codes) {
    if (isSupportedOcrLanguage(code) && !out.includes(code)) out.push(code);
  }
  return out.length ? out : [DEFAULT_OCR_LANGUAGE];
}

/** Map a BCP-47 locale (e.g. Electron's `app.getLocale()`) to a tessdata code. */
export function localeToOcrLanguage(locale: string): string | null {
  const lower = locale.toLowerCase();
  const primary = lower.split("-")[0];
  if (primary === "zh") {
    return lower.includes("tw") || lower.includes("hk") || lower.includes("hant")
      ? "chi_tra"
      : "chi_sim";
  }
  const map: Record<string, string> = {
    en: "eng",
    es: "spa",
    fr: "fra",
    de: "deu",
    it: "ita",
    pt: "por",
    nl: "nld",
    ru: "rus",
    uk: "ukr",
    pl: "pol",
    tr: "tur",
    vi: "vie",
    ar: "ara",
    hi: "hin",
    ja: "jpn",
    ko: "kor",
  };
  const code = map[primary];
  return code && isSupportedOcrLanguage(code) ? code : null;
}

/** Default selection for a fresh install: the OS language (if supported) plus
 *  English as a base. English alone when the locale isn't in the catalogue. */
export function defaultOcrLanguages(locale: string): string[] {
  const fromLocale = localeToOcrLanguage(locale);
  if (!fromLocale || fromLocale === DEFAULT_OCR_LANGUAGE) return [DEFAULT_OCR_LANGUAGE];
  return [fromLocale, DEFAULT_OCR_LANGUAGE];
}
