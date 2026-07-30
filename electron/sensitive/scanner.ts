import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { NARRATION_FILE, type NarrationTranscript } from "../../common/narration";
import {
  maskValue,
  redactedSnippet,
  scanText,
  type SensitiveFinding,
  type SensitiveMatch,
  type SensitiveReport,
  type SensitiveSource,
} from "../../common/sensitive";
import type { RecEvent, SessionMeta } from "../../common/types";
import { readEvents } from "../frames/correlate";
import { createLogger } from "../logger";
import { sessionDir } from "../recorder/session-store";

const log = createLogger("Sensitive");

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

/** One string to scan, tagged with where it came from and when. */
interface ScanField {
  text: string;
  source: SensitiveSource;
  atMs: number | null;
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

/** Every scannable field of a recording, in timeline order. */
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

/** Stable identity for deduping the same value seen in the same kind of place. */
function findingKey(source: SensitiveSource, match: SensitiveMatch): string {
  return `${source}|${match.category}|${match.value}`;
}

/**
 * Scan one recording for potentially sensitive details in exactly the text that
 * Analyze would send to GitHub Copilot — window/document titles, URLs, clipboard
 * previews, terminal commands, markers, and transcribed voice narration. Runs
 * entirely on this computer and returns a redacted {@link SensitiveReport}: it
 * never emits or persists the raw matched values, only masked forms and short
 * redacted context. Best-effort and non-throwing — an unreadable artifact simply
 * contributes no fields.
 *
 * Note: this inspects text only. Secrets that are merely *visible* in captured
 * screen frames are out of scope and are not detected here.
 */
export function scanSessionForSensitive(sessionId: string): SensitiveReport {
  const dir = sessionDir(sessionId); // throws on an unsafe id (traversal guard)
  const fields = collectFields(dir);

  const byKey = new Map<string, SensitiveFinding>();
  for (const field of fields) {
    for (const match of scanText(field.text)) {
      const key = findingKey(field.source, match);
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        // Keep the earliest known time so the finding points at first exposure.
        if (
          field.atMs != null &&
          (existing.atMs == null || field.atMs < existing.atMs)
        ) {
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

  return {
    sessionId,
    scannedAt: Date.now(),
    totalFindings: findings.length,
    highSeverityCount: findings.filter((f) => f.severity === "high").length,
    counts,
    findings,
  };
}
