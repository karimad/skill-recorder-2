import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  SensitiveModelActionResult,
  SensitiveModelStatus,
} from "../../common/ipc";
import { createLogger } from "../logger";
import { modelsCacheDir, Ocr, tessdataFileName } from "./ocr";

const log = createLogger("Sensitive/models");

/** Advanced protection reads on-screen text with English (Latin) OCR. Every value
 *  it looks for — keys, tokens, emails, cards, IDs — is ASCII by construction, so
 *  English OCR reads them on any-language UI; there is nothing to select. */
const OCR_LANGUAGE = "eng";

/** Apache-2.0 fast LSTM model (a few MB). Fetched once into the models dir. */
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

/** True once the English traineddata is on disk and the OCR engine can be built. */
function isTessdataCached(): boolean {
  return existsSync(path.join(tessdataDir(), tessdataFileName(OCR_LANGUAGE)));
}

interface AdvancedSettings {
  enabled: boolean;
}

function readSettings(): AdvancedSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8")) as { enabled?: unknown };
    return { enabled: raw.enabled === true };
  } catch {
    return { enabled: false };
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

/** Download the Tesseract language data to the models dir (atomic temp+rename). */
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
 * Owns the opt-in "Advanced protection" model: the on-device Tesseract English OCR
 * data, behind a single persisted `enabled` flag. Enabling only records the opt-in
 * and (if the data is already cached) warms the engine — downloading is a
 * *separate*, deliberate step (`downloadModels`), surfaced in the HUD "doctor" like
 * the voice model. Disabling stops applying the layer but keeps the cache so
 * re-enabling is instant. Never throws into the Analyze path: `getOcr` returns null
 * when the layer isn't available.
 */
export class SensitiveModelManager {
  private current: SensitiveModelStatus = {
    enabled: false,
    ocr: "missing",
    progress: null,
    error: null,
  };
  private ocr: Ocr | null = null;
  private downloadTask: Promise<SensitiveModelActionResult> | null = null;
  /** Bumped on every enable/disable. A warm that started under an older generation
   *  refuses to publish, so `this.ocr` (and the "ready" status) can never reflect an
   *  engine built for a since-disabled layer. */
  private ocrGen = 0;
  /** Serializes engine build/warm/terminate so concurrent lifecycle ops never spin up
   *  overlapping worker pools or race the published engine. */
  private ocrLifecycle: Promise<unknown> = Promise.resolve();
  /** Serializes settings writes so a reported success always reflects a completed,
   *  in-order persist. */
  private settingsChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly emitStatus: (status: SensitiveModelStatus) => void) {}

  /** Load the persisted opt-in and reflect what's cached. Warms already-downloaded
   *  data so it's ready without a click — but never downloads on startup. */
  initialize(): void {
    const settings = readSettings();
    this.current = {
      enabled: settings.enabled,
      ocr: isTessdataCached() ? "ready" : "missing",
      progress: null,
      error: null,
    };
    this.emit();
    // Warm OCR from cache (no network) so a returning, fully-provisioned user is
    // immediately ready. If it's missing, the doctor shows a download action.
    if (settings.enabled && isTessdataCached()) {
      void this.warmFromCache(this.ocrGen);
    }
  }

  status(): SensitiveModelStatus {
    return { ...this.current };
  }

  isAdvancedEnabled(): boolean {
    return this.current.enabled;
  }

  isAdvancedReady(): boolean {
    return this.current.enabled && this.current.ocr === "ready";
  }

  /** Toggle Advanced protection. Enabling records the opt-in (downloading is deferred
   *  to `downloadModels`); disabling persists it off and releases OCR workers while
   *  keeping the cache. */
  async setAdvanced(enabled: boolean): Promise<SensitiveModelActionResult> {
    if (!enabled) return this.disable();

    const gen = ++this.ocrGen;
    this.update({
      enabled: true,
      ocr: isTessdataCached() ? "ready" : "missing",
      error: null,
    });
    const persisted = await this.persistSettings({ enabled: true });
    // If the data is already on disk, warm it so it's usable right away; otherwise
    // leave the "missing" state for the doctor's download action to resolve.
    if (isTessdataCached()) void this.warmFromCache(gen);
    return persisted;
  }

  /** Download the OCR data (if missing) and warm the engine. The deliberate
   *  "download" action behind the HUD doctor row; safe to call repeatedly. */
  downloadModels(): Promise<SensitiveModelActionResult> {
    if (!this.current.enabled) return Promise.resolve({ ok: false, error: "Advanced protection is off." });
    if (this.downloadTask) return this.downloadTask;
    const task = this.provisionOcr();
    this.downloadTask = task;
    void task.finally(() => {
      if (this.downloadTask === task) this.downloadTask = null;
    });
    return task;
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

  /** Download the English data (if missing) then warm the worker pool so readiness
   *  is genuine. Skips publishing if the layer was disabled while fetching. */
  private async provisionOcr(): Promise<SensitiveModelActionResult> {
    const gen = this.ocrGen;
    this.update({ error: null });
    try {
      if (!isTessdataCached()) {
        this.update({ ocr: "downloading", progress: 0 });
        await downloadTessdata(OCR_LANGUAGE, (p) => this.onDownloadProgress(p));
      }
      await this.buildAndWarmOcr(gen);
      if (gen === this.ocrGen) this.update({ ocr: "ready", progress: null });
      return { ok: true };
    } catch (err) {
      if (gen === this.ocrGen) this.update({ ocr: "error", progress: null, error: message(err) });
      return { ok: false, error: message(err) };
    }
  }

  /** Rebuild the OCR pool from already-cached data (no network). */
  private async warmFromCache(gen: number): Promise<SensitiveModelActionResult> {
    try {
      await this.buildAndWarmOcr(gen);
      if (gen === this.ocrGen) this.update({ ocr: "ready", error: null });
      return { ok: true };
    } catch (err) {
      if (gen === this.ocrGen) this.update({ ocr: "error", error: message(err) });
      return { ok: false, error: message(err) };
    }
  }

  /**
   * Build + warm an OCR pool and publish it only if the layer is still enabled and
   * the generation is unchanged. A failed warm or a since-disabled layer terminates
   * the fresh engine, so no unready engine is ever handed to `getOcr()`. Serialized
   * so overlapping lifecycle ops can't spin up competing pools.
   */
  private buildAndWarmOcr(gen: number): Promise<void> {
    return this.runOcrLifecycle(async () => {
      if (gen !== this.ocrGen || !this.current.enabled) return;
      const next = new Ocr({ langPath: tessdataDir() });
      try {
        await next.warm();
      } catch (err) {
        await next.terminate();
        throw err;
      }
      if (gen !== this.ocrGen || !this.current.enabled) {
        // Enabled state changed while warming — discard this engine.
        await next.terminate();
        return;
      }
      const old = this.ocr;
      this.ocr = next;
      if (old) await old.terminate();
    });
  }

  /** Terminate and drop the current OCR pool (serialized with builds). */
  private releaseOcr(): Promise<void> {
    return this.runOcrLifecycle(async () => {
      const ocr = this.ocr;
      this.ocr = null;
      if (ocr) await ocr.terminate();
    });
  }

  /** Run an OCR lifecycle op after any in-flight one, regardless of its outcome. */
  private runOcrLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ocrLifecycle.then(fn, fn);
    this.ocrLifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Persist settings in submission order and await completion so success is never
   *  reported before the write lands. Returns a failure result instead of throwing. */
  private persistSettings(settings: AdvancedSettings): Promise<SensitiveModelActionResult> {
    const run = this.settingsChain.then(() => writeSettings(settings));
    this.settingsChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      () => ({ ok: true }) as SensitiveModelActionResult,
      (err) => {
        log.warn("could not persist advanced-protection settings:", message(err));
        return { ok: false, error: message(err) } as SensitiveModelActionResult;
      },
    );
  }

  private async disable(): Promise<SensitiveModelActionResult> {
    // Supersede any in-flight warm so it can't publish an engine after we've disabled.
    this.update({ enabled: false });
    ++this.ocrGen;
    const persisted = await this.persistSettings({ enabled: false });
    await this.releaseOcr();
    // Keep the cache on disk; just reflect that the layer won't be applied. State
    // falls back to whether the file is present so re-enabling is instant.
    this.update({
      enabled: false,
      ocr: isTessdataCached() ? "ready" : "missing",
      progress: null,
      error: null,
    });
    return persisted;
  }

  private onDownloadProgress(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
    if (clamped === this.current.progress) return;
    this.update({ ocr: "downloading", progress: clamped });
  }

  private update(patch: Partial<SensitiveModelStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit();
  }

  private emit(): void {
    this.emitStatus(this.status());
  }
}
