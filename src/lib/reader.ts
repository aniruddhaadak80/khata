/**
 * The reader: messy text in, candidate ledger lines out.
 *
 * This is the deterministic half. It runs on the server, in the browser, and in
 * `npm test` with no model, no network and no key. It is always available, and
 * it is what makes the product work at all.
 *
 * The open-weight model in `src/lib/local-model.ts` does the one job rules are
 * genuinely bad at: deciding which way the money moved. "refund received",
 * "refund paid", "she sent me back 200" and "she paid me back 200" are the same
 * amount with opposite directions, and no keyword list gets them all right.
 *
 * Everything here is pure and deterministic: the same text and the same `today`
 * always produce the same candidates, in the same order, with the same scores.
 */

import { parseAmountToMinor } from "./money";
import {
  CATEGORIES,
  type Category,
  type CurrencyCode,
  type ParseEngine,
  type ReadCandidate,
  type ReadField,
  type ReadDirection,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Segmentation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Split pasted text into one candidate per plausible payment.
 *
 * Splits on hard boundaries first (newlines, semicolons, bullets), then on
 * commas — but not on a comma that is a thousands separator. "1,240" must stay
 * one number, while "paid 240, Arunima paid 60" is two payments.
 */
export function segmentText(text: string): string[] {
  const out: string[] = [];
  const hard = text.split(/[\n\r;|•»]+/);

  for (const chunk of hard) {
    // A comma followed by exactly three digits is a separator inside a number.
    const parts = chunk.split(/,(?!\d{3}(?!\d))/);
    for (const part of parts) {
      const t = part.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Marker tables                                                               */
/* -------------------------------------------------------------------------- */

const CURRENCY_MARKERS: Array<{ re: RegExp; currency: CurrencyCode }> = [
  { re: /(?:₹|\brs\.?\b|\binr\b)/i, currency: "INR" },
  { re: /(?:\$|\busd\b|\bus\$)/i, currency: "USD" },
  { re: /(?:€|\beur\b)/i, currency: "EUR" },
  { re: /(?:£|\bgbp\b)/i, currency: "GBP" },
  { re: /\baed\b/i, currency: "AED" },
  { re: /\bsgd\b/i, currency: "SGD" },
  { re: /\baud\b/i, currency: "AUD" },
  { re: /\bcad\b/i, currency: "CAD" },
];

/**
 * Verbs and nouns that make a bare number a plausible amount.
 *
 * `refund` is here for a real reason: "received refund 320 from the seller"
 * contains no other money word, so without it the amount is silently lost —
 * which is the worst failure this reader can have, because the line looks like
 * it was read and simply has no number.
 */
const MONEY_VERB =
  /\b(paid|paid|spend|spent|spending|bought|purchased|purchase|recharge|recharged|recharging|bill|bills|top\s?up|topped\s?up|gave|give|send|sent|sending|cost|costs|rate|charges?|charged|refund|refunded|refunds|credited|repaid|reimbursed|transferred|deposited|paid)\b/i;

/**
 * Date-shaped substrings, blanked out before a bare number is read as money.
 *
 * Without this, "paid on 3 Oct" reads the 3 as 300 paise: "paid" is a money verb,
 * so the bare-number fallback fires and takes the day of the month as the price.
 */
const DATE_SHAPED = [
  /\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\b(?:\s*,?\s*\d{4})?/gi,
  /\b[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?\b(?:\s*,?\s*\d{4})?/gi,
  /\b\d{1,2}\s*[/.\-]\s*\d{1,2}(?:\s*[/.\-]\s*\d{2,4})?\b/g,
];

function withoutDates(text: string): string {
  let out = text;
  for (const pattern of DATE_SHAPED) out = out.replace(pattern, (m) => " ".repeat(m.length));
  return out;
}

/** Money arriving. Checked before the outflow list, because "received refund" and "refund paid" are opposites. */
const INFLOW_MARKERS: Array<{ re: RegExp; weight: number }> = [
  { re: /\b(received|receiv(?:e|ed)|got\s+back|credited|reimbursed)\b/i, weight: 0.9 },
  { re: /\bpaid\s+me\s+back\b/i, weight: 0.95 },
  { re: /\bsent\s+me\b|\bsent\s+back\b|\bgave\s+me\b|\bgave\s+back\b/i, weight: 0.9 },
  { re: /\brefund(?:ed)?\s+(?:received|credit)/i, weight: 0.95 },
  { re: /\breturned\b/i, weight: 0.7 },
  { re: /\bdeposited\b|\btop(?:ped)?\s*up\s+by\b/i, weight: 0.8 },
];

/** Money leaving. */
const OUTFLOW_MARKERS: Array<{ re: RegExp; weight: number }> = [
  { re: /\bpaid?\b/i, weight: 0.85 },
  { re: /\b(spent|spend|spending)\b/i, weight: 0.85 },
  { re: /\b(bought|purchased|purchase)\b/i, weight: 0.85 },
  { re: /\b(recharg(?:e|ed|ing)|top[\s-]?up(?:ped)?)\b/i, weight: 0.8 },
  { re: /\b(gave|sent|transferred|debited)\b/i, weight: 0.8 },
  { re: /\b(bill|charges?|cost|fee|rent|due)\b/i, weight: 0.6 },
];

const CATEGORY_MARKERS: Array<{ re: RegExp; category: Category }> = [
  { re: /\b(sabzi|sabzi|sabj|vegetable|vegetables|milk|atta|flour|dal|rice|chawal|fish|chicken|mutton|paneer|curd|grocery|groceries|kirana|supermarket|dmart|big\s*bazaar|more\s+supermarket|fruits?)\b/i, category: "groceries" },
  { re: /\b(electric(?:ity)?|bijli|bill|wifi|internet|water|gas|lpg|cylinder|broadband|recharge|postpaid|prepaid|municipal|bescom|tata\s*play)\b/i, category: "utilities" },
  { re: /\b(rent|house\s*rent|maintenance|society\s*charge|advance\s*rent|deposit)\b/i, category: "rent" },
  { re: /\b(auto|rickshaw|cab|uber|ola|metro|bus|train|petrol|diesel|fuel|parking|toll|travel|commute|bike\s*service|rapido)\b/i, category: "transport" },
  { re: /\b(medicine|medicines|tablet|tablets|pharmacy|chemist|doctor|hospital|clinic|check[\s-]?up|prescription|dentist|medical|test\s*report)\b/i, category: "medicine" },
  { re: /\b(cleaning|soap|shampoo|broom|mop|detergent|phenyl|household|utensil|cookware|bulb|pipe|repair|plumber|electrician|servant|maid)\b/i, category: "household" },
  { re: /\b(fee|fees|tuition|class|subscription|netflix|spotify|prime|gym|course|admission|exam\s*form|book)\b/i, category: "fees" },
];

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/* -------------------------------------------------------------------------- */
/* Field extraction                                                            */
/* -------------------------------------------------------------------------- */

function field<T>(value: T, confidence: number, evidence: string | null): ReadField<T> {
  return { value, confidence, evidence };
}

function detectCurrency(text: string): ReadField<CurrencyCode | null> {
  for (const marker of CURRENCY_MARKERS) {
    const m = marker.re.exec(text);
    if (m) return field<CurrencyCode | null>(marker.currency, 0.97, m[0]);
  }
  // No marker. INR is the right guess for the audience this was built for, but
  // it is a guess, so it is scored as one.
  if (MONEY_VERB.test(text) || /\d/.test(text)) {
    return field<CurrencyCode | null>("INR", 0.45, null);
  }
  return field<CurrencyCode | null>(null, 0, null);
}

/**
 * Find the money in a segment.
 *
 * Prefers an explicitly marked amount. Falls back to a bare number only when a
 * money verb is present, which stops "3 Oct" or "2 people" from being read as
 * a price.
 */
function detectAmount(text: string, currency: CurrencyCode | null): ReadField<number | null> {
  const currencyForParse = currency ?? "INR";

  // A currency marker immediately before or after the digits.
  const marked =
    /(?:₹|\brs\.?\b|\binr\b|\$|\busd\b|€|\beur\b|£|\bgbp\b)\s*(-?\d[\d,]*(?:\.\d{1,2})?)\s*(k|l)?/i.exec(text) ??
    /(-?\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|\brs\.?\b|\binr\b|\$|\busd\b|€|\beur\b|£|\bgbp\b)\s*(k|l)?/i.exec(text);

  if (marked) {
    const rawNumber = `${marked[1] ?? marked[3] ?? ""}${marked[2] ? (marked[2] as string).toLowerCase() : ""}`;
    const minor = parseAmountToMinor(rawNumber, currencyForParse);
    if (minor !== null && minor > 0) {
      return field<number | null>(minor, 0.95, marked[0].trim());
    }
  }

  // "/-" is how Indian receipts write rupees.
  const slashNotation = /(-?\d[\d,]*(?:\.\d{1,2})?)\s*\/\-/.exec(text);
  if (slashNotation?.[1]) {
    const minor = parseAmountToMinor(slashNotation[1], currencyForParse);
    if (minor !== null && minor > 0) return field<number | null>(minor, 0.85, slashNotation[0].trim());
  }

  // A bare number, but only where a money word makes it plausible, and never a
  // number that is really part of a date.
  const searchable = withoutDates(text);
  if (MONEY_VERB.test(text)) {
    const bare = /(?:^|\s)([1-9]\d{0,8}(?:\.\d{1,2})?)(?:k|l)?(?=\s|$|[^\d.])/i.exec(searchable);
    if (bare?.[1]) {
      const minor = parseAmountToMinor(bare[1], currencyForParse);
      if (minor !== null && minor > 0) return field<number | null>(minor, 0.62, bare[0].trim());
    }
  }

  return field<number | null>(null, 0, null);
}

function detectDirection(text: string): ReadField<ReadDirection> {
  let bestIn: { w: number; m: string } | null = null;
  for (const marker of INFLOW_MARKERS) {
    const m = marker.re.exec(text);
    if (m && (!bestIn || marker.weight > bestIn.w)) bestIn = { w: marker.weight, m: m[0] };
  }
  let bestOut: { w: number; m: string } | null = null;
  for (const marker of OUTFLOW_MARKERS) {
    const m = marker.re.exec(text);
    if (m && (!bestOut || marker.weight > bestOut.w)) bestOut = { w: marker.weight, m: m[0] };
  }

  // A "refund" that is being received beats a generic "paid" elsewhere in the
  // same clause; a "refund paid" is an outflow and the outflow word wins.
  const refundDirection = /\brefund\b/i.test(text)
    ? /\b(received|credited|back|returned?)\b/i.test(text)
      ? "inflow"
      : "outflow"
    : null;
  if (refundDirection) {
    const m = /\brefund\w*/i.exec(text);
    return field<ReadDirection>(refundDirection, 0.9, m ? m[0] : null);
  }

  if (bestIn && (!bestOut || bestIn.w > bestOut.w)) {
    return field<ReadDirection>("inflow", bestIn.w, bestIn.m);
  }
  if (bestOut) {
    return field<ReadDirection>("outflow", bestOut.w, bestOut.m);
  }
  return field<ReadDirection>("unclear", 0, null);
}

/* -------------------------------------------------------------------------- */
/* Reconciling the rule engine with the open-weight model                       */
/* -------------------------------------------------------------------------- */

/**
 * Decide which engine's answer to a payment's direction survives.
 *
 * The rules and the model are not equal partners, and the asymmetry matters:
 * the rules are cheap, instant and right most of the time, so the model only
 * earns an override in two situations.
 *
 * 1. The rules gave up. `unclear` is not a weak answer, it is the absence of
 *    one, and "someone paid money out" versus "money came in" is exactly the
 *    pair the rules cannot separate without more words than the message has.
 *    Here the model decides outright — otherwise the model could never do the
 *    one job it exists for.
 * 2. The rules were confident but the model is *at least as confident* and
 *    disagrees. A weaker guess does not get to overrule a stronger one.
 *
 * `not-money` never overrides: it is the model declining to classify, which is
 * not evidence about direction.
 */
export function resolveDirection(
  rule: ReadField<ReadDirection>,
  model: { direction: "outflow" | "inflow" | "not-money"; confidence: number },
): ReadField<ReadDirection> {
  const decided =
    model.direction === "inflow" || model.direction === "outflow" ? model.direction : null;
  if (decided === null) {
    return { ...rule, confidence: Math.max(rule.confidence, model.confidence) };
  }

  const rulesGaveUp = rule.value === "unclear";
  const modelAtLeastAsSure = model.confidence >= rule.confidence;

  return rulesGaveUp || modelAtLeastAsSure
    ? { value: decided, confidence: model.confidence, evidence: "open-weight model" }
    : { ...rule, confidence: Math.max(rule.confidence, model.confidence) };
}

/**
 * Who paid, and who the cost lands on.
 *
 * Returns both because they differ in the common case: when a flatmate pays the
 * whole electricity bill and sends it to the household, the payer is the
 * flatmate and the cost is shared.
 */
export interface PartyRead {
  paidBy: ReadField<string | null>;
  participants: ReadField<string[] | null>;
  isSelf: ReadField<boolean | null>;
}

function detectParties(text: string, memberNames: readonly string[]): PartyRead {
  const lower = text.toLowerCase();

  // "I" / "me" / "myself" only counts when it is the subject of the verb.
  const selfPay = /(?:\b(?:i|me)\b[^.;]{0,24}\b(?:paid|spent|bought|recharged|gave|topped|sent)\b|\bpaid\s+by\s+me\b|\bi\s+paid\b)/i.test(text);
  const selfReceive = /\b(?:received|sent\s+me|gave\s+me|credited\s+me)\b/i.test(text);

  const paidBy = field<string | null>(null, 0, null);
  const isSelf = field<boolean | null>(null, 0, null);

  for (const name of memberNames) {
    const n = name.trim();
    if (n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\b${esc}\\b[^.;]{0,24}\\b(?:paid|spent|bought|sent|gave|recharged|paid\\s+up)\\b`, "i"),
      new RegExp(`\\bpaid\\s+by\\s+${esc}\\b`, "i"),
      new RegExp(`\\bfrom\\s+${esc}\\b`, "i"),
      new RegExp(`\\b${esc}\\s*(?:'s|s')\b`, "i"),
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) {
        paidBy.value = n;
        paidBy.confidence = 0.85;
        paidBy.evidence = m[0].trim();
        isSelf.value = false;
        isSelf.confidence = 0.7;
        isSelf.evidence = m[0].trim();
        break;
      }
    }
    if (paidBy.value) break;
  }

  if (!paidBy.value && selfPay) {
    isSelf.value = true;
    isSelf.confidence = 0.9;
    isSelf.evidence = "I";
    // The caller's member list decides which id "I" means.
  }
  if (!paidBy.value && selfReceive) {
    // Money arrived from someone outside the household, or from the household
    // member who was paid back. "received from Arunima" was already caught above.
    isSelf.value = false;
    isSelf.confidence = 0.4;
    isSelf.evidence = null;
  }

  // Who bears the cost.
  const participants = field<string[] | null>(null, 0, null);
  const between = /\bsplit\s+between\s+([^.;]+)/i.exec(text);
  const shared = /\bshared\s+(?:between|among)\s+([^.;]+)/i.exec(text);
  const among = /\bamong\s+([^.;]+)/i.exec(text);
  const group = between ?? shared ?? among;

  if (group?.[1]) {
    const found: string[] = [];
    for (const name of memberNames) {
      if (name.trim().length < 2) continue;
      if (group[1].toLowerCase().includes(name.trim().toLowerCase())) found.push(name.trim());
    }
    if (found.length > 0) {
      participants.value = found;
      participants.confidence = 0.85;
      participants.evidence = group[0].trim();
    }
  }

  const halfEach = /\b(half\s+each|50[\s\-/]*50|equally|even\s+split|divided\s+equally|each\s+half)\b/i.exec(text);
  if (!participants.value && halfEach) {
    participants.value = [...memberNames];
    participants.confidence = 0.8;
    participants.evidence = halfEach[0];
  }

  // "everyone", "all of us" — everyone named in the household bears it.
  const everyone = /\b(everyone|everybody|all\s+of\s+us|each\s+of\s+us|household|common)\b/i.exec(text);
  if (!participants.value && everyone && memberNames.length > 0) {
    participants.value = [...memberNames];
    participants.confidence = 0.7;
    participants.evidence = everyone[0];
  }

  if (!paidBy.confidence && selfPay) {
    paidBy.confidence = 0.5;
    paidBy.evidence = "I";
  }

  // A phrase like "split between Arunima and Meera" means the others pay too.
  if (participants.value && !selfPay && !isSelf.value && !paidBy.value) {
    const implied = /between/i.test(lower);
    if (implied) isSelf.confidence = Math.max(isSelf.confidence, 0.3);
  }

  return { paidBy, participants, isSelf };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today in UTC. Overridable so tests and replays are reproducible. */
export function isoToday(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoToday(d);
}

export function detectDate(text: string, today: string): ReadField<string | null> {
  const lower = text.toLowerCase();

  if (/\bday\s+before\s+yesterday\b/.test(lower)) {
    return field<string | null>(shiftIsoDate(today, -2), 0.9, "day before yesterday");
  }
  if (/\byesterday\b|\byest\b/.test(lower)) {
    return field<string | null>(shiftIsoDate(today, -1), 0.9, "yesterday");
  }
  if (/\btoday\b|\bjust\s+now\b|\bthis\s+morning\b/.test(lower)) {
    return field<string | null>(today, 0.95, "today");
  }
  if (/\btonight\b/.test(lower)) {
    return field<string | null>(today, 0.8, "tonight");
  }

  // "3 Oct", "3rd Oct", "Oct 3", "03 Oct 2026"
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b(?:\s*,?\s*(\d{4}))?/i.exec(text);
  const monthDay = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s*,?\s*(\d{4}))?/i.exec(text);

  const tryResolve = (d: number, monthName: string, year: string | undefined): string | null => {
    const month = MONTHS[monthName.toLowerCase()];
    if (!month) return null;
    if (d < 1 || d > 31) return null;
    const useYear = year ? Number.parseInt(year, 10) : Number.parseInt(today.slice(0, 4), 10);
    let iso = `${useYear}-${pad(month)}-${pad(d)}`;
    // A bare "3 Oct" read in January means last October, not 3 January of this year.
    if (!year && iso > today) iso = `${useYear - 1}-${pad(month)}-${pad(d)}`;
    return iso;
  };

  if (dayMonth?.[1] && dayMonth[2]) {
    const iso = tryResolve(Number.parseInt(dayMonth[1], 10), dayMonth[2], dayMonth[3]);
    if (iso) return field<string | null>(iso, 0.85, dayMonth[0].trim());
  }
  if (monthDay?.[1] && monthDay[2]) {
    const iso = tryResolve(Number.parseInt(monthDay[2], 10), monthDay[1], monthDay[3]);
    if (iso) return field<string | null>(iso, 0.85, monthDay[0].trim());
  }

  // Numeric, unambiguous only when day is first: 03/10 is 3 October in an
  // Indian context, and "03/10" as 10 March would be a coin flip. So it is read
  // day-first and scored lower.
  const numeric = /\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/.exec(text);
  if (numeric?.[1] && numeric[2]) {
    const day = Number.parseInt(numeric[1], 10);
    const month = Number.parseInt(numeric[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const rawYear = numeric[3];
      let year = rawYear ? Number.parseInt(rawYear, 10) : Number.parseInt(today.slice(0, 4), 10);
      if (rawYear && year < 100) year += 2000;
      return field<string | null>(`${year}-${pad(month)}-${pad(day)}`, 0.6, numeric[0].trim());
    }
  }

  return field<string | null>(null, 0, null);
}

function detectCategory(text: string): ReadField<Category | null> {
  for (const marker of CATEGORY_MARKERS) {
    const m = marker.re.exec(text);
    if (m) return field<Category | null>(marker.category, 0.8, m[0].trim());
  }
  return field<Category | null>(null, 0, null);
}

/* -------------------------------------------------------------------------- */
/* Candidate assembly                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Combine field confidences into one number.
 *
 * Amount and direction dominate because they decide whether a line is saveable
 * at all and which way it moves; the rest adjust the score without changing the
 * outcome. An amount and a direction that are both missing scores 0.
 */
export function combineConfidence(fields: readonly { confidence: number; value: unknown }[]): number {
  const weights = [0.34, 0.3, 0.14, 0.1, 0.07, 0.05];
  let sum = 0;
  let weightSum = 0;
  fields.forEach((f, i) => {
    const w = weights[i] ?? 0.05;
    if (f.value === null || f.value === undefined || f.value === "") return;
    sum += f.confidence * w;
    weightSum += w;
  });
  if (weightSum === 0) return 0;
  return round3(sum / weightSum);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ReadContext {
  /** `YYYY-MM-DD` used to resolve "today" and "yesterday". */
  today: string;
  /** Household member names, used to resolve who paid and who shares. */
  memberNames: readonly string[];
  /** The member id that "I" means. */
  selfMemberId: string;
  engine?: ParseEngine;
}

/**
 * Read one segment deterministically.
 *
 * Exported separately from `readText` so the browser model can classify the
 * direction of an already-tokenised candidate without redoing the work.
 */
export function readSegment(text: string, ctx: ReadContext): ReadCandidate {
  const engine: ParseEngine = ctx.engine ?? "deterministic";
  const currency = detectCurrency(text);
  const amountMinor = detectAmount(text, currency.value);
  const direction = detectDirection(text);
  const occurredOn = detectDate(text, ctx.today);
  const parties = detectParties(text, ctx.memberNames);
  const category = detectCategory(text);

  let paidBy: ReadField<string | null> = parties.paidBy;
  if (paidBy.value === null && parties.isSelf.value === true) {
    paidBy = field<string | null>(ctx.selfMemberId, parties.isSelf.confidence, "I");
  }

  let participants: ReadField<string[] | null> = parties.participants;
  if (participants.value === null) {
    // Nothing said about sharing, so everyone named in the household bears an
    // equal share. That is the common case in a shared flat and it is also the
    // least surprising reading.
    participants = field<string[] | null>(
      ctx.memberNames.length > 0 ? [...ctx.memberNames] : null,
      0.3,
      null,
    );
  }

  const confidence = combineConfidence([
    { confidence: amountMinor.confidence, value: amountMinor.value },
    { confidence: direction.confidence, value: direction.value === "unclear" ? null : direction.value },
    { confidence: occurredOn.confidence, value: occurredOn.value },
    { confidence: paidBy.confidence, value: paidBy.value },
    { confidence: participants.confidence, value: participants.value },
    { confidence: category.confidence, value: category.value },
  ]);

  const caveats: string[] = [];
  if (direction.value === "unclear") caveats.push("Could not tell which way the money moved.");
  if (amountMinor.value === null) caveats.push("No amount found in this line.");
  if (occurredOn.value === null) caveats.push("No date found, so today is assumed.");
  if (paidBy.value === null) caveats.push("Could not tell who paid.");
  if (category.value === null) caveats.push("No category matched, so it will file under Other.");
  if (ctx.memberNames.length === 0) caveats.push("This household has no members yet.");

  const candidate: ReadCandidate = {
    text,
    direction,
    amountMinor,
    currency,
    occurredOn,
    paidBy,
    participants,
    category,
    confidence,
    engine,
    ready: amountMinor.value !== null && direction.value !== "unclear",
    caveats,
  };

  return summariseRead(candidate);
}

/**
 * Recompute everything that depends on a candidate's field values.
 *
 * Kept separate from `readSegment` because a candidate's fields are not written
 * once and never touched: the browser model rewrites `direction` later, and any
 * figure cached alongside it — the headline confidence, whether the row is
 * writable, the caveats shown under it — is stale the moment that happens.
 * Recomputing in one place is what keeps a model-corrected row honest.
 */
export function summariseRead(c: ReadCandidate): ReadCandidate {
  const confidence = combineConfidence([
    { confidence: c.amountMinor.confidence, value: c.amountMinor.value },
    { confidence: c.direction.confidence, value: c.direction.value === "unclear" ? null : c.direction.value },
    { confidence: c.occurredOn.confidence, value: c.occurredOn.value },
    { confidence: c.paidBy.confidence, value: c.paidBy.value },
    { confidence: c.participants.confidence, value: c.participants.value },
    { confidence: c.category.confidence, value: c.category.value },
  ]);

  const caveats: string[] = [];
  if (c.direction.value === "unclear") caveats.push("Could not tell which way the money moved.");
  if (c.amountMinor.value === null) caveats.push("No amount found in this line.");
  if (c.occurredOn.value === null) caveats.push("No date found, so today is assumed.");
  if (c.paidBy.value === null) caveats.push("Could not tell who paid.");
  if (c.category.value === null) caveats.push("No category matched, so it will file under Other.");
  if (!c.participants.value || c.participants.value.length === 0) {
    caveats.push("This household has no members yet.");
  }

  return {
    ...c,
    confidence,
    ready: c.amountMinor.value !== null && c.direction.value !== "unclear",
    caveats,
  };
}

/**
 * Read a whole pasted message into candidate lines.
 *
 * Every segment is returned, including ones with no money in them. Showing the
 * reader that it *rejected* a line ("no amount found") is more trustworthy than
 * silently dropping it, because the reader can then see it did not just lose
 * something.
 */
export function readText(text: string, ctx: ReadContext): ReadCandidate[] {
  const segments = segmentText(text);
  return segments.map((s) => readSegment(s, ctx));
}

/** Categories that the keyword table can produce, for tests and docs. */
export const READABLE_CATEGORIES = CATEGORIES;