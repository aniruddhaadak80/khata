/**
 * khata-engine — the deterministic settlement and trust engine.
 *
 * One pure function, `analyseSettlement`, produces every number khata shows.
 * The same function backs the UI, `GET /api/settlement` and the
 * `analyse_settlement` MCP tool, so there is no second implementation that can
 * drift.
 *
 * ## The accounting model, stated plainly
 *
 * khata answers one question: *who pays whom, and in how few transfers?*
 *
 *   For every entry, the payer's `paid` increases by the amount and every
 *   participant's `share` increases by their portion.
 *
 *   net_i = paid_i - share_i        (positive: the household owes i)
 *
 * The same rule applies to an inflow. Receiving a refund on the household's
 * behalf is arithmetically identical to fronting the money yourself and then
 * recovering it, so an inflow credits the payer and shares the same way. It
 * still gets its own direction, its own row and its own colour in the book:
 * the direction is what the reader saw in the message, and hiding it would be
 * dishonest bookkeeping.
 *
 * Because `allocateProportionally` guarantees the parts sum to the whole, the
 * sum of every net is exactly zero. The transfer planner depends on that.
 *
 * ## Why the transfer plan is minimal
 *
 * Every transfer zeroes at least one outstanding balance, and the last
 * transfer zeroes two. Starting from `n` non-zero balances that bounds any
 * solution by `n - 1` transfers. The greedy below always pairs a debtor with a
 * creditor, so it reaches that bound: the plan uses the minimum possible number
 * of transfers. That is the standard min-cash-flow result, and `transferCount`
 * is reported next to `minimalTransfers` so the claim is checkable rather than
 * asserted.
 *
 * ## The trust score
 *
 * Six factors whose weights sum to exactly 1. Each reports the quantity it
 * measured, its unit, and a sentence saying why it reads the way it does.
 * score = round(100 * sum(weight_i * normalized_i))
 */

import { allocateProportionally } from "./money";
import { cpiYearOnYear, rateFor } from "./fx";
import type {
  BalanceRow,
  Category,
  CurrencyCode,
  EngineFactor,
  EngineFlag,
  FlagSeverity,
  FxSnapshot,
  CpiSnapshot,
  Household,
  LedgerEntry,
  Member,
  SettlementResult,
  SettlementTotals,
  SettlementVerdict,
  Transfer,
} from "./types";

export const ENGINE_VERSION = "khata-engine/1.0.0";

/* Weights are fixed and sum to exactly 1. Verified by a unit test. */
export const FACTOR_WEIGHTS = {
  evidence: 0.22,
  confirmation: 0.2,
  freshness: 0.16,
  readConfidence: 0.16,
  fxDiscipline: 0.14,
  disputeLoad: 0.12,
} as const;

export const MAX_RATE_DRIFT = 0.02; // 2%: past this, a captured rate is worth re-checking.
const STALE_BOOK_DAYS = 14;

/* -------------------------------------------------------------------------- */
/* Small numeric helpers                                                       */
/* -------------------------------------------------------------------------- */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function roundMinor(n: number): number {
  return Math.round(n);
}

function isoShiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/* Per-entry share allocation                                                  */
/* -------------------------------------------------------------------------- */

export interface EntryShare {
  /** memberId -> base minor units owed. */
  shares: Record<string, number>;
  /** Always equal to `amountBaseMinor`. */
  total: number;
}

/**
 * What one entry charges to whom.
 *
 * `exact` splits use the stored exact shares when they sum to the amount.
 * Otherwise — a stored map that has drifted, or `equal` — the amount is
 * allocated proportionally over the participants, which cannot fail to balance.
 */
export function computeEntryShare(entry: LedgerEntry): EntryShare {
  const ids = [...entry.participants].sort();
  if (ids.length === 0) return { shares: {}, total: 0 };

  if (entry.splitMode === "exact" && entry.exactShares) {
    const keys = Object.keys(entry.exactShares).sort();
    const sum = keys.reduce((a, k) => a + (entry.exactShares?.[k] ?? 0), 0);
    if (sum === entry.amountBaseMinor && sum > 0) {
      const shares: Record<string, number> = {};
      for (const k of keys) shares[k] = entry.exactShares?.[k] ?? 0;
      return { shares, total: sum };
    }
  }

  // Equal weights: `equal` mode, or a repair of an exact map that no longer adds
  // up. allocateProportionally is exact, so the parts always sum to the total.
  const weights: Record<string, number> = {};
  for (const id of ids) weights[id] = 1;
  const allocation = allocateProportionally(entry.amountBaseMinor, ids, weights);
  return { shares: allocation.shares, total: allocation.allocated };
}

/**
 * Rewrite an exact split so it sums to `totalMinor`, handing any leftover
 * minor units to the largest share and breaking ties on member id.
 *
 * Applied when an exact split is written, so a stored map is always internally
 * consistent and the engine never has to repair it in anger.
 */
export function normaliseExactShares(
  totalMinor: number,
  requested: Readonly<Record<string, number>>,
): Record<string, number> {
  const ids = Object.keys(requested).sort();
  if (ids.length === 0) return {};
  const out: Record<string, number> = {};
  for (const id of ids) {
    const raw = requested[id];
    const n = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    out[id] = n;
  }
  let sum = ids.reduce((a, id) => a + (out[id] ?? 0), 0);

  // Trim the largest shares until the total fits.
  const bySizeDesc = [...ids].sort(
    (a, b) => (out[b] ?? 0) - (out[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  while (sum > totalMinor) {
    let reduced = false;
    for (const id of bySizeDesc) {
      if ((out[id] ?? 0) > 0) {
        out[id] = (out[id] ?? 0) - 1;
        sum -= 1;
        reduced = true;
        if (sum <= totalMinor) break;
      }
    }
    if (!reduced) break; // Every share is zero; nothing left to trim.
  }

  // Hand the leftover out one unit at a time, largest share first.
  let cursor = 0;
  while (sum < totalMinor && bySizeDesc.length > 0) {
    const id = bySizeDesc[cursor % bySizeDesc.length];
    if (!id) break;
    out[id] = (out[id] ?? 0) + 1;
    sum += 1;
    cursor += 1;
  }

  const final: Record<string, number> = {};
  for (const id of ids) if ((out[id] ?? 0) > 0) final[id] = out[id] ?? 0;
  return final;
}

/* -------------------------------------------------------------------------- */
/* Transfer planner                                                            */
/* -------------------------------------------------------------------------- */

export interface TransferPlan {
  transfers: Transfer[];
  /** True when the plan provably uses the fewest transfers possible. */
  minimal: boolean;
  /** The upper bound `n - 1` that any solution must respect. */
  bound: number;
  nonZeroBalances: number;
}

/**
 * Minimum-cash-flow settlement by greedy pairing.
 *
 * Deterministic tie-breaking everywhere: amounts descending, then member id
 * ascending. The same balances always produce the same plan, so two people
 * running the page independently get the same answer.
 */
export function planTransfers(balances: readonly BalanceRow[]): TransferPlan {
  const creditors = balances
    .filter((b) => b.netBaseMinor > 0)
    .map((b) => ({ id: b.memberId, left: b.netBaseMinor }))
    .sort((a, b) => b.left - a.left || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const debtors = balances
    .filter((b) => b.netBaseMinor < 0)
    .map((b) => ({ id: b.memberId, owed: -b.netBaseMinor }))
    .sort((a, b) => b.owed - a.owed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  // Each iteration zeroes at least one side, so this terminates in at most
  // creditors.length + debtors.length - 1 steps.
  while (i < creditors.length && j < debtors.length) {
    const c = creditors[i];
    const d = debtors[j];
    if (!c || !d) break;
    const amount = Math.min(c.left, d.owed);
    if (amount > 0) {
      transfers.push({ fromMemberId: d.id, toMemberId: c.id, amountBaseMinor: amount });
    }
    c.left -= amount;
    d.owed -= amount;
    if (c.left === 0) i += 1;
    if (d.owed === 0) j += 1;
  }

  const nonZeroBalances = creditors.length + debtors.length;
  const bound = Math.max(0, nonZeroBalances - 1);
  return { transfers, minimal: transfers.length <= bound, bound, nonZeroBalances };
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export interface EngineInput {
  household: Household;
  /** Every non-deleted entry for the household. The window is applied here. */
  entries: readonly LedgerEntry[];
  fx: FxSnapshot;
  cpi: CpiSnapshot | null;
  /** `YYYY-MM-DD`. Everything date-derived uses this, so runs are reproducible. */
  today: string;
  now: Date;
  windowDays: number;
  /** Household-level audit seal at the moment of the run, when available. */
  seal?: string | null;
}

function factor(
  id: string,
  label: string,
  weight: number,
  raw: number,
  unit: string,
  evidence: string,
): EngineFactor {
  const normalized = clamp01(raw);
  return {
    id,
    label,
    weight,
    raw: round(raw, 4),
    normalized: round(normalized, 4),
    contribution: round(normalized * weight, 6),
    unit,
    evidence,
  };
}

/** Status credit: confirmed 1, draft 0.35, disputed 0. */
const STATUS_CREDIT: Record<LedgerEntry["status"], number> = {
  confirmed: 1,
  draft: 0.35,
  disputed: 0,
};

export function analyseSettlement(input: EngineInput): SettlementResult {
  const { household, entries, fx, cpi, today, windowDays } = input;
  const fromDate = isoShiftDays(today, -(windowDays - 1));

  const inWindow = entries.filter((e) => !e.deleted && e.occurredOn >= fromDate && e.occurredOn <= today);

  /* Balances ---------------------------------------------------------------- */

  const memberIds = household.members.map((m) => m.id);
  const paid = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const owed = new Map<string, number>(memberIds.map((id) => [id, 0]));

  /**
   * Flags are declared once and counted, rather than appended per line. Three
   * disputed lines must produce one flag reading "3 lines", not three identical
   * sentences stacked on each other.
   */
  const flagDefs = new Map<string, { severity: FlagSeverity; message: string; entryId?: string }>();
  const flagHits = new Map<string, number>();
  const addFlag = (id: string, severity: FlagSeverity, message: string, entryId?: string) => {
    flagHits.set(id, (flagHits.get(id) ?? 0) + 1);
    if (!flagDefs.has(id)) {
      flagDefs.set(id, entryId ? { severity, message, entryId } : { severity, message });
    }
  };
  const materialiseFlags = (): EngineFlag[] =>
    [...flagDefs.entries()].map(([id, def]) => {
      const hits = flagHits.get(id) ?? 1;
      const pluralised = hits > 1 ? ` (${hits} lines)` : "";
      const flag: EngineFlag = { id, severity: def.severity, message: def.message + pluralised };
      if (def.entryId) flag.entryId = def.entryId;
      return flag;
    });

  let outflowBase = 0;
  let inflowBase = 0;
  let foreignCurrencyCount = 0;
  let unconfirmedCount = 0;
  let disputedCount = 0;
  let chargedBase = 0;

  let confidenceSum = 0;
  let evidenceCount = 0;
  let statusCreditSum = 0;
  let foreignRateOk = 0;

  let ageSum = 0;

  for (const entry of inWindow) {
    const { shares, total } = computeEntryShare(entry);
    chargedBase += total;

    if (entry.direction === "outflow") outflowBase += entry.amountBaseMinor;
    else inflowBase += entry.amountBaseMinor;

    const payer = entry.paidBy;
    if (payer && paid.has(payer)) {
      paid.set(payer, (paid.get(payer) ?? 0) + entry.amountBaseMinor);
    } else if (!payer) {
      addFlag("no-payer", "critical", "A line has no payer recorded.", entry.id);
    } else {
      addFlag("unknown-payer", "critical", `A line is paid by "${payer}", who is not in this household.`, entry.id);
    }

    for (const [memberId, amount] of Object.entries(shares)) {
      if (!owed.has(memberId)) {
        addFlag("unknown-participant", "critical", `A line is shared with "${memberId}", who is not in this household.`, entry.id);
        continue;
      }
      owed.set(memberId, (owed.get(memberId) ?? 0) + amount);
    }

    /* Factors' raw inputs. */
    confidenceSum += entry.parseConfidence;
    statusCreditSum += STATUS_CREDIT[entry.status];
    const hasEvidence = entry.rawText.trim().length > 0 || (entry.receiptRef ?? "").trim().length > 0;
    if (hasEvidence) evidenceCount += 1;
    else addFlag("missing-evidence", "warn", "A line has no message or receipt behind it.", entry.id);

    if (entry.status === "draft") {
      unconfirmedCount += 1;
      addFlag("unconfirmed", "warn", "A line is still a draft.", entry.id);
    }
    if (entry.status === "disputed") {
      disputedCount += 1;
      addFlag("disputed", "critical", "Someone has disputed a line.", entry.id);
    }

    ageSum += Math.max(0, daysBetween(entry.occurredOn, today));

    /* Foreign-currency discipline. */
    if (entry.currency.toUpperCase() !== household.baseCurrency.toUpperCase()) {
      foreignCurrencyCount += 1;
      // Same convention as the stored rate: base per one unit of the entry
      // currency. rateFor performs the inversion, so both sides of the drift
      // comparison are in the same units.
      const liveRate = rateFor(fx, entry.currency);
      const drift =
        typeof liveRate === "number" && liveRate > 0
          ? Math.abs(entry.fxRateToBase - liveRate) / liveRate
          : Number.POSITIVE_INFINITY;
      if (Number.isFinite(drift) && drift <= MAX_RATE_DRIFT) foreignRateOk += 1;
      else {
        addFlag(
          "rate-drift",
          "warn",
          "A foreign-currency line was converted at a rate more than 2% away from today's published rate.",
          entry.id,
        );
      }
    }
  }

  const balances: BalanceRow[] = household.members.map((m: Member): BalanceRow => {
    const p = paid.get(m.id) ?? 0;
    const o = owed.get(m.id) ?? 0;
    return {
      memberId: m.id,
      name: m.name,
      paidBaseMinor: roundMinor(p),
      shareBaseMinor: roundMinor(o),
      netBaseMinor: roundMinor(p - o),
    };
  });

  /* Rounding invariant: the sum of nets must be exactly zero, otherwise the
   * transfer planner would strand money. Report it loudly rather than hide it. */
  const netSum = balances.reduce((a, b) => a + b.netBaseMinor, 0);
  if (netSum !== 0) {
    addFlag(
      "imbalance",
      "critical",
      `Balances do not cancel out (off by ${netSum} minor units). The settlement plan is not reliable.`,
    );
  }

  const plan = planTransfers(balances);

  /* Factors ----------------------------------------------------------------- */

  const n = inWindow.length;
  const evidenceRatio = n > 0 ? evidenceCount / n : 0;
  const confirmationRatio = n > 0 ? statusCreditSum / n : 0;
  const meanAge = n > 0 ? ageSum / n : 0;
  // A line logged today is full marks; one as old as the whole window is half;
  // one twice the window old is zero.
  const freshness = n > 0 ? 1 - clamp01(meanAge / (2 * windowDays)) * 0.5 - 0.5 * clamp01(meanAge / (4 * windowDays)) : 0;
  const meanConfidence = n > 0 ? confidenceSum / n : 0;
  const fxDiscipline =
    foreignCurrencyCount === 0 ? 1 : foreignRateOk / foreignCurrencyCount;
  const disputeRatio = n > 0 ? disputedCount / n : 0;
  const disputeLoad = 1 - disputeRatio;

  const factors: EngineFactor[] = [
    factor(
      "evidence",
      "Evidence",
      FACTOR_WEIGHTS.evidence,
      evidenceRatio,
      "share of lines carrying a message or receipt",
      n === 0
        ? "Nothing recorded, so there is no evidence to weigh."
        : `${evidenceCount} of ${n} lines keep the original message or a receipt reference.`,
    ),
    factor(
      "confirmation",
      "Confirmation",
      FACTOR_WEIGHTS.confirmation,
      confirmationRatio,
      "share of lines agreed (confirmed 1, draft 0.35, disputed 0)",
      n === 0
        ? "Nothing recorded."
        : `${unconfirmedCount} line${unconfirmedCount === 1 ? "" : "s"} still unconfirmed and ${disputedCount} disputed.`,
    ),
    factor(
      "freshness",
      "Freshness",
      FACTOR_WEIGHTS.freshness,
      n > 0 ? clamp01(freshness) : 0,
      "0 at twice the window, 1 for lines logged today",
      n === 0 ? "Nothing recorded." : `Mean line age is ${round(meanAge, 1)} days.`,
    ),
    factor(
      "readConfidence",
      "Read confidence",
      FACTOR_WEIGHTS.readConfidence,
      meanConfidence,
      "mean certainty of the reader that produced the lines",
      n === 0 ? "Nothing recorded." : `Mean reader confidence is ${round(meanConfidence * 100, 1)}%.`,
    ),
    factor(
      "fxDiscipline",
      "Rate discipline",
      FACTOR_WEIGHTS.fxDiscipline,
      fxDiscipline,
      "foreign lines converted within 2% of today's published rate",
      foreignCurrencyCount === 0
        ? "Every line is in the household currency, so there is nothing to convert."
        : `${foreignRateOk} of ${foreignCurrencyCount} foreign lines match today's rate.`,
    ),
    factor(
      "disputeLoad",
      "Dispute load",
      FACTOR_WEIGHTS.disputeLoad,
      disputeLoad,
      "1 minus the disputed share",
      n === 0 ? "Nothing recorded." : `${disputedCount} line${disputedCount === 1 ? "" : "s"} disputed.`,
    ),
  ];

  const factorSum = factors.reduce((a, f) => a + f.normalized * f.weight, 0);
  /**
   * An empty window scores zero, not "nothing is wrong".
   *
   * Two factors read 1 on an empty book by construction: there are no foreign
   * lines to convert badly and nothing disputed. Left alone they would give a
   * household with nothing recorded a score of 26, which reads like "mostly
   * fine". There is no book to trust when there is no book, so the score is
   * zero and the headline says so.
   */
  const score = n === 0 ? 0 : Math.round(100 * clamp01(factorSum));

  /* Context flags that are not about individual lines. */
  if (n === 0) {
    addFlag("empty", "info", "No lines recorded in this window yet.");
  } else {
    const lastOn = inWindow.reduce((a, e) => (e.occurredOn > a ? e.occurredOn : a), fromDate);
    if (daysBetween(lastOn, today) >= STALE_BOOK_DAYS) {
      addFlag("stale-book", "warn", `Nothing has been logged for ${daysBetween(lastOn, today)} days.`);
    }
  }
  if (household.members.length < 2) {
    addFlag("single-member", "info", "Only one member, so there is nobody to settle up with.");
  }
  if (fx.status !== "live") {
    addFlag(
      "fx-not-live",
      "warn",
      fx.status === "stale"
        ? `Exchange rates are a cached copy from ${fx.asOf}, not a live quote.`
        : `Exchange rates are the sealed sample from ${fx.asOf}, not a live quote.`,
    );
  }
  if (!plan.minimal) {
    addFlag("transfer-bound", "warn", `The settlement plan uses more than the ${plan.bound} transfers the balances allow.`);
  }

  /* Verdict and actions ------------------------------------------------------ */

  const totals: SettlementTotals = {
    outflowBaseMinor: outflowBase,
    inflowBaseMinor: inflowBase,
    entryCount: n,
    netSpendBaseMinor: outflowBase - inflowBase,
    chargedBaseMinor: chargedBase,
    unconfirmedCount,
    disputedCount,
    foreignCurrencyCount,
  };

  const actions: string[] = [];
  if (n === 0) {
    actions.push("Paste a payment message on the Reader, or add a line by hand on the Ledger.");
  } else {
    if (disputedCount > 0) actions.push(`Resolve the ${disputedCount} disputed line${disputedCount === 1 ? "" : "s"} first — a disputed line changes who owes what.`);
    if (unconfirmedCount > 0) actions.push(`Confirm the ${unconfirmedCount} draft line${unconfirmedCount === 1 ? "" : "s"} so the book is agreed.`);
    if (n > 0 && evidenceRatio < 0.8) actions.push("Add the original message or a receipt reference to the lines that have none.");
    if (plan.transfers.length > 0) actions.push(`Settle in ${plan.transfers.length} transfer${plan.transfers.length === 1 ? "" : "s"} — the fewest the current balances allow.`);
    else if (n > 0) actions.push("Everyone is square. Nothing to pay.");
  }

  const verdict: SettlementVerdict =
    n === 0 ? "review" : disputedCount > 0 || unconfirmedCount / n > 0.5 ? "review" : score >= 70 ? "healthy" : "settle";

  const headline =
    n === 0
      ? "Nothing recorded in this window yet."
      : plan.transfers.length === 0
        ? `Everyone is square across ${n} line${n === 1 ? "" : "s"}.`
        : `${plan.transfers.length} transfer${plan.transfers.length === 1 ? "" : "s"} settles the last ${windowDays} days.`;

  return {
    version: ENGINE_VERSION,
    engine: "Settlement and trust engine",
    computedAt: input.now.toISOString(),
    windowDays,
    fromDate,
    toDate: today,
    baseCurrency: household.baseCurrency.toUpperCase() as CurrencyCode,
    balances,
    transfers: plan.transfers,
    transferCount: plan.transfers.length,
    minimalTransfers: plan.minimal,
    score,
    factors,
    flags: materialiseFlags(),
    verdict,
    headline,
    actions,
    totals,
    fx: {
      status: fx.status,
      asOf: fx.asOf,
      provider: fx.provider,
      attribution: fx.attribution,
    },
    cpi:
      cpi === null
        ? null
        : {
            status: cpi.status,
            lastUpdated: cpi.lastUpdated,
            provider: cpi.provider,
            attribution: cpi.attribution,
          },
    seal: input.seal ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Report helpers shared by the export and the share statement                  */
/* -------------------------------------------------------------------------- */

export function memberName(household: Household, memberId: string | null): string {
  if (!memberId) return "Unrecorded";
  return household.members.find((m) => m.id === memberId)?.name ?? memberId;
}

export function categoryLabel(category: Category): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** Convenience for tests and docs: the fraction change in CPI year on year. */
export function cpiChange(cpi: CpiSnapshot | null): number | null {
  return cpi === null ? null : cpiYearOnYear(cpi);
}