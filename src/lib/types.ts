/**
 * Domain types for khata.
 *
 * Two kinds of types live here:
 *   1. The ledger domain (Household, LedgerEntry, settlement results).
 *   2. Normalised shapes for the two external sources khata reads.
 *
 * Every external shape is normalised into a khata type before it reaches the
 * engine or the UI, so a change upstream cannot silently alter behaviour. Each
 * normalised payload carries `status`, `fetchedAt` and `attribution` so the
 * interface can label live data as live and fallback data as fallback.
 */

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                           */
/* -------------------------------------------------------------------------- */

/** ISO 4217 alphabetic code, validated at the boundary. */
export type CurrencyCode = string;

/** Money left the household, or came into it. */
export type Direction = "outflow" | "inflow";

/** Where a settled question currently sits. */
export type EntryStatus = "draft" | "confirmed" | "disputed";

/** How an entry's cost is divided between the household members. */
export type SplitMode = "equal" | "exact";

/** Where the line came from. Affects nothing except the evidence panel. */
export type EvidenceSource = "paste" | "sms" | "forward" | "manual" | "agent";

/**
 * Which reader produced a line's structured fields.
 *
 * `deterministic` is the always-available rule engine that runs on the server
 * and in the browser with no model and no network. `mobilebert-mnli` is the
 * open-weight model that runs inside the visitor's own browser. `ollama` is a
 * local Ollama daemon running an open-weight model such as Gemma. `agent` means
 * an MCP tool wrote the line through the shared service layer.
 */
export type ParseEngine = "manual" | "deterministic" | "mobilebert-mnli" | "ollama" | "agent" | "gemini";

/**
 * Whether a payload came from the network or from the sealed offline sample.
 *
 * `stale` means a live fetch succeeded but the cached copy was older than the
 * freshness window and was served instead.
 */
export type SourceStatus = "live" | "fallback" | "stale";

export type FlagSeverity = "info" | "warn" | "critical";

/* -------------------------------------------------------------------------- */
/* Ledger domain                                                               */
/* -------------------------------------------------------------------------- */

export type MemberKind = "you" | "flatmate" | "family";

export interface Member {
  id: string;
  name: string;
  kind: MemberKind;
}

export interface Household {
  id: string;
  name: string;
  /** Currency every balance and settlement is expressed in. */
  baseCurrency: CurrencyCode;
  /** ISO 3166-1 alpha-2, used to pick the CPI series. */
  countryCode: string;
  members: Member[];
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  householdId: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  occurredOn: string;
  direction: Direction;
  /** Integer minor units (paise, cents) of `currency`. Never a float. */
  amountMinor: number;
  currency: CurrencyCode;
  /**
   * Units of the household's base currency per one unit of `currency` — the
   * multiplier that converts this line into the base currency.
   *
   * Stored on the line rather than looked up on read, so a line keeps the rate
   * that was true on the day it was written instead of silently re-pricing
   * itself every time the ECB publishes. The engine's rate-discipline factor
   * compares it against today's published rate and flags a drift above 2%.
   *
   * Example: a USD 100 line in an INR household has fxRateToBase 96.32.
   */
  fxRateToBase: number;
  /** Integer minor units of the household base currency. Derived, never typed. */
  amountBaseMinor: number;
  paidBy: string | null;
  category: Category;
  note: string;
  /** The original message, kept verbatim. This is the evidence. */
  rawText: string;
  evidence: EvidenceSource;
  parseEngine: ParseEngine;
  /** 0..1. 1 means every field was certain. */
  parseConfidence: number;
  splitMode: SplitMode;
  /** Members this line is charged to. Empty is a validation error. */
  participants: string[];
  /** Present only when `splitMode === "exact"`: memberId -> base minor units. */
  exactShares: Record<string, number> | null;
  status: EntryStatus;
  receiptRef: string | null;
  idempotencyKey: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CATEGORIES = [
  "groceries",
  "utilities",
  "rent",
  "transport",
  "medicine",
  "household",
  "fees",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  groceries: "Groceries",
  utilities: "Utilities",
  rent: "Rent",
  transport: "Transport",
  medicine: "Medicine",
  household: "Household",
  fees: "Fees",
  other: "Other",
};

/** A read-only settlement statement published under an unguessable token. */
export interface ShareLink {
  token: string;
  householdId: string;
  ownerId: string;
  /** ISO timestamp; the link is refused after this instant. */
  expiresAt: string;
  /** Optional free-text label the sharer gave the statement. */
  label: string;
  createdAt: string;
  /** The audit seal at the moment the link was minted. */
  seal: string;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export type AuditAction =
  | "entry.create"
  | "entry.update"
  | "entry.confirm"
  | "entry.dispute"
  | "entry.delete"
  | "household.update"
  | "settlement.stamp"
  | "share.create";

export interface AuditEvent {
  id: string;
  /** The entity this event belongs to: an entry id, the household id, or the share token. */
  chainId: string;
  action: AuditAction;
  /** Canonical JSON string, so the sealed bytes are unambiguous. */
  payload: string;
  prevSeal: string;
  seal: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* External source: exchange rates (European Central Bank via Frankfurter)       */
/* -------------------------------------------------------------------------- */

export interface FxSnapshot {
  status: SourceStatus;
  /** Base currency of the snapshot, e.g. `USD`. */
  base: CurrencyCode;
  /** The rate date published by the provider (`YYYY-MM-DD`). */
  asOf: string;
  fetchedAt: string;
  provider: string;
  providerUrl: string;
  attribution: string;
  /** Units of each currency per one unit of `base`. */
  rates: Record<CurrencyCode, number>;
  /** The provider's own currency-code registry, used to validate input. */
  supported: CurrencyCode[];
}

/* -------------------------------------------------------------------------- */
/* External source: consumer price index (World Bank Open Data)                 */
/* -------------------------------------------------------------------------- */

export interface CpiPoint {
  year: number;
  /** Index value, or null when the provider has no observation for that year. */
  value: number | null;
}

export interface CpiSnapshot {
  status: SourceStatus;
  /** ISO 3166-1 alpha-2. */
  country: string;
  indicator: string;
  indicatorName: string;
  lastUpdated: string | null;
  fetchedAt: string;
  provider: string;
  providerUrl: string;
  attribution: string;
  series: CpiPoint[];
}

/* -------------------------------------------------------------------------- */
/* The reader: a pasted message turned into candidate ledger lines              */
/* -------------------------------------------------------------------------- */

/** Which way money moved, as decided by the reader. */
export type ReadDirection = Direction | "unclear";

export interface ReadField<T> {
  value: T;
  /** 0..1 certainty for this single field. */
  confidence: number;
  /** The exact substring the value came from, when one exists. */
  evidence: string | null;
}

export interface ReadCandidate {
  /** The segment of the original text this line came from. */
  text: string;
  direction: ReadField<ReadDirection>;
  amountMinor: ReadField<number | null>;
  currency: ReadField<CurrencyCode | null>;
  occurredOn: ReadField<string | null>;
  paidBy: ReadField<string | null>;
  /**
   * Member **names** the cost is charged to, because names are what appear in a
   * message. Resolved to member ids at the edge, so the rest of the system only
   * ever deals in ids.
   */
  participants: ReadField<string[] | null>;
  category: ReadField<Category | null>;
  /** 0..1 combined across every field. */
  confidence: number;
  engine: ParseEngine;
  /** True when the line has enough to be saved: an amount and a direction. */
  ready: boolean;
  /** Human-readable notes about what the reader was unsure of. */
  caveats: string[];
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export interface EngineFactor {
  id: string;
  label: string;
  /** Share of the total score. All weights sum to exactly 1. */
  weight: number;
  /** The measured quantity in its own natural units. */
  raw: number;
  /** The quantity mapped onto 0..1. */
  normalized: number;
  /** normalized * weight. Sums with the others to score / 100. */
  contribution: number;
  unit: string;
  /** Why this reading is what it is, in one sentence. */
  evidence: string;
}

export interface EngineFlag {
  id: string;
  severity: FlagSeverity;
  message: string;
  entryId?: string;
}

export interface BalanceRow {
  memberId: string;
  name: string;
  /** Total this member paid out, in base minor units. */
  paidBaseMinor: number;
  /** Total this member owes, in base minor units. */
  shareBaseMinor: number;
  /** paid - share. Positive means the household owes them. */
  netBaseMinor: number;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountBaseMinor: number;
}

export type SettlementVerdict = "healthy" | "review" | "settle";

export interface SettlementTotals {
  outflowBaseMinor: number;
  inflowBaseMinor: number;
  entryCount: number;
  /** Outflow minus inflow, in base minor units. What the household actually spent. */
  netSpendBaseMinor: number;
  /** Every member's share, in base minor units. Equals the outflow's participants' share. */
  chargedBaseMinor: number;
  /** Entries not yet confirmed. */
  unconfirmedCount: number;
  /** Entries someone has marked disputed. */
  disputedCount: number;
  /** Entries in a currency other than the household base currency. */
  foreignCurrencyCount: number;
}

export interface SettlementResult {
  /** Algorithm version. Bump whenever a weight or rule changes. */
  version: string;
  engine: string;
  computedAt: string;
  /** Rolling window in days, ending today. */
  windowDays: number;
  fromDate: string;
  toDate: string;
  baseCurrency: CurrencyCode;
  balances: BalanceRow[];
  transfers: Transfer[];
  transferCount: number;
  /** True when the plan provably uses the minimum possible number of transfers. */
  minimalTransfers: boolean;
  /** 0..100, the sum of the factors below. */
  score: number;
  factors: EngineFactor[];
  flags: EngineFlag[];
  verdict: SettlementVerdict;
  headline: string;
  actions: string[];
  totals: SettlementTotals;
  fx: Pick<FxSnapshot, "status" | "asOf" | "provider" | "attribution">;
  cpi: Pick<CpiSnapshot, "status" | "lastUpdated" | "provider" | "attribution"> | null;
  /** The household-level audit seal when this result was produced. */
  seal: string | null;
}

/* -------------------------------------------------------------------------- */
/* API envelopes                                                               */
/* -------------------------------------------------------------------------- */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level detail for validation failures. */
    fields?: Record<string, string>;
    requestId?: string;
  };
}

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: ApiErrorBody["error"];
}