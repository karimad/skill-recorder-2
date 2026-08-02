import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  SensitiveModelActionResult,
  SensitiveModelStatus,
} from "../../common/ipc";
import { createLogger } from "../logger";
import {
  getNerPipeline,
  isNerModelCached,
  modelsCacheDir,
  type ModelLoadProgress,
  type NerPipeline,
} from "./ner-model";
import { Ocr, tessdataFileName } from "./ocr";
import {
  DEFAULT_OCR_LANGUAGE,
  normalizeOcrLanguages,
} from "../../common/ocr-languages";

const log = createLogger("Sensitive/models");

/** Apache-2.0 fast LSTM models (a few MB each). Fetched once into the models dir. */
function tessdataUrl(code: string): string {
  return `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${tessdataFileName(code)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Where the persisted opt-in lives — inside the models dir so a single override
 *  (SKILL_RECORDER_MODELS_DIR) relocates both the flag and the model cache. */
function settingsFile(): string {
  return path.join(modelsCacheDir(), "advanced-protection.json");
}

function tessdataDir(): string {
  return path.join(modelsCacheDir(), "tessdata");
}

function isTessdataCached(code: string): boolean {
  return existsSync(path.join(tessdataDir(), tessdataFileName(code)));
}

/** The selected languages whose data is not yet on disk. */
function missingTessdata(codes: readonly string[]): string[] {
  return codes.filter((code) => !isTessdataCached(code));
}

/** OCR is ready to build only when every selected language's data is present. */
function allTessdataCached(codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every(isTessdataCached);
}

interface AdvancedSettings {
  enabled: boolean;
  languages: string[];
}

function readSettings(defaultLanguages: string[]): AdvancedSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8")) as {
      enabled?: unknown;
      languages?: unknown;
    };
    const langs = Array.isArray(raw.languages)
      ? normalizeOcrLanguages(raw.languages.filter((l): l is string => typeof l === "string"))
      : defaultLanguages;
    return { enabled: raw.enabled === true, languages: langs };
  } catch {
    return { enabled: false, languages: defaultLanguages };
  }
}

async function writeSettings(settings: AdvancedSettings): Promise<void> {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(settings, null, 2));
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Download one Tesseract language's data to the models dir (atomic temp+rename). */
async function downloadTessdata(
  code: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const dir = tessdataDir();
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, tessdataFileName(code));
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  const res = await fetch(tessdataUrl(code));
  if (!res.ok || !res.body)
    throw new Error(`Could not download OCR language data for "${code}" (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  let loaded = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    loaded += buf.length;
    if (total) onProgress?.(Math.floor((loaded / total) * 100));
  }
  try {
    await writeFile(tmp, Buffer.concat(chunks));
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Owns the opt-in "Advanced protection" models: the local NER weights and the
 * Tesseract OCR language data, behind a single persisted `enabled` flag. Enabling
 * downloads whatever is missing (non-blocking to Analyze — a scan just runs the
 * always-on layers until these are ready); disabling stops applying them but keeps
 * the cache so re-enabling is instant. Never throws into the Analyze path: the
 * getters return null when the layer isn't available.
 */
export class SensitiveModelManager {
  private current: SensitiveModelStatus = {
    enabled: false,
    ner: "missing",
    ocr: "missing",
    languages: [DEFAULT_OCR_LANGUAGE],
    progress: null,
    error: null,
  };
  private languages: string[] = [DEFAULT_OCR_LANGUAGE];
  private ocr: Ocr | null = null;
  private enableTask: Promise<SensitiveModelActionResult> | null = null;
  private ocrTask: Promise<SensitiveModelActionResult> | null = null;

  /** @param defaultLanguages selection for a fresh install (e.g. OS-locale + English). */
  constructor(
    private readonly emitStatus: (status: SensitiveModelStatus) => void,
    defaultLanguages: string[] = [DEFAULT_OCR_LANGUAGE],
  ) {
    this.languages = normalizeOcrLanguages(defaultLanguages);
  }

  /** Load the persisted opt-in and reflect what's cached. Kicks off background
   *  readiness (loading the NER pipeline, warming OCR) when already enabled.
   *  @param defaultLanguages OCR languages for a fresh install (OS-locale aware). */
  initialize(defaultLanguages?: string[]): void {
    if (defaultLanguages && defaultLanguages.length) {
      this.languages = normalizeOcrLanguages(defaultLanguages);
    }
    const settings = readSettings(this.languages);
    this.languages = settings.languages;
    this.current = {
      enabled: settings.enabled,
      ner: isNerModelCached() ? "ready" : "missing",
      ocr: allTessdataCached(this.languages) ? "ready" : "missing",
      languages: [...this.languages],
      progress: null,
      error: null,
    };
    if (settings.enabled && allTessdataCached(this.languages)) {
      this.ocr = new Ocr({ langPath: tessdataDir(), languages: this.languages });
    }
    this.emit();
    if (settings.enabled) void this.setAdvanced(true); // resume any pending download; warm assets
  }

  status(): SensitiveModelStatus {
    return { ...this.current, languages: [...this.current.languages] };
  }

  isAdvancedEnabled(): boolean {
    return this.current.enabled;
  }

  isAdvancedReady(): boolean {
    return this.current.enabled && this.current.ner === "ready" && this.current.ocr === "ready";
  }

  /** Toggle Advanced protection. Enabling persists the opt-in and ensures both
   *  assets (downloading on first use); disabling persists it off and releases OCR
   *  workers while keeping the cache. */
  setAdvanced(enabled: boolean): Promise<SensitiveModelActionResult> {
    if (!enabled) return this.disable();
    if (this.enableTask) return this.enableTask;
    const task = this.enable();
    this.enableTask = task;
    void task.finally(() => {
      if (this.enableTask === task) this.enableTask = null;
    });
    return task;
  }

  /** Change the OCR languages. Persists the selection and, when Advanced is enabled,
   *  downloads any newly-required language data and rebuilds the worker pool. A no-op
   *  set (same languages) still returns the current readiness. */
  setOcrLanguages(codes: readonly string[]): Promise<SensitiveModelActionResult> {
    const next = normalizeOcrLanguages(codes);
    const changed = next.join("+") !== this.languages.join("+");
    this.languages = next;
    if (!this.current.enabled) {
      // Persist the choice; reflect (but don't fetch) what's cached for it.
      void writeSettings({ enabled: false, languages: next });
      this.update({ languages: [...next], ocr: allTessdataCached(next) ? "ready" : "missing" });
      return Promise.resolve({ ok: true });
    }
    if (!changed && this.ocr && this.current.ocr === "ready") {
      return Promise.resolve({ ok: true });
    }
    if (this.ocrTask) return this.ocrTask;
    const task = this.applyOcrLanguages(next);
    this.ocrTask = task;
    void task.finally(() => {
      if (this.ocrTask === task) this.ocrTask = null;
    });
    return task;
  }

  /** The NER pipeline when Advanced is enabled and the model is cached, else null.
   *  Never downloads here (that only happens via the toggle). */
  async getNerPipeline(): Promise<NerPipeline | null> {
    if (!this.current.enabled || !isNerModelCached()) return null;
    try {
      const pipe = await getNerPipeline({ allowDownload: false });
      if (this.current.ner !== "ready") this.update({ ner: "ready" });
      return pipe;
    } catch (err) {
      log.warn("NER load failed:", message(err));
      this.update({ ner: "error", error: message(err) });
      return null;
    }
  }

  /** The OCR engine when Advanced is enabled and language data is present, else
   *  null (callers then withhold frames rather than serve raw pixels). */
  getOcr(): Ocr | null {
    if (!this.current.enabled || this.current.ocr !== "ready") return null;
    return this.ocr;
  }

  /** Tear down OCR workers (app quit). */
  async dispose(): Promise<void> {
    const ocr = this.ocr;
    this.ocr = null;
    if (ocr) await ocr.terminate();
  }

  // --- internals -----------------------------------------------------------

  private async enable(): Promise<SensitiveModelActionResult> {
    await writeSettings({ enabled: true, languages: this.languages });
    this.update({ enabled: true, languages: [...this.languages], error: null });

    let firstError: string | null = null;

    // NER weights (the large asset — drives the visible progress).
    if (!isNerModelCached()) this.update({ ner: "downloading", progress: 0 });
    try {
      await getNerPipeline({
        allowDownload: true,
        onProgress: (p) => this.onNerProgress(p),
      });
      this.update({ ner: "ready", progress: null });
    } catch (err) {
      firstError ??= message(err);
      this.update({ ner: isNerModelCached() ? "ready" : "error", progress: null, error: message(err) });
    }

    // OCR language data (small) + warm the worker pool so readiness is genuine.
    const ocrError = await this.ensureOcrReady();
    if (ocrError) firstError ??= ocrError;

    return firstError ? { ok: false, error: firstError } : { ok: true };
  }

  /** Rebuild the OCR engine for a new language selection (Advanced already on). */
  private async applyOcrLanguages(next: string[]): Promise<SensitiveModelActionResult> {
    await writeSettings({ enabled: true, languages: next });
    this.update({ languages: [...next], error: null });
    const ocr = this.ocr;
    this.ocr = null;
    if (ocr) await ocr.terminate();
    const err = await this.ensureOcrReady();
    return err ? { ok: false, error: err } : { ok: true };
  }

  /** Download any missing selected language data, then build + warm the pool.
   *  Returns an error message on failure (and leaves OCR null / state "error"). */
  private async ensureOcrReady(): Promise<string | null> {
    try {
      const missing = missingTessdata(this.languages);
      if (missing.length) {
        this.update({ ocr: "downloading" });
        for (const code of missing) await downloadTessdata(code);
      }
      this.ocr = new Ocr({ langPath: tessdataDir(), languages: this.languages });
      await this.ocr.warm();
      this.update({ ocr: "ready" });
      return null;
    } catch (err) {
      this.ocr = null;
      this.update({ ocr: "error", error: message(err) });
      return message(err);
    }
  }

  private async disable(): Promise<SensitiveModelActionResult> {
    await writeSettings({ enabled: false, languages: this.languages });
    const ocr = this.ocr;
    this.ocr = null;
    if (ocr) await ocr.terminate();
    // Keep the cache on disk; just reflect that the layer won't be applied. States
    // fall back to whether the files are present so re-enabling is instant.
    this.update({
      enabled: false,
      ner: isNerModelCached() ? "ready" : "missing",
      ocr: allTessdataCached(this.languages) ? "ready" : "missing",
      progress: null,
      error: null,
    });
    return { ok: true };
  }

  private onNerProgress(progress: ModelLoadProgress): void {
    if (progress.status !== "progress_total") return;
    const percent = Math.max(0, Math.min(100, Math.floor(progress.progress ?? 0)));
    if (percent === this.current.progress) return;
    this.update({ ner: "downloading", progress: percent });
  }

  private update(patch: Partial<SensitiveModelStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit();
  }

  private emit(): void {
    this.emitStatus(this.status());
  }
}
