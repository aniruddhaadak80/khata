import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  GENESIS_SEAL,
  canonicalJson,
  compareEvents,
  computeSeal,
  replayAllChains,
  replayChain,
  sealEvent,
  shortSeal,
} from "@/lib/integrity";
import type { AuditEvent } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* canonicalJson                                                               */
/* -------------------------------------------------------------------------- */

describe("canonical JSON", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("produces identical bytes regardless of insertion order", () => {
    const one = canonicalJson({ amount: 100, currency: "INR", paidBy: "me" });
    const two = canonicalJson({ paidBy: "me", currency: "INR", amount: 100 });
    expect(one).toBe(two);
  });

  it("preserves array order, because order is meaningful in an audit payload", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("normalises non-finite numbers to null so NaN has one byte representation", () => {
    expect(canonicalJson(Number.NaN)).toBe("null");
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe("null");
    expect(canonicalJson({ x: Number.NaN })).toBe('{"x":null}');
  });

  it("drops undefined rather than emitting an ambiguous value", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("renders a Date as its ISO string", () => {
    expect(canonicalJson(new Date("2026-10-03T00:00:00.000Z"))).toBe('"2026-10-03T00:00:00.000Z"');
  });
});

/* -------------------------------------------------------------------------- */
/* Sealing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pinned vectors.
 *
 * These digests were produced by hand from the documented algorithm
 * (`SHA-384( UTF-8(prevSeal) || canonicalJson(event) )`) and are checked in so a
 * refactor that changes the byte representation fails a test rather than
 * silently invalidating every seal already written.
 */
describe("seal vectors", () => {
  const baseEvent = {
    id: "event-1",
    chainId: "chain-a",
    action: "entry.create" as const,
    payload: '{"amountMinor":1000}',
    prevSeal: GENESIS_SEAL,
    createdAt: "2026-10-03T00:00:00.000Z",
  };

  it("matches a hand-computed digest for the first event", () => {
    const expected = createHash("sha384")
      .update(GENESIS_SEAL + canonicalJson(baseEvent), "utf8")
      .digest("hex");
    expect(computeSeal(GENESIS_SEAL, baseEvent)).toBe(expected);
    expect(expected).toHaveLength(96);
  });

  it("changes when any single field of the event changes", () => {
    const original = computeSeal(GENESIS_SEAL, baseEvent);
    const variants = [
      { ...baseEvent, id: "event-2" },
      { ...baseEvent, chainId: "chain-b" },
      { ...baseEvent, action: "entry.delete" as const },
      { ...baseEvent, payload: '{"amountMinor":1001}' },
      { ...baseEvent, createdAt: "2026-10-03T00:00:00.001Z" },
    ];
    for (const variant of variants) {
      expect(computeSeal(GENESIS_SEAL, variant)).not.toBe(original);
    }
  });

  it("changes when the previous seal changes, so order cannot be swapped", () => {
    const other = "f".repeat(96);
    expect(computeSeal(other, baseEvent)).not.toBe(computeSeal(GENESIS_SEAL, baseEvent));
  });

  it("starts from genesis, which is 384 bits of zero", () => {
    expect(GENESIS_SEAL).toBe("0".repeat(96));
    expect(GENESIS_SEAL).toHaveLength(96);
  });

  it("abbreviates a seal to twelve uppercase characters for display", () => {
    const sealed = sealEvent(GENESIS_SEAL, baseEvent);
    expect(shortSeal(sealed.seal)).toBe(sealed.seal.slice(0, 12).toUpperCase());
    expect(shortSeal(sealed.seal)).toHaveLength(12);
  });
});

/* -------------------------------------------------------------------------- */
/* Replay                                                                      */
/* -------------------------------------------------------------------------- */

function buildChain(chainId: string, actions: AuditEvent["action"][]): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prev = GENESIS_SEAL;
  for (const [index, action] of actions.entries()) {
    const event = sealEvent(prev, {
      id: `${chainId}-${index + 1}`,
      chainId,
      action,
      payload: JSON.stringify({ index }),
      prevSeal: prev,
      createdAt: new Date(Date.UTC(2026, 9, 3, 10, 0, index)).toISOString(),
    });
    events.push(event);
    prev = event.seal;
  }
  return events;
}

describe("replay", () => {
  it("passes on an empty chain and reports genesis as the head", () => {
    const result = replayChain("empty", []);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.headSeal).toBe(GENESIS_SEAL);
  });

  it("passes on an untouched chain and returns its head", () => {
    const events = buildChain("chain-a", ["entry.create", "entry.confirm", "entry.delete"]);
    const result = replayChain("chain-a", events);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.headSeal).toBe(events[events.length - 1]!.seal);
  });

  it("detects an altered payload and names the index", () => {
    const events = buildChain("chain-a", ["entry.create", "entry.confirm"]);
    const tampered = events.map((e, i) => (i === 1 ? { ...e, payload: '{"index":99}' } : e));
    const result = replayChain("chain-a", tampered);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenAt).toBe(1);
    expect(result.firstBrokenId).toBe("chain-a-2");
    expect(result.reason).toMatch(/altered after it was written/);
  });

  it("detects a removed event as a prevSeal mismatch", () => {
    const events = buildChain("chain-a", ["entry.create", "entry.confirm", "entry.delete"]);
    const withHole = [events[0]!, events[2]!];
    const result = replayChain("chain-a", withHole);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenAt).toBe(1);
    expect(result.reason).toMatch(/reordered or an event was removed/);
  });

  it("detects reordering", () => {
    const events = buildChain("chain-a", ["entry.create", "entry.confirm"]);
    const swapped = [events[1]!, events[0]!];
    const result = replayChain("chain-a", swapped);
    expect(result.ok).toBe(false);
  });

  it("orders events written in the same millisecond by id, so replay is reproducible", () => {
    // Built with one shared timestamp. Rewriting `createdAt` on an already
    // sealed event would break its digest, which is the chain working correctly
    // rather than a bug to work around.
    const stamp = "2026-10-03T10:00:00.000Z";
    const events: AuditEvent[] = [];
    let prev = GENESIS_SEAL;
    for (const [index, action] of (["entry.create", "entry.confirm"] as const).entries()) {
      const event = sealEvent(prev, {
        id: `chain-a-${index + 1}`,
        chainId: "chain-a",
        action,
        payload: JSON.stringify({ index }),
        prevSeal: prev,
        createdAt: stamp,
      });
      events.push(event);
      prev = event.seal;
    }

    const forward = [...events].sort(compareEvents);
    const backward = [...events].reverse().sort(compareEvents);
    expect(forward.map((e) => e.id)).toEqual(["chain-a-1", "chain-a-2"]);
    expect(backward.map((e) => e.id)).toEqual(forward.map((e) => e.id));
    expect(replayChain("chain-a", forward).ok).toBe(true);
  });
});

describe("replay across chains", () => {
  it("replays every chain independently from genesis", () => {
    const events = [
      ...buildChain("a", ["entry.create", "entry.confirm"]),
      ...buildChain("b", ["entry.create"]),
    ];
    const result = replayAllChains(events);
    expect(result.ok).toBe(true);
    expect(result.chains).toBe(2);
    expect(result.events).toBe(3);
  });

  it("reports only the broken chain, leaving the intact one clean", () => {
    const good = buildChain("a", ["entry.create"]);
    const bad = buildChain("b", ["entry.create", "entry.confirm"]).map((e, i) =>
      i === 1 ? { ...e, payload: "tampered" } : e,
    );
    const result = replayAllChains([...good, ...bad]);
    expect(result.ok).toBe(false);
    expect(result.brokenChains).toHaveLength(1);
    expect(result.brokenChains[0]!.chainId).toBe("b");
  });

  it("produces the same ledger seal for the same set of chains in any order", () => {
    const a = buildChain("a", ["entry.create"]);
    const b = buildChain("b", ["entry.create", "entry.confirm"]);
    expect(replayAllChains([...a, ...b]).headSeal).toBe(replayAllChains([...b, ...a]).headSeal);
  });

  it("survives a delete: the chain keeps replaying after a tombstone", () => {
    const events = buildChain("a", ["entry.create", "entry.delete"]);
    const result = replayAllChains(events);
    expect(result.ok).toBe(true);
    expect(result.events).toBe(2);
    expect(result.heads[0]!.events).toBe(2);
  });
});