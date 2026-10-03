import { describe, expect, it } from "vitest";
import {
  ENGINE_VERSION,
  FACTOR_WEIGHTS,
  analyseSettlement,
  computeEntryShare,
  normaliseExactShares,
  planTransfers,
} from "@/lib/engine";
import { cpiYearOnYear, rateFor } from "@/lib/fx";
import type { BalanceRow, CpiSnapshot, FxSnapshot, Household, LedgerEntry } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const HOUSEHOLD: Household = {
  id: "h1",
  name: "Our flat",
  baseCurrency: "INR",
  countryCode: "IN",
  members: [
    { id: "me", name: "Arunima", kind: "you" },
    { id: "them", name: "Meera", kind: "flatmate" },
    { id: "third", name: "Rin", kind: "family" },
  ],
  ownerId: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const FX: FxSnapshot = {
  status: "live",
  base: "INR",
  asOf: "2026-10-02",
  fetchedAt: "2026-10-03T06:00:00.000Z",
  provider: "European Central Bank via Frankfurter",
  providerUrl: "https://api.frankfurter.app/latest?from=INR",
  attribution: "ECB via Frankfurter",
  rates: { INR: 1, USD: 0.01038, EUR: 0.00925 },
  supported: ["INR", "USD", "EUR"],
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
  series: [
    { year: 2025, value: 233.063 },
    { year: 2024, value: 227.603 },
  ],
};

let seq = 0;

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  const amountMinor = over.amountMinor ?? 100_00;
  return {
    id: over.id ?? `e${seq}`,
    householdId: "h1",
    occurredOn: "2026-10-02",
    direction: "outflow",
    amountMinor,
    currency: "INR",
    fxRateToBase: 1,
    amountBaseMinor: over.amountBaseMinor ?? amountMinor,
    paidBy: "me",
    category: "groceries",
    note: "",
    rawText: "paid something",
    evidence: "paste",
    parseEngine: "deterministic",
    parseConfidence: 0.9,
    splitMode: "equal",
    participants: ["me", "them"],
    exactShares: null,
    status: "confirmed",
    receiptRef: null,
    idempotencyKey: null,
    deleted: false,
    createdAt: "2026-10-02T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

function run(entries: LedgerEntry[], today = "2026-10-03", windowDays = 30) {
  return analyseSettlement({
    household: HOUSEHOLD,
    entries,
    fx: FX,
    cpi: CPI,
    today,
    now: new Date(`${today}T12:00:00.000Z`),
    windowDays,
  });
}

/* -------------------------------------------------------------------------- */
/* Transfer planning                                                           */
/* -------------------------------------------------------------------------- */

function balances(net: Array<[string, number]>): BalanceRow[] {
  return net.map(([memberId, netBaseMinor]) => ({
    memberId,
    name: memberId,
    paidBaseMinor: 0,
    shareBaseMinor: 0,
    netBaseMinor,
  }));
}

describe("minimum transfer plan", () => {
  it("settles a two-sided balance with one transfer", () => {
    const plan = planTransfers(balances([["a", 500], ["b", -500]]));
    expect(plan.transfers).toEqual([{ fromMemberId: "b", toMemberId: "a", amountBaseMinor: 500 }]);
    expect(plan.minimal).toBe(true);
  });

  it("collapses three members onto the one that is owed, in two transfers", () => {
    const plan = planTransfers(balances([["a", 300], ["b", -200], ["c", -100]]));
    expect(plan.transfers).toHaveLength(2);
    expect(plan.transfers.reduce((sum, t) => sum + t.amountBaseMinor, 0)).toBe(300);
    expect(plan.bound).toBe(2);
    expect(plan.minimal).toBe(true);
  });

  it("uses exactly n - 1 transfers for n non-zero balances", () => {
    const nets: Array<[string, number]> = [["a", 400], ["b", 250], ["c", -300], ["d", -350]];
    const plan = planTransfers(balances(nets));
    expect(plan.transfers).toHaveLength(plan.bound);
    expect(plan.minimal).toBe(true);
  });

  it("moves every unit, leaving nothing stranded", () => {
    const nets: Array<[string, number]> = [["a", 1], ["b", 1], ["c", 1], ["d", -1], ["e", -1], ["f", -1]];
    const plan = planTransfers(balances(nets));
    const totalPositive = nets.filter(([, n]) => n > 0).reduce((s, [, n]) => s + n, 0);
    expect(plan.transfers.reduce((s, t) => s + t.amountBaseMinor, 0)).toBe(totalPositive);
  });

  it("does nothing when everyone is square", () => {
    expect(planTransfers(balances([["a", 0], ["b", 0]])).transfers).toEqual([]);
  });

  it("ignores zero balances when counting the bound", () => {
    const plan = planTransfers(balances([["a", 100], ["b", -100], ["c", 0]]));
    expect(plan.nonZeroBalances).toBe(2);
    expect(plan.bound).toBe(1);
  });

  it("is deterministic: ties break on member id, not on input order", () => {
    const one = planTransfers(balances([["zoe", 100], ["adam", 100], ["mia", -200]]));
    const two = planTransfers(balances([["mia", -200], ["adam", 100], ["zoe", 100]]));
    expect(JSON.stringify(one.transfers)).toBe(JSON.stringify(two.transfers));
  });
});

/* -------------------------------------------------------------------------- */
/* Splits                                                                      */
/* -------------------------------------------------------------------------- */

describe("computeEntryShare", () => {
  it("splits equally and the parts sum to the amount", () => {
    const share = computeEntryShare(entry({ amountBaseMinor: 10_000, participants: ["me", "them", "third"] }));
    expect(Object.values(share.shares).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(share.total).toBe(10_000);
  });

  it("uses an exact split when it adds up", () => {
    const share = computeEntryShare(
      entry({ amountBaseMinor: 1000, splitMode: "exact", exactShares: { me: 700, them: 300 } }),
    );
    expect(share.shares).toEqual({ me: 700, them: 300 });
  });

  it("repairs an exact split that no longer adds up", () => {
    const share = computeEntryShare(
      entry({ amountBaseMinor: 1000, splitMode: "exact", exactShares: { me: 500, them: 200 } }),
    );
    expect(Object.values(share.shares).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("returns nothing for a line with no participants", () => {
    expect(computeEntryShare(entry({ participants: [] }))).toEqual({ shares: {}, total: 0 });
  });
});

describe("normaliseExactShares", () => {
  it("leaves an already-correct split untouched", () => {
    expect(normaliseExactShares(1000, { me: 700, them: 300 })).toEqual({ me: 700, them: 300 });
  });

  it("trims the largest share until the total fits", () => {
    expect(normaliseExactShares(1000, { me: 900, them: 900 })).toEqual({ me: 500, them: 500 });
  });

  it("drops shares that end up at zero", () => {
    const result = normaliseExactShares(100, { a: 100, b: 0 });
    expect(Object.keys(result)).toEqual(["a"]);
  });

  it("is deterministic for identical requests", () => {
    const request = { zoe: 3, adam: 3, mia: 3 };
    expect(normaliseExactShares(10, request)).toEqual(normaliseExactShares(10, request));
  });

  it("handles an empty request", () => {
    expect(normaliseExactShares(1000, {})).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

describe("analyseSettlement", () => {
  it("returns an honest empty result rather than pretending", () => {
    const result = run([]);
    expect(result.totals.entryCount).toBe(0);
    expect(result.verdict).toBe("review");
    expect(result.headline).toMatch(/nothing recorded/i);
    expect(result.transfers).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("balances to exactly zero across members", () => {
    const result = run([
      entry({ amountBaseMinor: 10_000, paidBy: "me", participants: ["me", "them"] }),
      entry({ amountBaseMinor: 5_000, paidBy: "them", participants: ["me", "them"] }),
    ]);
    expect(result.balances.reduce((a, b) => a + b.netBaseMinor, 0)).toBe(0);
    expect(result.flags.find((f) => f.id === "imbalance")).toBeUndefined();
  });

  it("works out who paid what for a two-way split", () => {
    // Meera pays 1000 for both. Arunima owes 500.
    const result = run([
      entry({ amountBaseMinor: 10_000, paidBy: "them", participants: ["me", "them"], rawText: "" }),
    ]);
    const me = result.balances.find((b) => b.memberId === "me");
    const them = result.balances.find((b) => b.memberId === "them");
    expect(me!.netBaseMinor).toBe(-5000);
    expect(them!.netBaseMinor).toBe(5000);
    expect(result.transfers).toEqual([{ fromMemberId: "me", toMemberId: "them", amountBaseMinor: 5000 }]);
  });

  it("credits an inflow to its payer and shares it the same way", () => {
    const result = run([
      entry({ amountBaseMinor: 10_000, direction: "inflow", paidBy: "me", participants: ["me", "them"] }),
    ]);
    expect(result.totals.inflowBaseMinor).toBe(10_000);
    expect(result.totals.outflowBaseMinor).toBe(0);
    expect(result.balances.reduce((a, b) => a + b.netBaseMinor, 0)).toBe(0);
  });

  it("has weights that sum to exactly one, so the score means something", () => {
    const total = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("scores the sum of its own factors", () => {
    const result = run([entry({ amountBaseMinor: 1000, rawText: "the message", status: "confirmed" })]);
    const sum = result.factors.reduce((a, f) => a + f.contribution, 0);
    expect(result.score).toBe(Math.round(100 * sum));
  });

  it("keeps every factor's contribution inside its weight", () => {
    const result = run([
      entry({ amountBaseMinor: 1000, status: "disputed", rawText: "" }),
      entry({ amountBaseMinor: 2000, status: "draft", rawText: "kept" }),
    ]);
    for (const factor of result.factors) {
      expect(factor.normalized).toBeGreaterThanOrEqual(0);
      expect(factor.normalized).toBeLessThanOrEqual(1);
      expect(factor.contribution).toBeLessThanOrEqual(factor.weight + 1e-9);
    }
  });

  it("penalises a line with no message and no receipt", () => {
    const withEvidence = run([entry({ rawText: "the original message" })]);
    const without = run([entry({ rawText: "" })]);
    expect(without.score).toBeLessThan(withEvidence.score);
    expect(without.flags.some((f) => f.id === "missing-evidence")).toBe(true);
  });

  it("counts repeated problems once and says how many", () => {
    const result = run([
      entry({ status: "disputed" }),
      entry({ status: "disputed" }),
      entry({ status: "disputed" }),
    ]);
    const flag = result.flags.find((f) => f.id === "disputed");
    expect(flag).toBeDefined();
    expect(flag!.message).toMatch(/3 lines/);
    expect(result.flags.filter((f) => f.id === "disputed")).toHaveLength(1);
  });

  it("flags a line with no payer", () => {
    const result = run([entry({ paidBy: null })]);
    expect(result.flags.some((f) => f.id === "no-payer")).toBe(true);
  });

  it("flags a line paid by someone who is not in the household", () => {
    const result = run([entry({ paidBy: "stranger" })]);
    expect(result.flags.some((f) => f.id === "unknown-payer")).toBe(true);
  });

  it("flags a foreign line whose captured rate has drifted", () => {
    // base INR, USD published at 0.01038 per INR, so 96.32 INR per USD.
    const result = run([
      entry({ currency: "USD", amountMinor: 10_000, fxRateToBase: 120, amountBaseMinor: 1_200_000 }),
    ]);
    expect(result.flags.some((f) => f.id === "rate-drift")).toBe(true);
    expect(result.factors.find((f) => f.id === "fxDiscipline")!.normalized).toBeLessThan(1);
  });

  it("gives full marks for a foreign line converted at today's rate", () => {
    // USD 100 at 96.32 INR per USD is 9632 INR = 963200 paise.
    const result = run([
      entry({ currency: "USD", amountMinor: 10_000, fxRateToBase: 96.32, amountBaseMinor: 963_200 }),
    ]);
    expect(result.flags.some((f) => f.id === "rate-drift")).toBe(false);
    expect(result.factors.find((f) => f.id === "fxDiscipline")!.normalized).toBe(1);
  });

  it("excludes lines outside the window", () => {
    const result = run([entry({ occurredOn: "2025-01-01", amountBaseMinor: 999_999 })], "2026-10-03", 30);
    expect(result.totals.entryCount).toBe(0);
  });

  it("excludes a deleted line", () => {
    const result = run([entry({ deleted: true })]);
    expect(result.totals.entryCount).toBe(0);
  });

  it("warns when the exchange rates are not live", () => {
    const result = analyseSettlement({
      household: HOUSEHOLD,
      entries: [entry()],
      fx: { ...FX, status: "fallback" },
      cpi: CPI,
      today: "2026-10-03",
      now: new Date("2026-10-03T12:00:00.000Z"),
      windowDays: 30,
    });
    const flag = result.flags.find((f) => f.id === "fx-not-live");
    expect(flag).toBeDefined();
    expect(flag!.message).toMatch(/sealed sample/i);
  });

  it("warns when nothing has been logged for a while", () => {
    const result = run([entry({ occurredOn: "2026-09-01" })], "2026-10-03", 90);
    expect(result.flags.some((f) => f.id === "stale-book")).toBe(true);
  });

  it("reports a single-member household as having nothing to settle", () => {
    const solo: Household = { ...HOUSEHOLD, members: [HOUSEHOLD.members[0]!] };
    const result = analyseSettlement({
      household: solo,
      entries: [entry({ participants: ["me"] })],
      fx: FX,
      cpi: CPI,
      today: "2026-10-03",
      now: new Date("2026-10-03T12:00:00.000Z"),
      windowDays: 30,
    });
    expect(result.flags.some((f) => f.id === "single-member")).toBe(true);
    expect(result.transfers).toEqual([]);
  });

  it("is deterministic for the same inputs", () => {
    const entries = [entry({ amountBaseMinor: 1000 }), entry({ amountBaseMinor: 2500, paidBy: "them" })];
    const a = JSON.stringify(run(entries).balances);
    const b = JSON.stringify(run(entries).balances);
    expect(a).toBe(b);
  });

  it("states its own version so a stored result can be interpreted later", () => {
    expect(run([]).version).toBe(ENGINE_VERSION);
  });

  it("carries the household seal through when one is supplied", () => {
    const result = analyseSettlement({
      household: HOUSEHOLD,
      entries: [],
      fx: FX,
      cpi: CPI,
      today: "2026-10-03",
      now: new Date("2026-10-03T12:00:00.000Z"),
      windowDays: 30,
      seal: "a".repeat(96),
    });
    expect(result.seal).toBe("a".repeat(96));
  });

  it("survives a household with no members at all", () => {
    const result = analyseSettlement({
      household: { ...HOUSEHOLD, members: [] },
      entries: [entry()],
      fx: FX,
      cpi: null,
      today: "2026-10-03",
      now: new Date("2026-10-03T12:00:00.000Z"),
      windowDays: 30,
    });
    expect(result.balances).toEqual([]);
    expect(result.transfers).toEqual([]);
    expect(result.flags.some((f) => f.id === "unknown-participant")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Feed helpers                                                                */
/* -------------------------------------------------------------------------- */

describe("rateFor", () => {
  it("returns 1 when the currency is the base", () => {
    expect(rateFor(FX, "INR")).toBe(1);
    expect(rateFor(FX, "inr")).toBe(1);
  });

  it("inverts the published rate into base-per-entry", () => {
    // FX.base is INR and FX.rates.USD is 0.01038 USD per INR, so a USD line
    // needs 96.32 INR per USD to convert.
    expect(rateFor(FX, "USD")).toBeCloseTo(1 / 0.01038, 6);
  });

  it("returns null rather than inventing a rate", () => {
    expect(rateFor(FX, "AED")).toBeNull();
  });

  it("rejects a nonsensical published rate instead of dividing by it", () => {
    expect(rateFor({ ...FX, rates: { ...FX.rates, USD: 0 } }, "USD")).toBeNull();
    expect(rateFor({ ...FX, rates: { ...FX.rates, USD: -1 } }, "USD")).toBeNull();
  });
});

describe("cpiYearOnYear", () => {
  it("computes the year-on-year change", () => {
    expect(cpiYearOnYear(CPI)).toBeCloseTo((233.063 - 227.603) / 227.603, 6);
  });

  it("returns null when there is no prior year", () => {
    expect(cpiYearOnYear({ ...CPI, series: [{ year: 2025, value: 100 }] })).toBeNull();
  });

  it("returns null for an empty series rather than dividing by zero", () => {
    expect(cpiYearOnYear({ ...CPI, series: [] })).toBeNull();
  });
});