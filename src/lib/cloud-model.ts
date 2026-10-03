/**
 * The optional cloud tier: Google Gemini, called from the server only.
 *
 * khata's core reader never needs this. The rules read every field, the
 * open-weight MobileBERT model runs in the visitor's own browser, and Ollama is
 * offered when a local daemon answers. This module is the third tier for the
 * one situation those cannot cover: a deployment whose owner has chosen to let
 * a hosted model re-decide the directions the rules left unclear.
 *
 * Three properties are load-bearing:
 *
 * 1. **The key never reaches the browser.** `GEMINI_API_KEY` is read from the
 *    server environment and sent as a header. Nothing here puts it in a URL, a
 *    response body or a client bundle, and a request without the key configured
 *    fails with `not-configured` rather than silently pretending to be a model.
 * 2. **No key means no behaviour change.** With the variable absent,
 *    `cloudConfig().configured` is false, the route refuses, the button is not
 *    rendered, and the app is exactly the app that was verified without it.
 * 3. **The answer is still a candidate, not a verdict.** Whatever comes back is
 *    handed to the same `resolveDirection` the browser model uses, so a cloud
 *    answer can only decide a line the rules gave up on or overrule a rule it
 *    is at least as confident about. It cannot bypass the reader.
 */

/** A flash-lite endpoint: fast, cheap, and inside the free tier's limits. */
export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

export type CloudDirection = "outflow" | "inflow" | "not-money";

export interface CloudClassification {
  direction: CloudDirection;
  /**
   * Self-reported by the hosted model and deliberately clamped. It is *not*
   * the calibrated softmax margin the local NLI model produces, which is why
   * it can never exceed this ceiling: an unhedged guess from a chat model
   * must not be able to overrule a rule the engine measured.
   */
  confidence: number;
  model: string;
  latencyMs: number;
}

export type CloudErrorCode = "not-configured" | "upstream" | "no-answer";

export class CloudModelError extends Error {
  readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode, message: string) {
    super(message);
    this.name = "CloudModelError";
    this.code = code;
  }
}

export interface CloudConfig {
  configured: boolean;
  provider: "google";
  model: string;
}

/**
 * The subset of the environment this module reads. Not `NodeJS.ProcessEnv`,
 * which this repo's type settings require to carry `NODE_ENV` — an injected
 * env in a test is a plain map of strings.
 */
export type CloudEnv = Record<string, string | undefined>;

/** Highest confidence a hosted model's self-assessment may claim. */
export const CLOUD_CONFIDENCE_CEILING = 0.9;

const DIRECTIONS: readonly CloudDirection[] = ["outflow", "inflow", "not-money"];

export function cloudConfig(env: CloudEnv = process.env): CloudConfig {
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_CLOUD_MODEL;
  return { configured: Boolean(key), provider: "google", model };
}

/**
 * The whole instruction. Deliberately small: free-tier quotas are per minute,
 * and a householder pasting six messages should not spend them on prose.
 */
function promptFor(text: string): string {
  return [
    "You read one household payment message and decide which way the money moved.",
    'Answer with JSON only: {"direction":"outflow|inflow|not-money","confidence":0.0-1.0}',
    "outflow = money left the household (paid, sent, purchased, debited).",
    "inflow = money arrived (received, refunded in, credited, salary).",
    "not-money = the message is not about a payment at all.",
    "Use 0.5 confidence when you are genuinely unsure; do not round up to be helpful.",
    `Message: ${text}`,
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    direction: { type: "STRING", enum: [...DIRECTIONS] },
    confidence: { type: "NUMBER" },
  },
  required: ["direction"],
} as const;

export interface CloudDeps {
  fetchImpl?: typeof fetch;
  env?: CloudEnv;
}

/**
 * Ask the hosted model for one direction.
 *
 * Throws `CloudModelError` with a code the route maps to an honest status:
 * `not-configured` (503, the deployment chose not to offer this),
 * `upstream` (503, Gemini refused or was unreachable),
 * `no-answer` (503, it answered with nothing we can read).
 */
export async function cloudDirection(text: string, deps: CloudDeps = {}): Promise<CloudClassification> {
  const env = deps.env ?? process.env;
  const config = cloudConfig(env);
  if (!config.configured) {
    throw new CloudModelError("not-configured", "No GEMINI_API_KEY is configured on this deployment.");
  }
  const key = env.GEMINI_API_KEY?.trim() as string;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: promptFor(text) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 128,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new CloudModelError(
      "upstream",
      err instanceof Error ? `Gemini could not be reached: ${err.message}.` : "Gemini could not be reached.",
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload?.error?.message) detail = payload.error.message;
    } catch {
      // The status code alone is the honest part; the body was not JSON.
    }
    throw new CloudModelError("upstream", `Gemini refused the request (${detail}).`);
  }

  let payload: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new CloudModelError("no-answer", "Gemini returned a body that was not JSON.");
  }

  if (payload.promptFeedback?.blockReason) {
    throw new CloudModelError("no-answer", `Gemini declined the prompt (${payload.promptFeedback.blockReason}).`);
  }

  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw || payload.candidates?.[0]?.finishReason === "SAFETY") {
    throw new CloudModelError("no-answer", "Gemini returned no readable answer for that line.");
  }

  const parsed = parseAnswer(raw);
  if (!parsed) {
    throw new CloudModelError("no-answer", "Gemini's answer was not the JSON shape this reader expects.");
  }

  return {
    direction: parsed.direction,
    confidence: parsed.confidence,
    model: config.model,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Parse what the model produced, tolerating the fence some models still wrap
 * JSON in, and nothing else. An unparseable answer is an error, never a guess
 * attributed to the model.
 */
export function parseAnswer(raw: string): { direction: CloudDirection; confidence: number } | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let value: unknown;
  try {
    value = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const candidate = value as { direction?: unknown; confidence?: unknown };
  if (typeof candidate.direction !== "string" || !DIRECTIONS.includes(candidate.direction as CloudDirection)) {
    return null;
  }

  const reported = typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
    ? candidate.confidence
    : 0.6;

  const confidence = Math.min(CLOUD_CONFIDENCE_CEILING, Math.max(0.05, reported));
  return { direction: candidate.direction as CloudDirection, confidence };
}
