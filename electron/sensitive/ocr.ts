// On-device OCR for the opt-in Advanced protection layer. Wraps tesseract.js v7
// (Apache-2.0) behind a small worker pool. Used only to LOCATE text regions in
// screen frames so they can be blurred before a JPEG leaves the machine — the OCR
// text itself is never sent to the model. Fully offline: the WASM core ships in
// the tesseract.js-core node_module and the language data is a local file the
// model manager downloads once into the app's models dir.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { createLogger } from "../logger";

const require = createRequire(import.meta.url);
const log = createLogger("Sensitive/ocr");

const LANG = "eng";
/** The (uncompressed) Tesseract language model file the manager places in langPath. */
export const TESSDATA_FILE = `${LANG}.traineddata`;
/** LSTM-only engine — matches the fast LSTM traineddata and skips legacy components. */
const OEM_LSTM_ONLY = 1;

/** One recognized word with its pixel bounding box in the source image. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type TesseractModule = typeof import("tesseract.js");
type TWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;

interface RawWord {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}
interface RawPage {
  blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: RawWord[] }> }> }> | null;
}

/** Absolute path to the tesseract.js-core package dir (holds the WASM variants).
 *  Resolved from node_modules at runtime like the app's other native deps. */
export function resolveCorePath(): string {
  return path.dirname(require.resolve("tesseract.js-core/package.json"));
}

export interface OcrOptions {
  /** Directory containing `eng.traineddata` (managed by the model manager). */
  langPath: string;
  /** Number of reusable workers. Small by default — a few frames per call. */
  poolSize?: number;
}

/**
 * A reusable pool of tesseract workers. Workers are expensive to create (each
 * loads the WASM core + language data), so they're built once on first use and
 * reused across recognitions. Recognitions beyond the pool size queue until a
 * worker frees up. Non-throwing at the call site: on any failure it returns no
 * words, so a frame is treated as "nothing to blur" only by callers that verify
 * OCR readiness first.
 */
export class Ocr {
  private readonly langPath: string;
  private readonly poolSize: number;
  private tesseract: TesseractModule | null = null;
  private workers: TWorker[] = [];
  private idle: TWorker[] = [];
  private readonly waiters: Array<(worker: TWorker) => void> = [];
  private initPromise: Promise<void> | null = null;
  private terminated = false;

  constructor(opts: OcrOptions) {
    this.langPath = opts.langPath;
    this.poolSize = Math.max(1, Math.min(4, opts.poolSize ?? 2));
  }

  /** True once the language data exists and workers can be built. */
  isLanguageDataPresent(): boolean {
    return existsSync(path.join(this.langPath, TESSDATA_FILE));
  }

  /** Eagerly build the worker pool so the first frame isn't slow and readiness is
   *  genuine (surfaces a load failure now rather than at serve time). */
  async warm(): Promise<void> {
    await this.ensureInit();
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!this.isLanguageDataPresent()) {
        throw new Error("OCR language data is not available.");
      }
      const tesseract = (this.tesseract ??= await import("tesseract.js"));
      const corePath = resolveCorePath();
      for (let i = 0; i < this.poolSize; i++) {
        const worker = await tesseract.createWorker(LANG, OEM_LSTM_ONLY, {
          corePath,
          langPath: this.langPath,
          // "none": never touch a write-back cache; always read the local
          // traineddata from langPath. Fully offline, no network fallback.
          cacheMethod: "none",
          gzip: false,
          workerBlobURL: false,
          legacyCore: false,
          legacyLang: false,
        });
        this.workers.push(worker);
        this.idle.push(worker);
      }
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** Recognize words + boxes in one image (a JPEG file path or a Buffer). */
  async recognize(image: string | Buffer): Promise<OcrWord[]> {
    if (this.terminated) return [];
    await this.ensureInit();
    const worker = await this.acquire();
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true });
      return wordsFrom(data as unknown as RawPage);
    } catch (err) {
      log.warn("recognize failed:", err instanceof Error ? err.message : err);
      return [];
    } finally {
      this.release(worker);
    }
  }

  private acquire(): Promise<TWorker> {
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise<TWorker>((resolve) => this.waiters.push(resolve));
  }

  private release(worker: TWorker): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(worker);
    else this.idle.push(worker);
  }

  /** Tear down all workers (called when Advanced protection is disabled / on quit). */
  async terminate(): Promise<void> {
    this.terminated = true;
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
  }
}

/** Flatten a recognition result to non-empty words with boxes. */
function wordsFrom(page: RawPage): OcrWord[] {
  const out: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? "").trim();
          if (!text || !word.bbox) continue;
          out.push({
            text,
            confidence: typeof word.confidence === "number" ? word.confidence : 0,
            bbox: word.bbox,
          });
        }
      }
    }
  }
  return out;
}
