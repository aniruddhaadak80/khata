/**
 * The service layer.
 *
 * Every write in khata goes through here: the browser UI, the REST routes and
 * the MCP tools all call the same functions. That is deliberate. If the agent
 * could mutate state by a different route than the UI, then "the agent and the
 * app agree" would be an untested assumption, and the product's central claim —
 * two people can agree on a number — would be the first thing to rot.
 *
 * Responsibilities:
 *   - own the anonymous session
 *   - resolve the household, creating a starter one on first visit
 *   - resolve live FX and convert to the household's base currency
 *   - normalise splits so they always sum to the amount
 *   - append an audit event for every create, update, decision and delete
 *   - expose the settlement engine with a seal reference
 */

import { randomBytes } from "node:crypto";
import { analyseSettlement, computeEntryShare, normaliseExactShares } from "./engine";
import { getCpiSnapshot, getFxSnapshot, rateFor, supportedCurrencies } from "./fx";
import { convertMinor } from "./money";
import { getRepository, type CreateEntryRecord, type ListQuery, type Repository } from "./repository";
import { resolveSession } from "./session";
import {
  ERROR_CODES,
  errorEnvelope,
  parseOrEnvelope,
  settlementQuerySchema,
} from "./validation";
import type {
  CpiSnapshot,
  Err,
  FxSnapshot,
  Household,
  LedgerEntry,
  Member,
  Ok,
  SettlementResult,
  ShareLink,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Session and household                                                       */
/* -------------------------------------------------------------------------- */

export interface Session {
  ownerId: string;
  household: Household;
  repository: Repository;
}

const DEFAULT_MEMBERS: Member[] = [
  { id: "me", name: "You", kind: "you" },
  { id: "them", name: "Flatmate", kind: "flatmate" },
];

/**
 * Open the session and get the household.
 *
 * The scope cookie is minted by `src/middleware.ts` before this runs, so this
 * function only ever *reads* it. It is idempotent: calling it on every request
 * costs one indexed read.
 */
export async function openSession(): Promise<Session> {
  const { ownerId } = await resolveSession();

  const repository = await getRepository();
  await repository.init();

  let household = await repository.getHousehold(ownerId);
  if (!household) {
    household = await repository.createHousehold(ownerId, {
      name: "Our flat",
      baseCurrency: "INR",
      countryCode: "IN",
      members: DEFAULT_MEMBERS,
    });
    await repository.appendAudit(
      household.id,
      "household.update",
      { created: true, name: household.name, baseCurrency: household.baseCurrency, members: household.members },
      ownerId,
    );
  }

  return { ownerId, household, repository };
}

export async function getHouseholdSession(): Promise<Session> {
  return openSession();
}

export async function patchHousehold(
  session: Session,
  patch: Partial<Pick<Household, "name" | "baseCurrency" | "countryCode" | "members">>,
): Promise<{ ok: true; household: Household } | { ok: false; response: Err }> {
  if (patch.members && patch.members.length > 0) {
    const ids = new Set(patch.members.map((m) => m.id));
    if (ids.size !== patch.members.length) {
      return {
        ok: false,
        response: errorEnvelope(ERROR_CODES.validation, "Two members share the same id.", {
          members: "every member needs a distinct id",
        }),
      };
    }
  }

  const updated = await session.repository.updateHousehold(session.ownerId, patch);
  if (!updated) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.notFound, "Household not found.") };
  }

  // Members that no longer exist must not linger on old lines, or the engine
  // would report an unknown participant. Reassign them to the first remaining
  // member rather than orphaning the line.
  const remainingIds = new Set(updated.members.map((m) => m.id));
  const fallbackId = updated.members[0]?.id ?? null;
  if (fallbackId) {
    const { items } = await session.repository.listEntries(session.ownerId, updated.id, {
      limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "created_asc",
    });
    for (const entry of items) {
      const paidByGone = entry.paidBy !== null && !remainingIds.has(entry.paidBy);
      const participantsGone = entry.participants.some((p) => !remainingIds.has(p));
      if (!paidByGone && !participantsGone) continue;
      await session.repository.updateEntry(session.ownerId, entry.id, {
        paidBy: paidByGone ? fallbackId : undefined,
        participants: entry.participants.filter((p) => remainingIds.has(p)),
        baseCurrency: updated.baseCurrency,
      });
      await session.repository.appendAudit(
        entry.id,
        "entry.update",
        { reassignedAfterMembershipChange: true, entryId: entry.id },
        session.ownerId,
      );
    }
  }

  await session.repository.appendAudit(session.household.id, "household.update", patch, session.ownerId);
  return { ok: true, household: updated };
}

/* -------------------------------------------------------------------------- */
/* Entries                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateEntryArgs {
  occurredOn: string;
  direction: LedgerEntry["direction"];
  amountMinor: number;
  currency: string;
  fxRateToBase?: number;
  paidBy?: string | null;
  category?: LedgerEntry["category"];
  note?: string;
  rawText?: string;
  evidence?: LedgerEntry["evidence"];
  parseEngine?: LedgerEntry["parseEngine"];
  parseConfidence?: number;
  splitMode?: LedgerEntry["splitMode"];
  participants?: string[];
  exactShares?: Record<string, number> | null;
  status?: LedgerEntry["status"];
  receiptRef?: string | null;
  idempotencyKey?: string | null;
}

async function resolveFx(
  session: Session,
  currency: string,
  suppliedRate: number | undefined,
): Promise<{ rate: number; snapshot: FxSnapshot }> {
  const snapshot = await getFxSnapshot(session.household.baseCurrency);
  if (currency.toUpperCase() === session.household.baseCurrency.toUpperCase()) {
    return { rate: 1, snapshot };
  }
  if (suppliedRate !== undefined) {
    // A manual rate is accepted and recorded, and the engine's rate-discipline
    // factor will flag it when it drifts from the published rate.
    return { rate: suppliedRate, snapshot };
  }
  const live = rateFor(snapshot, currency);
  if (live === null) return { rate: 0, snapshot };
  return { rate: live, snapshot };
}

function validateMembers(session: Session, paidBy: string | null, participants: string[]): string | null {
  const ids = new Set(session.household.members.map((m) => m.id));
  if (paidBy !== null && !ids.has(paidBy)) return "paidBy refers to someone who is not in this household.";
  const unknown = participants.find((p) => !ids.has(p));
  if (unknown) return `participants includes "${unknown}", who is not in this household.`;
  if (new Set(participants).size !== participants.length) return "participants contains a duplicate.";
  return null;
}

export async function createEntry(
  session: Session,
  args: CreateEntryArgs,
): Promise<{ ok: true; entry: LedgerEntry; seal: string; fx: FxSnapshot } | { ok: false; response: Err }> {
  const members = session.household.members;
  const participants =
    args.participants && args.participants.length > 0
      ? [...args.participants]
      : members.map((m) => m.id);
  const paidBy = args.paidBy === undefined ? (members[0]?.id ?? null) : args.paidBy;

  const problem = validateMembers(session, paidBy, participants);
  if (problem) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.validation, problem, { participants: problem }) };
  }

  const currency = args.currency.toUpperCase();
  const { rate, snapshot } = await resolveFx(session, currency, args.fxRateToBase);
  if (rate <= 0) {
    const supported = await supportedCurrencies();
    return {
      ok: false,
      response: errorEnvelope(
        ERROR_CODES.validation,
        `No published rate is available for ${currency}, so khata will not invent one.`,
        {
          currency: `${currency} is not in the Frankfurter rate set (${supported.length} currencies available). Record this line in a supported currency, or send fxRateToBase with the rate you used.`,
        },
      ),
    };
  }

  const amountBaseMinor = convertMinor(args.amountMinor, currency, session.household.baseCurrency, rate);
  if (amountBaseMinor <= 0) {
    return {
      ok: false,
      response: errorEnvelope(ERROR_CODES.validation, "That amount converts to zero in your base currency.", {
        amountMinor: "check the amount and the currency",
      }),
    };
  }

  const splitMode = args.splitMode ?? "equal";
  const exactShares =
    splitMode === "exact" && args.exactShares
      ? normaliseExactShares(amountBaseMinor, args.exactShares)
      : null;
  if (splitMode === "exact" && exactShares && Object.keys(exactShares).length === 0) {
    return {
      ok: false,
      response: errorEnvelope(ERROR_CODES.validation, "An exact split needs at least one positive share.", {
        exactShares: "give at least one member a share",
      }),
    };
  }

  const record: CreateEntryRecord = {
    householdId: session.household.id,
    occurredOn: args.occurredOn,
    direction: args.direction,
    amountMinor: args.amountMinor,
    currency,
    fxRateToBase: rate,
    amountBaseMinor,
    paidBy,
    category: args.category ?? "other",
    note: args.note ?? "",
    rawText: args.rawText ?? "",
    evidence: args.evidence ?? "manual",
    parseEngine: args.parseEngine ?? "manual",
    parseConfidence: args.parseConfidence ?? 1,
    splitMode,
    participants,
    exactShares,
    status: args.status ?? "draft",
    receiptRef: args.receiptRef ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
  };

  const entry = await session.repository.createEntry(session.ownerId, record);
  const event = await session.repository.appendAudit(
    entry.id,
    "entry.create",
    {
      amountMinor: entry.amountMinor,
      amountBaseMinor: entry.amountBaseMinor,
      category: entry.category,
      currency: entry.currency,
      direction: entry.direction,
      fxRateToBase: entry.fxRateToBase,
      occurredOn: entry.occurredOn,
      paidBy: entry.paidBy,
      participants: entry.participants,
      parseEngine: entry.parseEngine,
      status: entry.status,
    },
    session.ownerId,
  );

  return { ok: true, entry, seal: event.seal, fx: snapshot };
}

export async function updateEntry(
  session: Session,
  id: string,
  patch: Partial<CreateEntryArgs>,
): Promise<{ ok: true; entry: LedgerEntry; seal: string } | { ok: false; response: Err }> {
  const current = await session.repository.getEntry(session.ownerId, id);
  if (!current) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.notFound, "That ledger line does not exist.") };
  }

  const participants = patch.participants ?? current.participants;
  const paidBy = patch.paidBy === undefined ? current.paidBy : patch.paidBy;
  const problem = validateMembers(session, paidBy, participants);
  if (problem) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.validation, problem, { participants: problem }) };
  }

  const nextCurrency = (patch.currency ?? current.currency).toUpperCase();
  const needsRate =
    patch.fxRateToBase === undefined &&
    (nextCurrency !== current.currency || patch.amountMinor !== undefined);
  if (needsRate) {
    const { rate } = await resolveFx(session, nextCurrency, undefined);
    if (rate <= 0) {
      return {
        ok: false,
        response: errorEnvelope(
          ERROR_CODES.validation,
          `No published rate is available for ${nextCurrency}, so khata will not invent one.`,
          { currency: "record this line in a supported currency, or send fxRateToBase with the rate you used" },
        ),
      };
    }
    patch = { ...patch, fxRateToBase: rate };
  }

  const splitMode = patch.splitMode ?? current.splitMode;
  let exactShares = current.exactShares;
  if (patch.exactShares !== undefined) {
    const baseMinor = patch.amountMinor
      ? convertMinor(patch.amountMinor, nextCurrency, session.household.baseCurrency, patch.fxRateToBase ?? current.fxRateToBase)
      : current.amountBaseMinor;
    exactShares = patch.exactShares ? normaliseExactShares(baseMinor, patch.exactShares) : null;
  }
  if (splitMode === "equal") exactShares = null;

  const updated = await session.repository.updateEntry(session.ownerId, id, {
    ...(patch as Partial<CreateEntryRecord>),
    participants,
    paidBy,
    splitMode,
    exactShares,
    baseCurrency: session.household.baseCurrency,
  });
  if (!updated) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.notFound, "That ledger line no longer exists.") };
  }

  const action = patch.status && patch.status !== current.status
    ? patch.status === "confirmed" ? "entry.confirm" : "entry.dispute"
    : "entry.update";

  const event = await session.repository.appendAudit(
    id,
    action,
    {
      before: {
        amountMinor: current.amountMinor,
        category: current.category,
        occurredOn: current.occurredOn,
        paidBy: current.paidBy,
        status: current.status,
      },
      after: {
        amountMinor: updated.amountMinor,
        category: updated.category,
        occurredOn: updated.occurredOn,
        paidBy: updated.paidBy,
        status: updated.status,
      },
    },
    session.ownerId,
  );

  return { ok: true, entry: updated, seal: event.seal };
}

export async function deleteEntry(
  session: Session,
  id: string,
): Promise<{ ok: true; entry: LedgerEntry; seal: string; tombstone: true } | { ok: false; response: Err }> {
  const current = await session.repository.getEntry(session.ownerId, id);
  if (!current) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.notFound, "That ledger line does not exist.") };
  }
  const deleted = await session.repository.deleteEntry(session.ownerId, id);
  if (!deleted) {
    return { ok: false, response: errorEnvelope(ERROR_CODES.notFound, "That ledger line no longer exists.") };
  }
  const event = await session.repository.appendAudit(
    id,
    "entry.delete",
    { amountMinor: current.amountMinor, amountBaseMinor: current.amountBaseMinor, occurredOn: current.occurredOn },
    session.ownerId,
  );
  return { ok: true, entry: deleted, seal: event.seal, tombstone: true };
}

export async function getEntry(session: Session, id: string): Promise<LedgerEntry | null> {
  return session.repository.getEntry(session.ownerId, id);
}

/** Bounded, filtered, sorted read of the household's book. */
export async function queryEntries(session: Session, query: ListQuery) {
  return session.repository.listEntries(session.ownerId, session.household.id, query);
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                  */
/* -------------------------------------------------------------------------- */

export interface SettlementBundle {
  settlement: SettlementResult;
  fx: FxSnapshot;
  cpi: CpiSnapshot | null;
  members: Member[];
}

export async function computeSettlement(
  session: Session,
  raw: Record<string, unknown>,
): Promise<{ ok: true; value: SettlementBundle } | { ok: false; response: Err }> {
  const parsed = parseOrEnvelope(settlementQuerySchema, raw);
  if (!parsed.ok) return parsed;
  const { windowDays, today } = parsed.value;
  const clock = today ? new Date(`${today}T12:00:00Z`) : new Date();

  /*
   * Fanned out rather than awaited in sequence. The two feeds are network calls
   * and the database read is another; run together they cost one round trip
   * instead of three, which is the difference between a settlement that appears
   * and one that does not.
   */
  const [fx, cpi, all, seal] = await Promise.all([
    getFxSnapshot(session.household.baseCurrency),
    getCpiSnapshot(session.household.countryCode),
    session.repository.listEntries(session.ownerId, session.household.id, {
      limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "occurred_asc",
    }),
    session.repository.headSeal(session.ownerId, session.household.id),
  ]);

  const settlement = analyseSettlement({
    household: session.household,
    entries: all.items,
    fx,
    cpi,
    today: today ?? clock.toISOString().slice(0, 10),
    now: clock,
    windowDays,
    seal,
  });

  return { ok: true, value: { settlement, fx, cpi, members: session.household.members } };
}

/** Quick counts for the workspace header, from one bounded read. */
export async function householdTotals(session: Session) {
  const { items } = await session.repository.listEntries(session.ownerId, session.household.id, {
    limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "occurred_asc",
  });
  let outflow = 0;
  let inflow = 0;
  for (const e of items) {
    if (e.direction === "outflow") outflow += e.amountBaseMinor;
    else inflow += e.amountBaseMinor;
  }
  return { entryCount: items.length, outflowBaseMinor: outflow, inflowBaseMinor: inflow };
}

/**
 * Write "we agreed this is what we owe" into the household chain.
 *
 * This is the decisive moment in a shared ledger, so it is not a client-side
 * animation: the engine runs again through the same service layer everything
 * else uses, and a `settlement.stamp` event carrying the balances, the transfer
 * plan, the score and the window goes into the chain. Six weeks later, the pair
 * can prove not just what the book says but that they both saw it.
 */
export async function stampSettlement(
  session: Session,
  windowDays: number,
): Promise<{ ok: true; settlement: SettlementResult; seal: string } | { ok: false; response: Err }> {
  const computed = await computeSettlement(session, { windowDays: String(windowDays) });
  if (!computed.ok) return computed;

  const { settlement } = computed.value;
  const event = await session.repository.appendAudit(
    session.household.id,
    "settlement.stamp",
    {
      balances: settlement.balances,
      engine: settlement.version,
      fromDate: settlement.fromDate,
      score: settlement.score,
      toDate: settlement.toDate,
      totalBaseMinor: settlement.totals.chargedBaseMinor,
      transferCount: settlement.transferCount,
      transfers: settlement.transfers,
      verdict: settlement.verdict,
      windowDays: settlement.windowDays,
    },
    session.ownerId,
  );

  return { ok: true, settlement: { ...settlement, seal: event.seal }, seal: event.seal };
}

/* -------------------------------------------------------------------------- */
/* Share links                                                                 */
/* -------------------------------------------------------------------------- */

export async function createShareLink(
  session: Session,
  label: string,
  days: number,
): Promise<{ ok: true; link: ShareLink; url: string } | { ok: false; response: Err }> {
  const seal = await session.repository.headSeal(session.ownerId, session.household.id);
  const token = randomBytes(24).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + days * 86_400_000);
  const link = await session.repository.createShareLink(session.ownerId, {
    token,
    householdId: session.household.id,
    ownerId: session.ownerId,
    expiresAt: expiresAt.toISOString(),
    label,
    seal,
    createdAt: createdAt.toISOString(),
  });
  await session.repository.appendAudit(session.household.id, "share.create", { token, label, days }, session.ownerId);
  return { ok: true, link, url: `/statement/${token}` };
}

/* -------------------------------------------------------------------------- */
/* Reader                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Commit reader candidates as ledger lines.
 *
 * The browser's open-weight model produces the same shape the deterministic
 * reader produces, so this function is agnostic about which one ran — the
 * candidate's own `engine` field is recorded on each line it writes.
 */
export async function commitCandidates(
  session: Session,
  candidates: Array<{
    text: string;
    direction: "outflow" | "inflow";
    amountMinor: number;
    currency: string;
    occurredOn: string;
    paidBy: string | null;
    category: LedgerEntry["category"] | null;
    participants?: string[];
    parseEngine: LedgerEntry["parseEngine"];
    parseConfidence: number;
    evidence?: LedgerEntry["evidence"];
  }>,
): Promise<{ ok: true; created: LedgerEntry[]; failed: Array<{ text: string; reason: string }> } | { ok: false; response: Err }> {
  const created: LedgerEntry[] = [];
  const failed: Array<{ text: string; reason: string }> = [];

  for (const candidate of candidates) {
    const result = await createEntry(session, {
      occurredOn: candidate.occurredOn,
      direction: candidate.direction,
      amountMinor: candidate.amountMinor,
      currency: candidate.currency,
      paidBy: candidate.paidBy,
      category: candidate.category ?? "other",
      note: "",
      rawText: candidate.text,
      evidence: candidate.evidence ?? "paste",
      parseEngine: candidate.parseEngine,
      parseConfidence: candidate.parseConfidence,
      splitMode: "equal",
      ...(candidate.participants && candidate.participants.length > 0
        ? { participants: candidate.participants }
        : {}),
    });
    if (result.ok) created.push(result.entry);
    else failed.push({ text: candidate.text, reason: result.response.error.message });
  }

  return { ok: true, created, failed };
}

/* -------------------------------------------------------------------------- */
/* Share statements                                                            */
/* -------------------------------------------------------------------------- */

export type StatementResult =
  | { status: "ok"; household: Household; entries: LedgerEntry[]; settlement: SettlementResult; link: ShareLink; fx: FxSnapshot; cpi: CpiSnapshot | null }
  | { status: "missing" }
  | { status: "expired"; expiredAt: string };

/**
 * Resolve a share token into a full statement.
 *
 * Deliberately does **not** go through `openSession`. A share link is opened by
 * someone who does not hold the owner's cookie, so ownership here comes from the
 * stored link and nothing else. The token is 24 random bytes; that is the only
 * thing standing between a household's balances and a stranger, which is why the
 * link is minted with an expiry and the interface warns before it is created.
 */
export async function resolveStatement(token: string): Promise<StatementResult> {
  const repository = await getRepository();
  await repository.init();

  const link = await repository.getShareLink(token);
  if (!link) return { status: "missing" };
  if (Date.parse(link.expiresAt) <= Date.now()) return { status: "expired", expiredAt: link.expiresAt };

  const household = await repository.getHousehold(link.ownerId);
  if (!household) return { status: "missing" };

  const fx = await getFxSnapshot(household.baseCurrency);
  const cpi = await getCpiSnapshot(household.countryCode);
  const { items } = await repository.listEntries(link.ownerId, household.id, {
    limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "occurred_asc",
  });
  const clock = new Date();

  const settlement = analyseSettlement({
    household,
    entries: items,
    fx,
    cpi,
    today: clock.toISOString().slice(0, 10),
    now: clock,
    windowDays: 30,
    seal: link.seal,
  });

  return { status: "ok", household, entries: items, settlement, link, fx, cpi };
}

/* -------------------------------------------------------------------------- */
/* Small helpers shared by routes                                              */
/* -------------------------------------------------------------------------- */

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string): Err {
  return errorEnvelope(code, message);
}

export function entryShare(entry: LedgerEntry) {
  return computeEntryShare(entry);
}
