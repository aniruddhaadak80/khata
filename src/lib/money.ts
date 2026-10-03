/**
 * Money handling.
 *
 * Two rules hold everywhere in khata:
 *
 * 1. Amounts are **integer minor units**. Paise, cents, yen. A ledger that
 *    stores floats accumulates drift: 0.1 + 0.2 !== 0.3, and a household that
 *    splits a bill three ways cannot end up exactly even.
 *
 * 2. Splitting uses the **largest-remainder method**, so the parts always sum
 *    back to the whole exactly. Floor division would leave the remainder
 *    unallocated, and handing it to the first member is arbitrary and
 *    arguable — exactly the class of small unfairness this product exists to
 *    remove.
 */

/** Currencies whose minor unit is not 1/100. */
const EXPONENT_OVERRIDES: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

/**
 * How many decimal places the currency's minor unit has.
 *
 * Unknown currencies default to 2, which covers every ISO 4217 code in normal
 * circulation except the zero- and three-decimal ones listed above.
 */
export function currencyExponent(currency: string): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

export function isKnownExponentCurrency(currency: string): boolean {
  return currency.toUpperCase() in EXPONENT_OVERRIDES;
}

export function minorUnitFactor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** Convert a major-unit amount ("240.50") to integer minor units. */
export function toMinor(major: number, currency: string): number {
  const factor = minorUnitFactor(currency);
  return Math.round(major * factor);
}

/** Convert integer minor units back to a major-unit number. */
export function toMajor(minor: number, currency: string): number {
  return minor / minorUnitFactor(currency);
}

/**
 * Parse a human amount like "1,240.50", "₹240", "1240" or "1.2k".
 * Returns null when the string is not an amount at all.
 */
export function parseAmountToMinor(raw: string, currency: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // "1.2k" and "2.5L" are how people actually write amounts in a chat message.
  const suffix = /^(.*?)([kKlL])$/.exec(trimmed);
  let body = trimmed;
  let multiplier = 1;
  const suffixChar = suffix?.[2];
  if (suffix && suffix[1] !== undefined && suffixChar) {
    body = suffix[1];
    multiplier = suffixChar.toLowerCase() === "k" ? 1_000 : 100_000;
  }
  const cleaned = body.replace(/[^0-9.]/g, "");
  if (cleaned === "" || !/^[0-9]*\.?[0-9]*$/.test(cleaned) || cleaned === ".") return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * multiplier * minorUnitFactor(currency));
}

/**
 * Convert an amount in one currency into another, rounding to the target's
 * minor unit.
 */
export function convertMinor(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  rate: number,
): number {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return amountMinor;
  const major = toMajor(amountMinor, fromCurrency) * rate;
  return toMinor(major, toCurrency);
}

export interface Allocation {
  /** memberId -> integer base minor units. */
  shares: Record<string, number>;
  /** The total that was allocated. Equals `total`. */
  allocated: number;
  /** Always 0 with largest-remainder allocation. Kept as an assertion target. */
  remainder: number;
}

/**
 * Split `total` minor units across `weights` in proportion, guaranteeing the
 * shares sum to exactly `total`.
 *
 * Largest-remainder allocation:
 *   1. exact_i   = total * weight_i / sumWeights
 *   2. floor_i   = floor(exact_i)               (integer, always <= exact_i)
 *   3. leftover  = total - sum(floor_i)         (0 <= leftover < n)
 *   4. hand the leftover one unit at a time to the largest fractional parts,
 *      breaking ties by memberId ascending so the result is deterministic.
 *
 * Boundary behaviour: an empty weight set, all-zero weights and a zero total
 * all return a valid, zero-valued allocation rather than dividing by zero.
 */
export function allocateProportionally(
  total: number,
  memberIds: readonly string[],
  weights: Readonly<Record<string, number>>,
): Allocation {
  const ids = [...memberIds].sort();
  const shares: Record<string, number> = {};
  for (const id of ids) shares[id] = 0;

  if (ids.length === 0 || total === 0) {
    return { shares, allocated: 0, remainder: 0 };
  }

  const safeWeights = ids.map((id) => {
    const w = weights[id];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
  });
  const weightSum = safeWeights.reduce((a, b) => a + b, 0);

  // Every weight is zero or negative: fall back to an equal split, which is the
  // only defensible reading of "split this evenly, no preferences given".
  const effective = weightSum > 0 ? safeWeights : ids.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : ids.length;

  const fractions = effective.map((w) => (total * w) / effectiveSum);
  const floors = fractions.map((f) => Math.floor(f));
  let assigned = floors.reduce((a, b) => a + b, 0);

  ids.forEach((id, i) => {
    shares[id] = floors[i] ?? 0;
  });

  const order = ids
    .map((id, i) => ({ id, fraction: (fractions[i] ?? 0) - (floors[i] ?? 0) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let cursor = 0;
  // `assigned <= total` always, so this loop is bounded by the member count.
  while (assigned < total && order.length > 0) {
    const target = order[cursor % order.length];
    if (target) {
      shares[target.id] = (shares[target.id] ?? 0) + 1;
      assigned += 1;
    }
    cursor += 1;
  }
  // If rounding left more than one unit over (only reachable with extreme
  // weights), hand the rest out one unit at a time in the same order.
  while (assigned < total) {
    const target = order[cursor % order.length];
    if (!target) break;
    shares[target.id] = (shares[target.id] ?? 0) + 1;
    assigned += 1;
    cursor += 1;
  }

  const remainder = total - assigned;
  return { shares, allocated: assigned, remainder };
}

/** Clamp to a safe non-negative integer, for anything coming off the wire. */
export function sanitiseMinor(value: unknown, maxMinor = 1_000_000_000_00): number | null {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > maxMinor) return null;
  return rounded;
}