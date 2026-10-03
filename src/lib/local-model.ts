"use client";

/**
 * The open-weight model, running in the visitor's own browser.
 *
 * This is the part of khata that justifies the phrase "open-source AI at its
 * core". Nothing here calls a hosted API. `@huggingface/transformers` loads an
 * ONNX build of MobileBERT — an NLI model trained for natural language
 * inference — through onnxruntime-web, inside the page, on the visitor's own
 * machine.
 *
 * ## What the model is actually for
 *
 * The deterministic reader in `src/lib/reader.ts` handles amounts, dates,
 * payers and categories with rules, and it is always available with no download.
 * Rules are bad at exactly one thing: deciding which way money moved.
 *
 *     "received refund of 500"      money came in
 *     "refund paid to the shop"     money went out
 *     "she sent me back 200"        money came in
 *     "sent 200 to her"             money went out
 *
 * Every one of those contains the same noun and a different answer. A keyword
 * list has to guess. A zero-shot NLI model reads the whole sentence and
 * hypothesises each direction, which is a job it was trained for.
 *
 * ## Why it is not the only path
 *
 * A 28 MB download on an unknown connection is not something to put in front of
 * someone who just wants to check a number. So the reader always produces a
 * result instantly from the rule engine, shows its confidence honestly, and
 * offers the model as a one-click upgrade that re-decides only the directions
 * the rules were unsure about. Every line records which engine wrote it.
 *
 * ## Offline
 *
 * Once the ONNX weights and tokenizer are in the browser's Cache Storage, the
 * model runs with the network switched off. The README says so because it is
 * the whole point: a household's payment messages never have to leave the
 * machine, and a laptop with no internet can still read them.
 */

/* -------------------------------------------------------------------------- */
/* Direction labels                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Candidate hypotheses. NLI turns each into the sentence "This text is X" and
 * compares it to the input, so the labels are written as plain-language claims
 * rather than as internal enum names.
 */
export const DIRECTION_HYPOTHESES = [
  "someone paid money out of the household to a shop, a bill or a person",
  "money came into the household, such as a refund or a repayment",
  "a message that is not about money at all",
] as const;

export type HypothesisLabel = (typeof DIRECTION_HYPOTHESES)[number];

export const OUTFLOW_LABEL = DIRECTION_HYPOTHESES[0];
export const INFLOW_LABEL = DIRECTION_HYPOTHESES[1];
export const NOT_MONEY_LABEL = DIRECTION_HYPOTHESES[2];

const HYPOTHESIS_TEMPLATE = "This is a household payment record: {}.";

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type ModelState = "idle" | "loading" | "ready" | "error";

export interface ModelStatus {
  state: ModelState;
  /** 0..1 across the whole download, computed from per-file progress. */
  progress: number;
  file: string | null;
  error: string | null;
  /** How the weights are being fetched. */
  transport: "huggingface-cdn" | "cache" | null;
}

export interface Classification {
  text: string;
  direction: "outflow" | "inflow" | "not-money";
  /** 0..1 for the winning direction. */
  confidence: number;
  /** The full probability spread, so the UI can show a real margin. */
  scores: Record<string, number>;
}

interface ProgressUpdate {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

/* -------------------------------------------------------------------------- */
/* The pipeline                                                                */
/* -------------------------------------------------------------------------- */

type ZeroShotOutput = { sequence: string; labels: string[]; scores: number[] };
type ZeroShotPipeline = (
  texts: string | string[],
  candidate_labels: string[],
  options?: { hypothesis_template?: string; multi_label?: boolean },
) => Promise<ZeroShotOutput | ZeroShotOutput[]>;

let pipelinePromise: Promise<ZeroShotPipeline> | null = null;
let cachedClassifier: ZeroShotPipeline | null = null;

/** The bytes a visitor downloads on a cold cache, for an honest progress UI. */
const APPROX_BYTES = 28_000_000;

function toClassification(text: string, output: ZeroShotOutput): Classification {
  const scores: Record<string, number> = {};
  output.labels.forEach((label, i) => {
    scores[label] = output.scores[i] ?? 0;
  });
  const best = output.labels[0];
  const top = output.scores[0] ?? 0;
  const second = output.scores[1] ?? 0;

  let direction: Classification["direction"] = "not-money";
  if (best === OUTFLOW_LABEL) direction = "outflow";
  else if (best === INFLOW_LABEL) direction = "inflow";

  // Report the real margin between the best and the runner-up rather than the
  // bare top probability: 0.95 vs 0.04 is a decision, 0.40 vs 0.38 is not, and
  // the UI has to be able to tell those apart.
  const margin = Math.max(0, top - second);

  return {
    text,
    direction,
    confidence: Math.max(0, Math.min(1, top * 0.6 + margin * 0.4)),
    scores,
  };
}

/**
 * Load the model, reporting download progress.
 *
 * Rejects with a readable message rather than a stack trace, because the caller
 * is a status line in the interface, not a log.
 */
export async function loadDirectionModel(
  onStatus: (status: ModelStatus) => void,
): Promise<ZeroShotPipeline> {
  if (pipelinePromise) return pipelinePromise;

  onStatus({ state: "loading", progress: 0, file: null, error: null, transport: null });

  pipelinePromise = (async () => {
    try {
      const lib = await import("@huggingface/transformers");
      // In a browser the default is to look for weights on the same origin,
      // which does not exist here. Turning this off makes the library fetch
      // from the Hugging Face CDN and then keep them in Cache Storage, which is
      // what makes the second visit work offline.
      lib.env.allowLocalModels = false;

      const seen = new Map<string, { loaded: number; total: number }>();

      const classifier = (await lib.pipeline("zero-shot-classification", "Xenova/mobilebert-uncased-mnli", {
        dtype: "q8",
        progress_callback: (raw: ProgressUpdate) => {
          if (!raw || typeof raw !== "object") return;
          const status = String(raw.status ?? "");
          const file = raw.file ? String(raw.file) : null;
          if (file && typeof raw.loaded === "number" && typeof raw.total === "number" && raw.total > 0) {
            seen.set(file, { loaded: raw.loaded, total: raw.total });
          }
          let loaded = 0;
          let total = 0;
          for (const v of seen.values()) {
            loaded += v.loaded;
            total += v.total;
          }
          const ratio = total > 0 ? loaded / total : 0;
          const scaled = status === "ready" ? 1 : ratio * 0.95;
          onStatus({
            state: "loading",
            progress: Math.max(0, Math.min(1, scaled)),
            file,
            error: null,
            transport: "huggingface-cdn",
          });
        },
      })) as unknown as ZeroShotPipeline;

      cachedClassifier = classifier;
      onStatus({ state: "ready", progress: 1, file: null, error: null, transport: "huggingface-cdn" });
      return classifier;
    } catch (err) {
      pipelinePromise = null;
      const message =
        err instanceof Error
          ? /wasm|ort|onnx/i.test(err.message)
            ? `The ONNX runtime could not start: ${err.message}`
            : err.message
          : "The model could not be loaded.";
      onStatus({ state: "error", progress: 0, file: null, error: message, transport: null });
      throw new Error(message);
    }
  })();

  return pipelinePromise;
}

export function modelIsLoaded(): boolean {
  return cachedClassifier !== null;
}

/**
 * Classify a batch of segments.
 *
 * Batched in one call because the NLI forward pass dominates the cost, and
 * because a householder pasting five messages should not wait for five
 * round-trips through the tokenizer.
 */
export async function classifyDirections(texts: readonly string[]): Promise<Classification[]> {
  const classifier = cachedClassifier ?? (await loadDirectionModel(() => {}));
  if (texts.length === 0) return [];

  const output = await classifier(
    texts as string[],
    [...DIRECTION_HYPOTHESES],
    { hypothesis_template: HYPOTHESIS_TEMPLATE, multi_label: false },
  );

  const list = Array.isArray(output) ? output : [output];
  return texts.map((text, i) => {
    const row = list[i];
    if (!row) {
      return { text, direction: "not-money" as const, confidence: 0, scores: {} };
    }
    return toClassification(text, row);
  });
}

/** Reset the memo. Exposed so a test can simulate a second cold load. */
export function resetModel(): void {
  pipelinePromise = null;
  cachedClassifier = null;
}

/* -------------------------------------------------------------------------- */
/* Local Ollama, when one is running                                           */
/* -------------------------------------------------------------------------- */

export interface OllamaProbe {
  reachable: boolean;
  models: string[];
  error: string | null;
  /** Why it failed, when it failed. CORS is the usual reason in a browser. */
  hint: string | null;
}

/**
 * Ask the local Ollama daemon what it has.
 *
 * Deliberately non-destructive and completely optional. A browser cannot reach
 * 127.0.0.1 on the visitor's machine from a deployed site unless Ollama allows
 * that origin, so this usually reports "not reachable" — and that is reported
 * honestly rather than hidden, because a control that silently does nothing is
 * worse than a control that explains itself.
 */
export async function probeOllama(endpoint = "http://127.0.0.1:11434", timeoutMs = 2500): Promise<OllamaProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return { reachable: false, models: [], error: `HTTP ${res.status}`, hint: "Ollama answered but refused the request." };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? [])
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0);
    return { reachable: true, models, error: null, hint: null };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      reachable: false,
      models: [],
      error: aborted ? `no answer within ${timeoutMs}ms` : "could not connect",
      hint:
        "Ollama is not reachable from this page. Either it is not running, or it is blocking this origin. To allow it, start it with OLLAMA_ORIGINS set to this site's origin.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a local Ollama model for structured JSON.
 *
 * Returns null when the daemon is not there. The caller falls back to the
 * deterministic reader, and the line records which engine produced it.
 */
export async function ollamaExtract(
  texts: readonly string[],
  model: string,
  endpoint = "http://127.0.0.1:11434",
  timeoutMs = 30_000,
): Promise<Array<{ direction: "outflow" | "inflow" | "not-money"; confidence: number }> | null> {
  if (texts.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prompt =
      "For each line below, decide whether money left the household, came into the household, " +
      "or whether the line is not about money at all. Reply with a JSON array of objects with " +
      'keys "line" (integer, 1-based) and "direction" ("outflow" | "inflow" | "not-money"). ' +
      "Reply with JSON only, no prose.\n\n" +
      texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

    const res = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0 },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Array<{ line?: number; direction?: string }>;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((row, i) => {
      const dir = row.direction;
      return {
        direction: dir === "outflow" || dir === "inflow" ? dir : "not-money",
        confidence: 0.9,
        ...(typeof row.line === "number" ? {} : { line: i + 1 }),
      };
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const MODEL_BYTES = APPROX_BYTES;