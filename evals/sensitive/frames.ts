// Fixed corpus for the frame OCR + blur evals (the opt-in Advanced-protection
// image channel). Real frames are OCR'd on-device with tesseract; here we supply
// the recognized words + their pixel boxes directly, so the box-mapping logic —
// join words → run the shared detectors → paint every word whose char span
// overlaps a match — is exercised deterministically without tesseract or sharp.
//
// Each word carries `sensitive: true` when its box MUST be blurred. Words are laid
// out left-to-right on one row with wide gaps, so a padded box only ever overlaps
// its own word (no ambiguous neighbor overlap during scoring).

import type { NerHint } from "./corpus";

export interface FrameWord {
  text: string;
  /** True when this word's box must be covered before the frame is sent. */
  sensitive?: boolean;
}

export interface FrameCase {
  id: string;
  about: string;
  words: FrameWord[];
  /** Values already detected in the session's text (cross-feed blur). */
  knownValues?: string[];
  /** Entities the local NER model would return over the joined OCR text. */
  ner?: NerHint[];
}

export const frameCorpus: FrameCase[] = [
  {
    id: "frame-github-token",
    about: "A GitHub token visible on screen (secretlint over OCR text)",
    words: [
      { text: "run" },
      { text: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", sensitive: true },
      { text: "now" },
    ],
  },
  {
    id: "frame-email",
    about: "An email address on screen (structured PII over OCR text)",
    words: [
      { text: "contact" },
      { text: "jane.doe@example.com", sensitive: true },
      { text: "today" },
    ],
  },
  {
    id: "frame-card-split",
    about: "A card number OCR'd as four separate words — all four boxes blur",
    words: [
      { text: "card" },
      { text: "4111", sensitive: true },
      { text: "1111", sensitive: true },
      { text: "1111", sensitive: true },
      { text: "1111", sensitive: true },
      { text: "ok" },
    ],
  },
  {
    id: "frame-known-value-cross-feed",
    about: "A person name known from clean session text, blurred across two OCR words",
    words: [
      { text: "with" },
      { text: "Ada", sensitive: true },
      { text: "Lovelace", sensitive: true },
      { text: "here" },
    ],
    knownValues: ["Ada Lovelace"],
  },
  {
    id: "frame-ner-org",
    about: "An organization surfaced by the NER layer over OCR text",
    words: [
      { text: "joined" },
      { text: "Contoso", sensitive: true },
      { text: "review" },
    ],
    ner: [{ word: "Contoso", group: "ORG" }],
  },
  {
    id: "frame-clean",
    about: "Ordinary on-screen text — nothing blurred (precision)",
    words: [{ text: "Opened" }, { text: "the" }, { text: "roadmap" }, { text: "doc" }],
  },
];
