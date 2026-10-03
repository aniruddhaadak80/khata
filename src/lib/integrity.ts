/**
 * Append-only integrity chain.
 *
 * khata exists so two people can agree on a number without having to trust the
 * person who typed it in. That claim is only worth anything if the ledger's
 * history can be checked, so every create, update, decision and delete is
 * sealed:
 *
 *     seal_n = SHA-384( UTF-8(prevSeal) || canonicalJson(event_n) )
 *
 * `canonicalJson` recursively sorts object keys, so the byte representation is
 * identical regardless of property insertion order. Without that, a refactor
 * that reordered two keys would look like tampering and every replay would fail.
 *
 * Chains are per-entity: each ledger line carries its own history, starting from
 * genesis and independent of every other line. The household itself is an
 * entity too, so settlements and share-link mints are chained separately.
 */

import { createHash } from "node:crypto";
import type { AuditEvent } from "./types";

/** 384 bits of zero, as hex. */
export const GENESIS_SEAL = "0".repeat(96);

/**
 * Deterministic JSON serialisation.
 *
 * - object keys sorted lexicographically, recursively
 * - arrays keep their order (order is meaningful in an audit payload)
 * - no incidental whitespace
 * - non-finite numbers become `null`, because `JSON.stringify(NaN)` is `"null"`
 *   but `String(NaN)` is `"NaN"` and a NaN must never produce two different
 *   byte strings for what the application treats as one value
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) return "null";
    return JSON.stringify(value);
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (type === "undefined" || type === "function") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha384Hex(input: string): string {
  return createHash("sha384").update(input, "utf8").digest("hex");
}

/** The exact pre-image that gets hashed, exposed so tests can pin a vector. */
export function sealPreimage(prevSeal: string, event: Omit<AuditEvent, "seal">): string {
  return prevSeal + canonicalJson(event);
}

export function computeSeal(prevSeal: string, event: Omit<AuditEvent, "seal">): string {
  return sha384Hex(sealPreimage(prevSeal, event));
}

/** Build a fully sealed event, chaining from the given previous seal. */
export function sealEvent(prevSeal: string, event: Omit<AuditEvent, "seal">): AuditEvent {
  return { ...event, seal: computeSeal(prevSeal, event) };
}

export interface ReplayResult {
  ok: boolean;
  checked: number;
  firstBrokenAt: number | null;
  firstBrokenId: string | null;
  headSeal: string;
  reason: string | null;
}

export interface ChainReport extends ReplayResult {
  chainId: string;
  actions: string[];
}

export interface GroupedReplayResult {
  ok: boolean;
  chains: number;
  events: number;
  brokenChains: Array<{
    chainId: string;
    firstBrokenAt: number | null;
    firstBrokenId: string | null;
    reason: string | null;
  }>;
  /** Per-chain heads, sorted by chain id so the report is byte-stable. */
  heads: Array<{ chainId: string; headSeal: string; events: number }>;
  headSeal: string;
  reports: ChainReport[];
}

/**
 * Walk one chain in order and recompute every seal.
 *
 * Reports the *first* link that does not match, which is exactly the event an
 * operator needs to look at.
 */
export function replayChain(chainId: string, events: AuditEvent[]): ChainReport {
  const base = {
    chainId,
    actions: events.map((e) => e.action),
  };

  if (events.length === 0) {
    return { ...base, ok: true, checked: 0, firstBrokenAt: null, firstBrokenId: null, headSeal: GENESIS_SEAL, reason: null };
  }

  let prev = GENESIS_SEAL;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.prevSeal !== prev) {
      return {
        ...base,
        ok: false,
        checked: i,
        firstBrokenAt: i,
        firstBrokenId: ev.id,
        headSeal: prev,
        reason: `prevSeal mismatch at index ${i}: the chain was reordered or an event was removed.`,
      };
    }
    const expected = computeSeal(prev, {
      id: ev.id,
      chainId: ev.chainId,
      action: ev.action,
      payload: ev.payload,
      prevSeal: ev.prevSeal,
      createdAt: ev.createdAt,
    });
    if (expected !== ev.seal) {
      return {
        ...base,
        ok: false,
        checked: i,
        firstBrokenAt: i,
        firstBrokenId: ev.id,
        headSeal: prev,
        reason: `seal mismatch at index ${i}: this event's contents were altered after it was written.`,
      };
    }
    prev = ev.seal;
  }

  return { ...base, ok: true, checked: events.length, firstBrokenAt: null, firstBrokenId: null, headSeal: prev, reason: null };
}

/**
 * Total order for events in one chain.
 *
 * `createdAt` alone is not a total order — two events written in the same
 * millisecond would replay differently depending on database row order, so
 * replay would be irreproducible. Ties break on id.
 */
export function compareEvents(a: AuditEvent, b: AuditEvent): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Verify every per-entity chain in a mixed event list, each from genesis. */
export function replayAllChains(events: AuditEvent[]): GroupedReplayResult {
  const groups = new Map<string, AuditEvent[]>();
  for (const ev of events) {
    const list = groups.get(ev.chainId);
    if (list) list.push(ev);
    else groups.set(ev.chainId, [ev]);
  }

  const brokenChains: GroupedReplayResult["brokenChains"] = [];
  const heads: GroupedReplayResult["heads"] = [];
  const reports: ChainReport[] = [];
  let ok = true;
  let total = 0;

  const ids = [...groups.keys()].sort();
  for (const chainId of ids) {
    const ordered = [...(groups.get(chainId) ?? [])].sort(compareEvents);
    const result = replayChain(chainId, ordered);
    total += ordered.length;
    reports.push(result);
    if (!result.ok) {
      ok = false;
      brokenChains.push({
        chainId,
        firstBrokenAt: result.firstBrokenAt,
        firstBrokenId: result.firstBrokenId,
        reason: result.reason,
      });
    }
    if (ordered.length > 0) {
      const last = ordered[ordered.length - 1];
      if (last) heads.push({ chainId, headSeal: last.seal, events: ordered.length });
    }
  }

  // A single "ledger seal" that summarises the whole book: a digest over every
  // per-chain head, in sorted chain order. Two identical books always produce
  // the same ledger seal.
  const ledgerSeal = sha384Hex(heads.map((h) => `${h.chainId}:${h.headSeal}`).join("\n"));

  return { ok, chains: groups.size, events: total, brokenChains, heads, headSeal: ledgerSeal, reports };
}

/** Short display form: first 12 hex characters, uppercase. */
export function shortSeal(seal: string): string {
  return `${seal.slice(0, 12).toUpperCase()}`;
}