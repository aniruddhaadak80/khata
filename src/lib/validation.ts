/**
 * Request validation and the shared error envelope.
 *
 * Every route validates through here, so a client always gets the same shape
 * back: `{ ok: false, error: { code, message, fields? } }`. Consistent envelopes
 * are what let the agent console and the curl examples in the README be
 * written once and keep working.
 */

import { z } from "zod";
import { CATEGORIES, type ApiErrorBody, type Err } from "./types";
import { isKnownExponentCurrency } from "./money";

export const ERROR_CODES = {
  validation: "VALIDATION_FAILED",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  rateLimited: "RATE_LIMITED",
  badRequest: "BAD_REQUEST",
  upstream: "UPSTREAM_UNAVAILABLE",
  internal: "INTERNAL_ERROR",
  unsupported: "UNSUPPORTED",
} as const;

export function errorEnvelope(
  code: string,
  message: string,
  fields?: Record<string, string>,
): Err {
  const body: ApiErrorBody = { error: { code, message } };
  if (fields && Object.keys(fields).length > 0) body.error.fields = fields;
  return { ok: false, error: body.error };
}

export function notFound(what: string): Err {
  return errorEnvelope(ERROR_CODES.notFound, `${what} not found.`);
}

export function badRequest(message: string): Err {
  return errorEnvelope(ERROR_CODES.badRequest, message);
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * A member id is the stable key of a person inside one household, not a
 * display name. The default household seeds them as `me` and `them`, so this
 * has to accept short ids: rejecting them made the hand-entry form fail its
 * own default payload with a 422. Length is capped and the alphabet is
 * restricted; that is the real protection.
 */
export const memberIdSchema = z
  .string()
  .min(1, "member id cannot be empty")
  .max(64, "member id is too long")
  .regex(/^[A-Za-z0-9_-]+$/, "member id may only contain letters, digits, dash and underscore");

export const currencySchema = z
  .string()
  .regex(CURRENCY, "currency must be a 3-letter ISO 4217 code, for example INR")
  .refine((c) => !isKnownExponentCurrency(c), "this currency has a non-decimal minor unit and is not supported")
  .transform((c) => c.toUpperCase());

export const amountMinorSchema = z
  .number()
  .int("amount must be a whole number of minor units")
  .positive("amount must be greater than zero")
  .max(100_000_000_00, "amount is implausibly large");

export const shareMapSchema = z.record(z.string(), z.number().int().min(0));

/* -------------------------------------------------------------------------- */
/* Household                                                                   */
/* -------------------------------------------------------------------------- */

export const memberInputSchema = z.object({
  id: memberIdSchema,
  name: z.string().trim().min(1, "a member needs a name").max(40, "name is too long"),
  kind: z.enum(["you", "flatmate", "family"]),
});

export const householdPatchSchema = z
  .object({
    name: z.string().trim().min(1, "the household needs a name").max(60, "name is too long").optional(),
    baseCurrency: currencySchema.optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/, "country code must be 2 letters, for example IN")
      .transform((c) => c.toUpperCase())
      .optional(),
    members: z.array(memberInputSchema).min(1, "a household needs at least one member").max(12, "twelve members is the limit").optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "send at least one field to change" });

/* -------------------------------------------------------------------------- */
/* Entries                                                                     */
/* -------------------------------------------------------------------------- */

export const createEntrySchema = z.object({
  occurredOn: z
    .string()
    .regex(ISO_DATE, "occurredOn must be a calendar date like 2026-10-03")
    .refine((d) => d <= nextIsoDate(14), "occurredOn cannot be in the future"),
  direction: z.enum(["outflow", "inflow"]),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  /** Optional: the live rate is used when this is absent. */
  fxRateToBase: z.number().positive().max(1_000_000).optional(),
  paidBy: memberIdSchema.nullable().optional(),
  category: z.enum(CATEGORIES).default("other"),
  note: z.string().trim().max(240, "note is too long").default(""),
  rawText: z.string().max(2000, "rawText is too long").default(""),
  evidence: z.enum(["paste", "sms", "forward", "manual", "agent"]).default("manual"),
  parseEngine: z
    .enum(["manual", "deterministic", "mobilebert-mnli", "ollama", "agent", "gemini"])
    .default("manual"),
  parseConfidence: z.number().min(0).max(1).default(1),
  splitMode: z.enum(["equal", "exact"]).default("equal"),
  participants: z.array(memberIdSchema).min(1, "at least one member must bear this cost").max(12).optional(),
  exactShares: shareMapSchema.nullish(),
  status: z.enum(["draft", "confirmed", "disputed"]).default("draft"),
  receiptRef: z.string().trim().max(80).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export type CreateEntryInput = z.infer<typeof createEntrySchema>;

export const updateEntrySchema = z
  .object({
    occurredOn: z
      .string()
      .regex(ISO_DATE, "occurredOn must be a calendar date like 2026-10-03")
      .refine((d) => d <= nextIsoDate(14), "occurredOn cannot be in the future")
      .optional(),
    direction: z.enum(["outflow", "inflow"]).optional(),
    amountMinor: amountMinorSchema.optional(),
    currency: currencySchema.optional(),
    fxRateToBase: z.number().positive().max(1_000_000).optional(),
    paidBy: memberIdSchema.nullable().optional(),
    category: z.enum(CATEGORIES).optional(),
    note: z.string().trim().max(240, "note is too long").optional(),
    rawText: z.string().max(2000, "rawText is too long").optional(),
    parseEngine: z
      .enum(["manual", "deterministic", "mobilebert-mnli", "ollama", "agent", "gemini"])
      .optional(),
    parseConfidence: z.number().min(0).max(1).optional(),
    splitMode: z.enum(["equal", "exact"]).optional(),
    participants: z.array(memberIdSchema).min(1, "at least one member must bear this cost").max(12).optional(),
    exactShares: shareMapSchema.nullish(),
    status: z.enum(["draft", "confirmed", "disputed"]).optional(),
    receiptRef: z.string().trim().max(80).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "send at least one field to change" });

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export const listEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.enum(["draft", "confirmed", "disputed", "all"]).default("all"),
  direction: z.enum(["outflow", "inflow", "all"]).default("all"),
  category: z.enum([...CATEGORIES, "all"]).default("all"),
  member: z.string().max(64).optional(),
  /** Newest first by default; `occurred_on` sorts by the event date. */
  sort: z.enum(["created_desc", "created_asc", "occurred_desc", "occurred_asc"]).default("created_desc"),
});

export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Reader                                                                      */
/* -------------------------------------------------------------------------- */

export const parseRequestSchema = z.object({
  text: z.string().trim().min(1, "paste something to read").max(4000, "that is more than 4000 characters"),
  /** Date to treat as "today" when resolving relative dates like "yesterday". */
  today: z
    .string()
    .regex(ISO_DATE, "today must be a calendar date like 2026-10-03")
    .optional(),
});

export type ParseRequest = z.infer<typeof parseRequestSchema>;

/**
 * One line, sent to the optional cloud tier.
 *
 * Smaller than `parseRequestSchema` on purpose: the hosted model is only ever
 * asked for a direction on a single message the rules could not settle, so the
 * body it is allowed to carry is capped well below the paste limit.
 */
export const cloudDirectionRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(4, "that line is too short for the reader")
    .max(600, "send one message, at most 600 characters"),
});

export type CloudDirectionRequest = z.infer<typeof cloudDirectionRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Settlement                                                                  */
/* -------------------------------------------------------------------------- */

export const settlementQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  /** Freeze the clock for reproducible runs and tests. */
  today: z.string().regex(ISO_DATE).optional(),
});

export type SettlementQuery = z.infer<typeof settlementQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Share links                                                                 */
/* -------------------------------------------------------------------------- */

export const shareCreateSchema = z.object({
  label: z.string().trim().max(80, "label is too long").default(""),
  /** Days the link stays open. */
  days: z.coerce.number().int().min(1).max(30).default(7),
});

export const shareTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,64}$/, "that is not a valid statement token");

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function nextIsoDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Flatten a Zod error into `{ fieldName: message }` for the envelope. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Run a schema, returning either the parsed value or a ready error envelope. */
export function parseOrEnvelope<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; response: Err } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    response: errorEnvelope(
      ERROR_CODES.validation,
      "Some fields need fixing before this can be saved.",
      fieldErrors(result.error),
    ),
  };
}