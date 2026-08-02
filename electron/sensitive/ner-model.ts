import { existsSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

// Local named-entity recognition for the opt-in "Advanced protection" layer.
// Xenova/bert-base-NER (MIT) is a BERT token-classifier fine-tuned on CoNLL-2003;
// it tags person / location / organization / misc spans. We load the int8 (q8)
// ONNX weights (~108 MB) — the same quantization and runtime profile as the
// narration Whisper model, chosen for broad onnxruntime-node compatibility.
export const NER_MODEL_ID = "Xenova/bert-base-NER";
const DTYPE = "q8";
export const NER_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "vocab.txt",
  path.join("onnx", "model_quantized.onnx"),
] as const;

/** One aggregated entity span from the token-classification pipeline. */
export interface NerEntity {
  /** CoNLL group: "PER" | "LOC" | "ORG" | "MISC" (aggregation_strategy: "simple"). */
  entity_group: string;
  /** The matched surface text. */
  word: string;
  /** Character offsets into the input, when the tokenizer provides them. */
  start?: number;
  end?: number;
  /** Model confidence in [0, 1]. */
  score: number;
}

/**
 * The slice of the transformers.js token-classification pipeline we call. Typed as
 * a plain callable (with the "simple" aggregation option) to avoid fighting the
 * library's large pipeline union while keeping the return shape explicit.
 */
export type NerPipeline = (
  text: string,
  options?: { aggregation_strategy?: "none" | "simple" | "first" | "average" | "max" },
) => Promise<NerEntity[]>;

export interface ModelLoadProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface NerLoadOptions {
  allowDownload: boolean;
  onProgress?: (progress: ModelLoadProgress) => void;
}

let loadedPipe: NerPipeline | null = null;
let pipePromise: Promise<NerPipeline | null> | null = null;

/** Where downloaded models live — shared with narration so one dir holds them all
 *  (each model nests under its own id). Overridable for tests/CI. */
export function modelsCacheDir(): string {
  const override = process.env.SKILL_RECORDER_MODELS_DIR;
  if (override) return path.resolve(override);
  return path.join(app.getPath("userData"), "models");
}

export function isNerModelCachedAt(cacheDir: string, modelId = NER_MODEL_ID): boolean {
  const root = path.join(cacheDir, ...modelId.split("/"));
  return NER_MODEL_FILES.every((file) => existsSync(path.join(root, file)));
}

export function isNerModelCached(): boolean {
  return isNerModelCachedAt(modelsCacheDir());
}

async function build(options: NerLoadOptions): Promise<NerPipeline> {
  // Dynamic import: transformers.js + onnxruntime-node are heavy native deps we
  // only load when Advanced protection actually needs the model.
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = modelsCacheDir();

  const pipe = await tf.pipeline("token-classification", NER_MODEL_ID, {
    dtype: DTYPE,
    local_files_only: !options.allowDownload,
    progress_callback: options.onProgress,
    // onnxruntime-node's CPU memory arena SIGTRAPs (hard native crash) under
    // Electron in both the main and utility processes; disabling the arena is the
    // one option that avoids it while keeping multithreading and fusions on. Same
    // mitigation the narration model uses.
    session_options: { enableCpuMemArena: false },
  });
  return pipe as unknown as NerPipeline;
}

/**
 * Lazily build and cache the NER pipeline for the process. Failed loads are not
 * memoized, so an offline attempt can be retried without an app restart.
 */
export async function getNerPipeline(options: NerLoadOptions): Promise<NerPipeline> {
  if (loadedPipe) return loadedPipe;
  if (!pipePromise) pipePromise = build(options);
  try {
    const pipe = await pipePromise;
    if (!pipe) throw new Error("NER model did not load.");
    loadedPipe = pipe;
    return pipe;
  } finally {
    pipePromise = null;
  }
}
