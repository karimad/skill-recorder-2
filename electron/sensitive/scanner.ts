import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { NARRATION_FILE, type NarrationTranscript } from "../../common/narration";
import {
  maskValue,
  redactedSnippet,
  resolveOverlaps,
  scanStructuredPii,
  type SensitiveFinding,
  type SensitiveMatch,
  type SensitiveReport,
  type SensitiveSource,
} from "../../common/sensitive";
import type { RecEvent, SessionMeta } from "../../common/types";
import { readEvents } from "../frames/correlate";
import { createLogger } from "../logger";
import { sessionDir } from "../recorder/session-store";
import type { NerPipeline } from "./ner-model";
import { runNer } from "./ner";
import { scanSecrets } from "./secrets";

const log = createLogger("Sensitive");

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Shortest value we bother redacting — below this, literal replacement would hit
 *  too many innocent substrings elsewhere in the text. */
const MIN_REDACT_LEN = 3;

/** One string to scan, tagged with where it came from and when. */
interface ScanField {
  text: string;
  source: SensitiveSource;
  atMs: number | null;
}

/** The outcome of a scan: a redacted report for the UI plus the raw matched values
 *  (main-process only — used to build the redactor; never sent to the renderer). */
export interface ScanResult {
  report: SensitiveReport;
  /** De-duplicated raw values detected across the session. */
  values: string[];
}

export interface ScanOptions {
  /** When provided (Advanced protection on + model ready), also run NER. */
  nerPipeline?: NerPipeline | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Pull every outgoing text field (with provenance + time) from one event. */
function fieldsFromEvent(ev: RecEvent, startedAt: number | null): ScanField[] {
  const p = ev.payload;
  const atMs = startedAt != null ? ev.epoch - startedAt : null;
  const at = (text: string | undefined, source: SensitiveSource): ScanField | null =>
    text ? { text, source, atMs } : null;

  let picked: (ScanField | null)[] = [];
  switch (ev.type) {
    case "app.activate":
      picked = [at(str(p.title), "window-title"), at(str(p.url), "url")];
      break;
    case "app.title-change":
      picked = [at(str(p.title), "window-title")];
      break;
    case "browser.url":
      picked = [at(str(p.url), "url"), at(str(p.title), "window-title")];
      break;
    case "terminal.command":
      picked = [at(str(p.command), "command")];
      break;
    case "clipboard.change":
      picked = [at(str(p.textPreview), "clipboard")];
      break;
    case "marker":
      picked = [at(str(p.note), "note")];
      break;
    default:
      picked = [];
  }
  return picked.filter((f): f is ScanField => f !== null);
}

/** Every scannable text field of a recording, in timeline order. */
function collectFields(dir: string): ScanField[] {
  const fields: ScanField[] = [];

  const meta = readJson<SessionMeta>(path.join(dir, "session.json"));
  const startedAt = typeof meta?.startedAt === "number" ? meta.startedAt : null;

  let events: RecEvent[] = [];
  try {
    events = readEvents(path.join(dir, "events.jsonl"));
  } catch (err) {
    log.warn("could not read events for scan:", err instanceof Error ? err.message : err);
  }
  for (const ev of events) fields.push(...fieldsFromEvent(ev, startedAt));

  const narration = readJson<NarrationTranscript>(path.join(dir, NARRATION_FILE));
  if (narration && Array.isArray(narration.segments)) {
    for (const seg of narration.segments) {
      const text = str(seg?.text);
      if (text) {
        fields.push({
          text,
          source: "narration",
          atMs: typeof seg.atMs === "number" ? seg.atMs : null,
        });
      }
    }
  }

  return fields;
}

/** Run every detection layer over one string and merge them (overlaps resolved). */
async function matchesFor(
  text: string,
  nerPipeline: NerPipeline | null,
): Promise<SensitiveMatch[]> {
  const [secrets, ner] = await Promise.all([
    scanSecrets(text),
    nerPipeline ? runNer(text, nerPipeline) : Promise.resolve<SensitiveMatch[]>([]),
  ]);
  const pii = scanStructuredPii(text);
  return resolveOverlaps([...secrets, ...pii, ...ner]);
}

/** Stable identity for deduping the same value seen in the same kind of place. */
function findingKey(source: SensitiveSource, match: SensitiveMatch): string {
  return `${source}|${match.category}|${match.value}`;
}

/**
 * Scan one recording for potentially sensitive details in exactly the text that
 * Analyze would send to GitHub Copilot — window/document titles, URLs, clipboard
 * previews, terminal commands, markers, and transcribed voice narration. Runs the
 * always-on secret + structured-PII layers and, when a NER pipeline is supplied
 * (Advanced protection on and the model ready), the named-entity layer too.
 *
 * Runs entirely on this computer and is best-effort / non-throwing — an unreadable
 * artifact simply contributes no fields. Returns a redacted {@link SensitiveReport}
 * (masked values + short redacted context only) plus the raw matched `values` for
 * the caller's redactor. The report NEVER carries raw values; the `values` array
 * stays in the main process and is never persisted or sent to the renderer.
 *
 * Note: this inspects text only. Secrets merely *visible* in screen frames are
 * handled separately by the frame OCR + blur seam in the describer's get_frames.
 */
export async function scanSession(
  sessionId: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const dir = sessionDir(sessionId); // throws on an unsafe id (traversal guard)
  const fields = collectFields(dir);
  const nerPipeline = options.nerPipeline ?? null;

  const byKey = new Map<string, SensitiveFinding>();
  const values = new Set<string>();
  for (const field of fields) {
    let matches: SensitiveMatch[];
    try {
      matches = await matchesFor(field.text, nerPipeline);
    } catch (err) {
      log.warn("field scan failed:", err instanceof Error ? err.message : err);
      continue;
    }
    for (const match of matches) {
      if (match.value.length >= MIN_REDACT_LEN) values.add(match.value);
      const key = findingKey(field.source, match);
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        // Keep the earliest known time so the finding points at first exposure.
        if (field.atMs != null && (existing.atMs == null || field.atMs < existing.atMs)) {
          existing.atMs = field.atMs;
        }
        continue;
      }
      byKey.set(key, {
        category: match.category,
        label: match.label,
        severity: match.severity,
        source: field.source,
        redactedValue: maskValue(match.value),
        snippet: redactedSnippet(field.text, match),
        atMs: field.atMs,
        occurrences: 1,
      });
    }
  }

  const findings = [...byKey.values()].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const at = (a.atMs ?? Infinity) - (b.atMs ?? Infinity);
    if (at !== 0) return at;
    return a.label.localeCompare(b.label);
  });

  const counts: SensitiveReport["counts"] = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;

  const report: SensitiveReport = {
    sessionId,
    scannedAt: Date.now(),
    totalFindings: findings.length,
    highSeverityCount: findings.filter((f) => f.severity === "high").length,
    counts,
    findings,
  };
  return { report, values: [...values] };
}

/**
 * Build a redactor that replaces every detected raw value with its mask. Literal,
 * longest-first replacement so a value contained in another (e.g. a token inside a
 * URL) is masked as the longer match first. Values shorter than MIN_REDACT_LEN are
 * ignored to avoid masking innocent substrings.
 */
export function buildRedactor(values: string[]): (text: string) => string {
  const unique = [...new Set(values.filter((v) => v.length >= MIN_REDACT_LEN))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of unique) {
      if (out.includes(value)) out = out.split(value).join(maskValue(value));
    }
    return out;
  };
}
