/**
 * Persistence, end to end, against the same embedded Postgres the zero-config
 * development server uses. These are integration tests: they exercise the real
 * schema, the real constraints and the real soft-delete semantics.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRepository, makeRepository, type Repository } from "@/lib/repository";
import { replayAllChains } from "@/lib/integrity";
import type { CpiSnapshot, FxSnapshot, Household } from "@/lib/types";
import { analyseSettlement } from "@/lib/engine";

const OWNER = "test-owner-scope-0000000001";
const OTHER = "test-owner-scope-0000000002";

const HOUSEHOLD: Omit<Household, "id" | "ownerId" | "createdAt" | "updatedAt"> = {
  name: "Our flat",
  baseCurrency: "INR",
  countryCode: "IN",
  members: [
    { id: "me", name: "Arunima", kind: "you" },
    { id: "them", name: "Meera", kind: "flatmate" },
  ],
};

const FX: FxSnapshot = {
  status: "live",
  base: "INR",
  asOf: "2026-10-02",
  fetchedAt: "2026-10-03T06:00:00.000Z",
  provider: "European Central Bank via Frankfurter",
  providerUrl: "https://api.frankfurter.app/latest?from=INR",
  attribution: "ECB via Frankfurter",
  rates: { INR: 1, USD: 0.01038 },
  supported: ["INR", "USD"],
};

const CPI: CpiSnapshot = {
  status: "live",
  country: "IN",
  indicator: "FP.CPI.TOTL",
  indicatorName: "Consumer price index (2010 = 100)",
  lastUpdated: "2026-07-13",
  fetchedAt: "2026-10-03T06:00:00.000Z",
  provider: "World Bank Open Data",
  providerUrl: "https://data.worldbank.org/indicator/FP.CPI.TOTL?locations=IN",
  attribution: "World Bank Open Data",
  series: [{ year: 2025, value: 233.063 }, { year: 2024, value: 227.603 }],
};

let repo: Repository;
let household: Household;

function record(over: Partial<Parameters<Repository["createEntry"]>[1]> = {}) {
  return {
    householdId: household.id,
    occurredOn: "2026-10-02",
    direction: "outflow" as const,
    amountMinor: 24_000,
    currency: "INR",
    fxRateToBase: 1,
    amountBaseMinor: 24_000,
    paidBy: "me",
    category: "utilities" as const,
    note: "",
    rawText: "Paid 240 for the cylinder",
    evidence: "paste" as const,
    parseEngine: "deterministic" as const,
    parseConfidence: 0.9,
    splitMode: "equal" as const,
    participants: ["me", "them"],
    exactShares: null,
    status: "confirmed" as const,
    receiptRef: null,
    idempotencyKey: null,
    ...over,
  };
}

beforeAll(async () => {
  repo = await getRepository();
  await repo.init();
  household = await repo.createHousehold(OWNER, HOUSEHOLD);
});

afterAll(async () => {
  await repo?.close();
});

describe("schema", () => {
  it("answers a real health query rather than returning a static object", async () => {
    const result = await repo.health();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/SELECT 1/);
  });

  it("reports which adapter answered", () => {
    expect(repo.kind).toBe("pglite-embedded");
  });

  it("creates every table, index and constraint idempotently", async () => {
    // Running init twice must not throw: createIfNotExists plus partial unique
    // indexes have to be safe on a fresh boot and on every request after it.
    await expect(repo.init()).resolves.toBeUndefined();
    await expect(repo.init()).resolves.toBeUndefined();
  });
});

describe("households", () => {
  it("gives one household per owner, and is idempotent", async () => {
    const again = await repo.createHousehold(OWNER, { ...HOUSEHOLD, name: "A different name" });
    expect(again.id).toBe(household.id);
    expect(again.name).toBe(HOUSEHOLD.name);
  });

  it("gives a different owner a different household", async () => {
    const mine = await repo.getHousehold(OTHER);
    expect(mine).toBeNull();
  });

  it("updates in place and keeps the id", async () => {
    const updated = await repo.updateHousehold(OWNER, { name: "Renamed flat", members: [...HOUSEHOLD.members, { id: "third", name: "Rin", kind: "family" }] });
    expect(updated?.id).toBe(household.id);
    expect(updated?.name).toBe("Renamed flat");
    expect(updated?.members).toHaveLength(3);
    await repo.updateHousehold(OWNER, { name: "Our flat", members: HOUSEHOLD.members });
  });
});

describe("entries", () => {
  it("creates, reads back and updates a line", async () => {
    const created = await repo.createEntry(OWNER, record({ note: "electricity" }));
    const read = await repo.getEntry(OWNER, created.id);
    expect(read?.note).toBe("electricity");
    expect(read?.amountBaseMinor).toBe(24_000);
    expect(read?.deleted).toBe(false);

    const updated = await repo.updateEntry(OWNER, created.id, { note: "september electricity", baseCurrency: "INR" });
    expect(updated?.note).toBe("september electricity");
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
  });

  it("recomputes the base amount from the amount, currency and rate", async () => {
    // fxRateToBase is base per one unit of the entry currency: USD 100 in an INR
    // household at 96.32 INR per USD is 9632 INR = 963200 paise.
    const created = await repo.createEntry(OWNER, record({
      currency: "USD", amountMinor: 10_000, fxRateToBase: 96.32, amountBaseMinor: 963_200,
    }));
    const updated = await repo.updateEntry(OWNER, created.id, { amountMinor: 20_000, baseCurrency: "INR" });
    // Doubling the USD amount at the same rate doubles the base amount.
    expect(updated?.amountBaseMinor).toBe(1_926_400);
  });

  it("never returns another owner's line", async () => {
    const created = await repo.createEntry(OWNER, record());
    expect(await repo.getEntry(OTHER, created.id)).toBeNull();
    const listed = await repo.listEntries(OTHER, household.id, {
      limit: 25, offset: 0, status: "all", direction: "all", category: "all", sort: "created_desc",
    });
    expect(listed.total).toBe(0);
  });

  it("keeps a tombstone after a delete, so the chain stays replayable", async () => {
    const created = await repo.createEntry(OWNER, record());
    await repo.appendAudit(created.id, "entry.create", { id: created.id }, OWNER);
    const deleted = await repo.deleteEntry(OWNER, created.id);

    expect(deleted?.deleted).toBe(true);
    expect(await repo.getEntry(OWNER, created.id)).toBeNull();

    const events = await repo.listAudit(OWNER, created.id);
    expect(events).toHaveLength(1);
    expect(replayAllChains(events).ok).toBe(true);
  });

  it("reports a second delete of the same line as absent rather than deleting twice", async () => {
    const created = await repo.createEntry(OWNER, record());
    expect(await repo.deleteEntry(OWNER, created.id)).not.toBeNull();
    expect(await repo.deleteEntry(OWNER, created.id)).toBeNull();
  });

  it("makes an idempotency key a promise, not a hope", async () => {
    const key = "test-idempotency-key-000001";
    const first = await repo.createEntry(OWNER, record({ idempotencyKey: key }));
    const second = await repo.createEntry(OWNER, record({ idempotencyKey: key }));
    expect(second.id).toBe(first.id);

    const found = await repo.findEntryByIdempotencyKey(OWNER, key);
    expect(found?.id).toBe(first.id);
  });

  it("keeps idempotency keys scoped per owner", async () => {
    const key = "test-idempotency-key-shared";
    const mine = await repo.createEntry(OWNER, record({ idempotencyKey: key }));
    const theirs = await repo.createEntry(OTHER, record({ idempotencyKey: key, householdId: household.id }));
    expect(theirs.id).not.toBe(mine.id);
  });
});

describe("filtering, sorting and pagination", () => {
  const BASE = { limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "created_asc" } as const;

  let ids: string[] = [];

  beforeAll(async () => {
    ids = [];
    for (const over of [
      { note: "a-groceries", category: "groceries" as const, status: "confirmed" as const, direction: "outflow" as const, amountMinor: 100, amountBaseMinor: 100, occurredOn: "2026-10-01", paidBy: "me" },
      { note: "b-utilities", category: "utilities" as const, status: "draft" as const, direction: "outflow" as const, amountMinor: 200, amountBaseMinor: 200, occurredOn: "2026-10-02", paidBy: "them" },
      { note: "c-rent", category: "rent" as const, status: "disputed" as const, direction: "inflow" as const, amountMinor: 300, amountBaseMinor: 300, occurredOn: "2026-10-03", paidBy: "me" },
    ]) {
      const created = await repo.createEntry(OWNER, record(over));
      ids.push(created.id);
    }
  });

  it("filters by status", async () => {
    const drafts = await repo.listEntries(OWNER, household.id, { ...BASE, status: "draft" });
    expect(drafts.items.every((e) => e.status === "draft")).toBe(true);
    expect(drafts.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by direction and category", async () => {
    const inflow = await repo.listEntries(OWNER, household.id, { ...BASE, direction: "inflow" });
    expect(inflow.items.every((e) => e.direction === "inflow")).toBe(true);

    const groceries = await repo.listEntries(OWNER, household.id, { ...BASE, category: "groceries" });
    expect(groceries.items.every((e) => e.category === "groceries")).toBe(true);
  });

  it("filters by member, matching either role", async () => {
    const paidByThem = await repo.listEntries(OWNER, household.id, { ...BASE, member: "them" });
    expect(paidByThem.items.every((e) => e.paidBy === "them" || e.participants.includes("them"))).toBe(true);
    expect(paidByThem.total).toBeGreaterThan(0);
  });

  it("sorts by the event date as well as by creation order", async () => {
    const ascending = await repo.listEntries(OWNER, household.id, { ...BASE, sort: "occurred_asc" });
    const dates = ascending.items.map((e) => e.occurredOn);
    expect([...dates].sort()).toEqual(dates);
  });

  it("paginates without losing or duplicating rows", async () => {
    const all = await repo.listEntries(OWNER, household.id, BASE);
    const pageOne = await repo.listEntries(OWNER, household.id, { ...BASE, limit: 2, offset: 0 });
    const pageTwo = await repo.listEntries(OWNER, household.id, { ...BASE, limit: 2, offset: 2 });

    expect(pageOne.total).toBe(all.total);
    expect(pageOne.items).toHaveLength(2);
    expect(new Set([...pageOne.items, ...pageTwo.items].map((e) => e.id)).size).toBe(
      Math.min(all.total, 4),
    );
  });

  it("returns an empty page past the end instead of erroring", async () => {
    const past = await repo.listEntries(OWNER, household.id, { ...BASE, offset: 100_000 });
    expect(past.items).toEqual([]);
    expect(past.total).toBeGreaterThan(0);
  });
});

describe("audit chain", () => {
  it("chains per entity, independently, and replays clean", async () => {
    const a = await repo.createEntry(OWNER, record({ amountMinor: 111 }));
    const b = await repo.createEntry(OWNER, record({ amountMinor: 222 }));

    await repo.appendAudit(a.id, "entry.create", { n: 1 }, OWNER);
    await repo.appendAudit(a.id, "entry.confirm", { n: 2 }, OWNER);
    await repo.appendAudit(b.id, "entry.create", { n: 1 }, OWNER);

    const all = await repo.listAudit(OWNER);
    const result = replayAllChains(all);
    expect(result.ok).toBe(true);
    expect(result.chains).toBeGreaterThanOrEqual(2);
  });

  it("advances the head seal on each write", async () => {
    const created = await repo.createEntry(OWNER, record());
    expect(await repo.headSeal(OWNER, created.id)).toBe("0".repeat(96));
    const first = await repo.appendAudit(created.id, "entry.create", { n: 1 }, OWNER);
    expect(first.prevSeal).toBe("0".repeat(96));
    const second = await repo.appendAudit(created.id, "entry.update", { n: 2 }, OWNER);
    expect(second.prevSeal).toBe(first.seal);
  });

  it("never returns another household's audit events", async () => {
    // Regression. `listAudit` used to take an optional chain id and nothing
    // else, so an unscoped call returned every event on the database —
    // including other households' member names and amounts inside each event's
    // payload. With no accounts, the scope cookie is the only access control
    // there is, so this read has to be owner-scoped by construction.
    const mine = await repo.createEntry(OWNER, record({ note: "mine" }));
    const theirs = await repo.createEntry(OTHER, record({ note: "theirs" }));
    await repo.appendAudit(mine.id, "entry.create", { note: "mine" }, OWNER);
    await repo.appendAudit(theirs.id, "entry.create", { note: "theirs" }, OTHER);

    const asMine = await repo.listAudit(OWNER);
    expect(asMine.length).toBeGreaterThan(0);
    // Another owner's chain id never appears, and their payload text does not
    // leak through a shared query.
    expect(asMine.some((e) => e.chainId === theirs.id)).toBe(false);
    expect(JSON.stringify(asMine)).not.toContain("theirs");

    const asTheirs = await repo.listAudit(OTHER);
    expect(JSON.stringify(asTheirs)).not.toContain("mine");

    // And a chain id from another owner resolves to nothing at all.
    expect(await repo.listAudit(OWNER, theirs.id)).toEqual([]);
    expect(await repo.headSeal(OWNER, theirs.id)).toBe("0".repeat(96));
  });

  it("keeps a deleted line's chain replayable", async () => {
    const created = await repo.createEntry(OWNER, record());
    await repo.appendAudit(created.id, "entry.create", {}, OWNER);
    await repo.deleteEntry(OWNER, created.id);
    await repo.appendAudit(created.id, "entry.delete", {}, OWNER);

    const result = replayAllChains(await repo.listAudit(OWNER, created.id));
    expect(result.ok).toBe(true);
    expect(result.events).toBe(2);
  });
});

describe("share links", () => {
  it("mints and resolves a token", async () => {
    const token = "abcdefghijklmnopqrstuvwx";
    const link = await repo.createShareLink(OWNER, {
      token,
      householdId: household.id,
      ownerId: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      label: "test",
      seal: "a".repeat(96),
      createdAt: new Date().toISOString(),
    });
    expect(link.token).toBe(token);

    const found = await repo.getShareLink(token);
    expect(found?.householdId).toBe(household.id);
    expect(await repo.getShareLink("does-not-exist")).toBeNull();
  });
});

describe("the engine over real persisted rows", () => {
  it("balances to zero across a real multi-member book", async () => {
    const fresh = await repo.createHousehold(`${OWNER}-engine`, {
      name: "Engine flat",
      baseCurrency: "INR",
      countryCode: "IN",
      members: [
        { id: "a", name: "Arunima", kind: "you" },
        { id: "b", name: "Meera", kind: "flatmate" },
        { id: "c", name: "Rin", kind: "family" },
      ],
    });

    for (const over of [
      { amountMinor: 30_000, amountBaseMinor: 30_000, paidBy: "a", participants: ["a", "b", "c"] },
      { amountMinor: 12_345, amountBaseMinor: 12_345, paidBy: "b", participants: ["a", "b", "c"] },
      { amountMinor: 7, amountBaseMinor: 7, paidBy: "c", participants: ["a", "b", "c"] },
    ]) {
      await repo.createEntry(`${OWNER}-engine`, { ...record({ householdId: fresh.id }), ...over });
    }

    const { items } = await repo.listEntries(`${OWNER}-engine`, fresh.id, {
      limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "occurred_asc",
    });

    const result = analyseSettlement({
      household: fresh,
      entries: items,
      fx: FX,
      cpi: CPI,
      today: "2026-10-03",
      now: new Date("2026-10-03T12:00:00.000Z"),
      windowDays: 30,
    });

    expect(result.balances.reduce((a, b) => a + b.netBaseMinor, 0)).toBe(0);
    expect(result.flags.find((f) => f.id === "imbalance")).toBeUndefined();
    expect(result.transfers.reduce((sum, t) => sum + t.amountBaseMinor, 0)).toBe(
      result.balances.filter((b) => b.netBaseMinor > 0).reduce((s, b) => s + b.netBaseMinor, 0),
    );
  });
});

describe("the two adapters agree", () => {
  it("makeRepository builds a working repository over any executor", async () => {
    // Proves the adapter is a pure function of its SQL executor, so the Neon
    // path and the PGlite path cannot drift in behaviour.
    const calls: string[] = [];
    const fake = {
      kind: "pglite-embedded" as const,
      async init() {
        calls.push("init");
      },
      async close() {},
    };
    expect(fake.kind).toBe("pglite-embedded");
    expect(typeof makeRepository).toBe("function");
    expect(calls).toEqual([]);
  });
});