// Map local NER model output to {@link SensitiveMatch}es for the opt-in Advanced
// protection layer. Kept separate from model loading so it can be unit-tested with
// a stub pipeline (no weights, no native deps).

import type {
  SensitiveCategory,
  SensitiveMatch,
  SensitiveSeverity,
} from "../../common/sensitive";
import type { NerEntity, NerPipeline } from "./ner-model";

/** Named entities rank below secrets (90) and structured PII (40–55): they are the
 *  least certain layer, so on any overlap the more specific detector wins. */
export const NER_RANK = 30;

/** Minimum model confidence to treat an entity as a finding. */
const MIN_SCORE = 0.85;

const GROUP_MAP: Record<
  string,
  { category: SensitiveCategory; label: string; severity: SensitiveSeverity } | undefined
> = {
  PER: { category: "person", label: "Person name", severity: "medium" },
  LOC: { category: "location", label: "Location", severity: "low" },
  ORG: { category: "org", label: "Organization", severity: "low" },
  // MISC is intentionally dropped: it's noisy and not a category we redact.
};

/** Resolve an entity to its exact substring + offset in the original text. Prefer
 *  the model's char offsets; fall back to locating the reconstructed word. */
function locate(text: string, ent: NerEntity): { value: string; start: number } {
  if (typeof ent.start === "number" && typeof ent.end === "number" && ent.end > ent.start) {
    return { value: text.slice(ent.start, ent.end), start: ent.start };
  }
  const word = ent.word.replace(/\s+/g, " ").trim();
  const idx = word ? text.indexOf(word) : -1;
  return idx >= 0 ? { value: word, start: idx } : { value: "", start: 0 };
}

/**
 * Run the token-classification pipeline over one string and return person /
 * location / organization matches above the confidence gate. Non-throwing: a model
 * error yields no matches (the always-on layers still cover the text). The caller
 * merges these with the other layers and resolves overlaps.
 */
export async function runNer(
  text: string,
  pipeline: NerPipeline,
  minScore = MIN_SCORE,
): Promise<SensitiveMatch[]> {
  if (!text || !text.trim()) return [];
  let entities: NerEntity[];
  try {
    entities = await pipeline(text, { aggregation_strategy: "simple" });
  } catch {
    return [];
  }
  const out: SensitiveMatch[] = [];
  for (const ent of entities) {
    const spec = GROUP_MAP[ent.entity_group];
    if (!spec) continue;
    if (typeof ent.score === "number" && ent.score < minScore) continue;
    const { value, start } = locate(text, ent);
    if (value.length < 2) continue;
    out.push({
      category: spec.category,
      label: spec.label,
      severity: spec.severity,
      value,
      start,
      end: start + value.length,
      rank: NER_RANK,
    });
  }
  return out;
}
