import { describe, expect, it } from "vitest";
import {
  CLOUD_CONFIDENCE_CEILING,
  CloudModelError,
  DEFAULT_CLOUD_MODEL,
  cloudConfig,
  cloudDirection,
  parseAnswer,
  type CloudDeps,
} from "@/lib/cloud-model";

const KEY = "unit-test-key-never-a-real-one";

const geminiBody = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
});

type Call = { url: string; init?: RequestInit };

function withFetch(
  respond: (call: Call) => Response | Promise<Response>,
): { deps: CloudDeps; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { deps: { fetchImpl, env: { GEMINI_API_KEY: KEY } }, calls };
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cloudConfig", () => {
  it("reports itself as absent when no key is configured", () => {
    const config = cloudConfig({});
    expect(config.configured).toBe(false);
    expect(config.provider).toBe("google");
    expect(config.model).toBe(DEFAULT_CLOUD_MODEL);
  });

  it("reports itself as present when a key exists, without exposing it", () => {
    const config = cloudConfig({ GEMINI_API_KEY: KEY });
    expect(config.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain(KEY);
  });

  it("honours a model override and falls back to the default for an empty one", () => {
    expect(cloudConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "gemini-2.5-flash-lite" }).model).toBe(
      "gemini-2.5-flash-lite",
    );
    expect(cloudConfig({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "   " }).model).toBe(DEFAULT_CLOUD_MODEL);
  });
});

describe("cloudDirection", () => {
  it("refuses without a key and never calls the network", async () => {
    const { deps, calls } = withFetch(() => ok(geminiBody("{}")));
    deps.env = {};
    await expect(cloudDirection("wifi seller refunded me 320", deps)).rejects.toMatchObject({
      code: "not-configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("sends the key as a header and never in the URL", async () => {
    const { deps, calls } = withFetch(() => ok(geminiBody('{"direction":"inflow","confidence":0.8}')));
    await cloudDirection("wifi seller refunded me 320", deps);

    const [call] = calls;
    expect(calls).toHaveLength(1);
    expect(call?.url).not.toContain(KEY);
    expect(call?.url).toContain(DEFAULT_CLOUD_MODEL);
    expect(call?.url).toContain("generativelanguage.googleapis.com");
    expect(new Headers(call?.init?.headers).get("x-goog-api-key")).toBe(KEY);
  });

  it("returns the direction the model answered with", async () => {
    const { deps } = withFetch(() => ok(geminiBody('{"direction":"inflow","confidence":0.75}')));
    const answer = await cloudDirection("wifi seller refunded me 320", deps);
    expect(answer).toMatchObject({ direction: "inflow", confidence: 0.75, model: DEFAULT_CLOUD_MODEL });
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("clamps a self-reported confidence under the ceiling and off zero", async () => {
    const ceiling = withFetch(() => ok(geminiBody('{"direction":"outflow","confidence":0.99}')));
    expect((await cloudDirection("sent 200 to the plumber", ceiling.deps)).confidence).toBe(
      CLOUD_CONFIDENCE_CEILING,
    );

    const floor = withFetch(() => ok(geminiBody('{"direction":"inflow","confidence":0.001}')));
    expect((await cloudDirection("received 50", floor.deps)).confidence).toBe(0.05);
  });

  it("treats a missing confidence as a hedge, not as certainty", async () => {
    const { deps } = withFetch(() => ok(geminiBody('{"direction":"inflow"}')));
    expect((await cloudDirection("received 50", deps)).confidence).toBe(0.6);
  });

  it("tolerates a markdown fence around the JSON", async () => {
    const { deps } = withFetch(() =>
      ok(geminiBody('```json\n{"direction":"outflow","confidence":0.7}\n```')),
    );
    expect((await cloudDirection("paid 100", deps)).direction).toBe("outflow");
  });

  it("reports an upstream refusal with the provider's own message", async () => {
    const { deps } = withFetch(() => ok({ error: { message: "API key not valid." } }, 400));
    await expect(cloudDirection("paid 100", deps)).rejects.toMatchObject({
      code: "upstream",
      message: expect.stringContaining("API key not valid."),
    });
  });

  it("reports a transport failure as upstream, without leaking internals", async () => {
    const deps: CloudDeps = {
      env: { GEMINI_API_KEY: KEY },
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    };
    await expect(cloudDirection("paid 100", deps)).rejects.toMatchObject({ code: "upstream" });
  });

  it("reports no-answer when the model returns nothing readable", async () => {
    const empty = withFetch(() => ok({ candidates: [] }));
    await expect(cloudDirection("paid 100", empty.deps)).rejects.toMatchObject({ code: "no-answer" });

    const blocked = withFetch(() => ok({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(cloudDirection("paid 100", blocked.deps)).rejects.toMatchObject({ code: "no-answer" });

    const unparseable = withFetch(() => ok(geminiBody("I would rather not say.")));
    await expect(cloudDirection("paid 100", unparseable.deps)).rejects.toMatchObject({ code: "no-answer" });
  });

  it("always surfaces a CloudModelError, so the route can map it to a status", async () => {
    const { deps } = withFetch(() => ok(geminiBody("not json at all")));
    await expect(cloudDirection("paid 100", deps)).rejects.toBeInstanceOf(CloudModelError);
  });
});

describe("parseAnswer", () => {
  it("accepts every direction this reader knows", () => {
    for (const direction of ["outflow", "inflow", "not-money"]) {
      expect(parseAnswer(`{"direction":"${direction}"}`)).toMatchObject({ direction });
    }
  });

  it("refuses a direction the reader does not have", () => {
    expect(parseAnswer('{"direction":"sideways","confidence":0.9}')).toBeNull();
    expect(parseAnswer("just some prose")).toBeNull();
    expect(parseAnswer("")).toBeNull();
    expect(parseAnswer("[]")).toBeNull();
    expect(parseAnswer('{"confidence":0.9}')).toBeNull();
  });
});
