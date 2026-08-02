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
import { Ocr, TESSDATA_FILE } from "./ocr";

const log = createLogger("Sensitive/models");

/** Apache-2.0 fast LSTM English model (~4 MB). Fetched once into the models dir. */
const TESSDATA_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";

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

function isTessdataCached(): boolean {
  return existsSync(path.join(tessdataDir(), TESSDATA_FILE));
}

function readEnabledFlag(): boolean {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8")) as { enabled?: unknown };
    return raw.enabled === true;
  } catch {
    return false;
  }
}

async function writeEnabledFlag(enabled: boolean): Promise<void> {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify({ enabled }, null, 2));
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Download the Tesseract language data to the models dir (atomic temp+rename). */
async function downloadTessdata(onProgress?: (percent: number) => void): Promise<void> {
  const dir = tessdataDir();
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, TESSDATA_FILE);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  const res = await fetch(TESSDATA_URL);
  if (!res.ok || !res.body) throw new Error(`Could not download OCR language data (${res.status}).`);
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
    progress: null,
    error: null,
  };
  private ocr: Ocr | null = null;
  private enableTask: Promise<SensitiveModelActionResult> | null = null;

  constructor(private readonly emitStatus: (status: SensitiveModelStatus) => void) {}

  /** Load the persisted opt-in and reflect what's cached. Kicks off background
   *  readiness (loading the NER pipeline, warming OCR) when already enabled. */
  initialize(): void {
    const enabled = readEnabledFlag();
    this.current = {
      enabled,
      ner: isNerModelCached() ? "ready" : "missing",
      ocr: isTessdataCached() ? "ready" : "missing",
      progress: null,
      error: null,
    };
    if (enabled && isTessdataCached()) this.ocr = new Ocr({ langPath: tessdataDir() });
    this.emit();
    if (enabled) void this.setAdvanced(true); // resume any pending download; warm assets
  }

  status(): SensitiveModelStatus {
    return { ...this.current };
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
    await writeEnabledFlag(true);
    this.update({ enabled: true, error: null });

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
    try {
      if (!isTessdataCached()) {
        this.update({ ocr: "downloading" });
        await downloadTessdata();
      }
      this.ocr ??= new Ocr({ langPath: tessdataDir() });
      await this.ocr.warm();
      this.update({ ocr: "ready" });
    } catch (err) {
      firstError ??= message(err);
      this.ocr = null;
      this.update({ ocr: "error", error: message(err) });
    }

    return firstError ? { ok: false, error: firstError } : { ok: true };
  }

  private async disable(): Promise<SensitiveModelActionResult> {
    await writeEnabledFlag(false);
    const ocr = this.ocr;
    this.ocr = null;
    if (ocr) await ocr.terminate();
    // Keep the cache on disk; just reflect that the layer won't be applied. States
    // fall back to whether the files are present so re-enabling is instant.
    this.update({
      enabled: false,
      ner: isNerModelCached() ? "ready" : "missing",
      ocr: isTessdataCached() ? "ready" : "missing",
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
