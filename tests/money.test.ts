import { describe, expect, it } from "vitest";
import { allocateProportionally, convertMinor, currencyExponent, parseAmountToMinor, toMajor, toMinor } from "@/lib/money";

describe("minor units", () => {
  it("round-trips a major amount through integer minor units", () => {
    expect(toMinor(240.5, "INR")).toBe(24050);
    expect(toMajor(24050, "INR")).toBe(240.5);
  });

  it("knows which currencies do not use two decimals", () => {
    expect(currencyExponent("INR")).toBe(2);
    expect(currencyExponent("usd")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(toMinor(1250, "JPY")).toBe(1250);
  });

  it("is case insensitive about the currency", () => {
    expect(currencyExponent("jpy")).toBe(0);
  });

  it("parses the ways people actually write amounts", () => {
    expect(parseAmountToMinor("1,240.50", "INR")).toBe(124050);
    expect(parseAmountToMinor("₹240", "INR")).toBe(24000);
    expect(parseAmountToMinor("240/-", "INR")).toBe(24000);
    expect(parseAmountToMinor("2.5k", "INR")).toBe(250000);
    expect(parseAmountToMinor("1.2L", "INR")).toBe(12000000);
    expect(parseAmountToMinor("$1,000", "USD")).toBe(100000);
  });

  it("refuses text that is not an amount rather than guessing zero", () => {
    expect(parseAmountToMinor("paid the bill", "INR")).toBeNull();
    expect(parseAmountToMinor("", "INR")).toBeNull();
    expect(parseAmountToMinor(".", "INR")).toBeNull();
    expect(parseAmountToMinor("...", "INR")).toBeNull();
  });

  it("converts between currencies at the supplied rate", () => {
    // 100 USD at 96.32 INR/USD is 9632 INR = 963200 paise.
    expect(convertMinor(10_000, "USD", "INR", 96.32)).toBe(963200);
  });

  it("leaves the amount alone when the currency is unchanged", () => {
    expect(convertMinor(24050, "INR", "INR", 96.32)).toBe(24050);
  });
});

describe("largest-remainder allocation", () => {
  it("splits exactly, with no stray minor units", () => {
    const { shares, allocated, remainder } = allocateProportionally(100, ["a", "b", "c"], {
      a: 1, b: 1, c: 1,
    });
    expect(allocated).toBe(100);
    expect(remainder).toBe(0);
    expect(Object.values(shares).reduce((x, y) => x + y, 0)).toBe(100);
    // 100 / 3 leaves a remainder of 1, handed to the alphabetically first id.
    expect(shares).toEqual({ a: 34, b: 33, c: 33 });
  });

  it("honours uneven weights and still sums to the total", () => {
    const { shares, allocated } = allocateProportionally(1450, ["me", "them"], { me: 1, them: 1 });
    expect(allocated).toBe(1450);
    expect(shares).toEqual({ me: 725, them: 725 });
  });

  it("falls back to an equal split when every weight is zero or negative", () => {
    const { shares, allocated } = allocateProportionally(10, ["a", "b"], { a: 0, b: -5 });
    expect(allocated).toBe(10);
    expect(shares).toEqual({ a: 5, b: 5 });
  });

  it("handles the empty and zero-total boundaries without dividing by zero", () => {
    expect(allocateProportionally(500, [], {})).toEqual({ shares: {}, allocated: 0, remainder: 0 });
    const zero = allocateProportionally(0, ["a", "b"], { a: 1, b: 1 });
    expect(zero.allocated).toBe(0);
    expect(zero.shares).toEqual({ a: 0, b: 0 });
  });

  it("gives a single member everything", () => {
    expect(allocateProportionally(999, ["solo"], { solo: 1 }).shares).toEqual({ solo: 999 });
  });

  it("breaks ties on member id so the same input always yields the same output", () => {
    const first = allocateProportionally(1, ["zoe", "adam", "mia"], { zoe: 1, adam: 1, mia: 1 });
    const second = allocateProportionally(1, ["mia", "zoe", "adam"], { mia: 1, zoe: 1, adam: 1 });
    expect(first.shares).toEqual(second.shares);
    expect(first.shares.adam).toBe(1);
  });

  it("is exhaustive over every remainder up to the member count", () => {
    for (let n = 0; n <= 12; n++) {
      const ids = ["a", "b", "c", "d"].slice(0, n);
      if (ids.length === 0) continue;
      for (let total = 0; total <= 40; total++) {
        const weights = Object.fromEntries(ids.map((id) => [id, 1]));
        const { shares, allocated, remainder } = allocateProportionally(total, ids, weights);
        expect(allocated).toBe(total);
        expect(remainder).toBe(0);
        expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});