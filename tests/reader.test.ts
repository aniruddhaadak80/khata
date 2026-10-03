import { describe, expect, it } from "vitest";
import { combineConfidence, detectDate, isoToday, readSegment, readText, segmentText } from "@/lib/reader";

const CTX = {
  today: "2026-10-03",
  memberNames: ["Arunima", "Meera"],
  selfMemberId: "me",
};

const asNum = (c: ReturnType<typeof readSegment>, field: "amountMinor") => c[field].value;
const dir = (c: ReturnType<typeof readSegment>) => c.direction.value;

describe("segmentText", () => {
  it("splits on newlines and semicolons", () => {
    expect(segmentText("paid 100\npaid 200; paid 300")).toEqual(["paid 100", "paid 200", "paid 300"]);
  });

  it("splits on commas but never on a thousands separator", () => {
    expect(segmentText("paid 1,240 for rent, paid 300 for gas")).toEqual([
      "paid 1,240 for rent",
      "paid 300 for gas",
    ]);
  });

  it("returns nothing for whitespace", () => {
    expect(segmentText("   \n  \n ")).toEqual([]);
  });
});

describe("direction", () => {
  it("reads an outflow", () => {
    expect(dir(readSegment("Paid 2400 for the electricity bill", CTX))).toBe("outflow");
  });

  it("reads an inflow from a repayment", () => {
    expect(dir(readSegment("Meera sent me back 600", CTX))).toBe("inflow");
    expect(dir(readSegment("received 320 refund from the seller", CTX))).toBe("inflow");
  });

  it("reads a refund the other way round as an outflow", () => {
    // Same noun, opposite meaning. This is the case the rules get wrong and the
    // open-weight model exists for.
    expect(dir(readSegment("refund paid to the shop 120", CTX))).toBe("outflow");
    expect(dir(readSegment("received refund 320", CTX))).toBe("inflow");
  });

  it("admits when it cannot tell", () => {
    expect(dir(readSegment("electricity", CTX))).toBe("unclear");
    expect(dir(readSegment("tomorrow", CTX))).toBe("unclear");
  });

  it("never guesses silently: unclear means unclear", () => {
    const candidate = readSegment("electricity", CTX);
    expect(candidate.ready).toBe(false);
    expect(candidate.caveats.join(" ")).toMatch(/which way/i);
  });
});

describe("amounts", () => {
  it("finds a marked amount", () => {
    expect(asNum(readSegment("Paid ₹2,400.50 for rent", CTX), "amountMinor")).toBe(240050);
  });

  it("reads the Indian /- notation", () => {
    expect(asNum(readSegment("paid 350/- for the cylinder", CTX), "amountMinor")).toBe(35000);
  });

  it("reads a bare number only where a money verb makes it plausible", () => {
    expect(asNum(readSegment("paid 240 for cab", CTX), "amountMinor")).toBe(24000);
  });

  it("does not read a date as an amount", () => {
    expect(asNum(readSegment("paid on 3 Oct", CTX), "amountMinor")).toBeNull();
  });

  it("returns null when there is no amount rather than returning zero", () => {
    expect(asNum(readSegment("the bill arrived", CTX), "amountMinor")).toBeNull();
  });
});

describe("currency", () => {
  it("recognises the common markers", () => {
    expect(readSegment("paid ₹200", CTX).currency.value).toBe("INR");
    expect(readSegment("paid $200", CTX).currency.value).toBe("USD");
    expect(readSegment("paid EUR 200", CTX).currency.value).toBe("EUR");
  });

  it("defaults to INR but scores the guess as a guess", () => {
    const field = readSegment("paid 200", CTX).currency;
    expect(field.value).toBe("INR");
    expect(field.confidence).toBeLessThan(0.6);
  });
});

describe("dates", () => {
  it("resolves relative words against the supplied today", () => {
    expect(detectDate("paid yesterday", "2026-10-03").value).toBe("2026-10-02");
    expect(detectDate("paid today", "2026-10-03").value).toBe("2026-10-03");
    expect(detectDate("paid the day before yesterday", "2026-10-03").value).toBe("2026-10-01");
  });

  it("reads day-month names in either order", () => {
    expect(detectDate("paid on 3 Oct", "2026-10-03").value).toBe("2026-10-03");
    expect(detectDate("paid on Oct 3", "2026-10-03").value).toBe("2026-10-03");
  });

  it("reads a bare day-month in the past year when it would otherwise be future", () => {
    // Reading "25 Dec" in January as 25 January of this year would be wrong.
    expect(detectDate("paid on 25 Dec", "2026-01-05").value).toBe("2025-12-25");
  });

  it("reads numeric dates day-first and scores the ambiguity down", () => {
    const field = detectDate("paid 03/10", "2026-10-03");
    expect(field.value).toBe("2026-10-03");
    expect(field.confidence).toBeLessThan(0.7);
  });

  it("returns null when there is no date at all", () => {
    expect(detectDate("paid 200", "2026-10-03").value).toBeNull();
  });

  it("exposes today's date in the required shape", () => {
    expect(isoToday(new Date("2026-03-07T09:00:00Z"))).toBe("2026-03-07");
  });
});

describe("parties", () => {
  it("reads the household member who paid", () => {
    expect(readSegment("Meera paid 2400 for rent", CTX).paidBy.value).toBe("Meera");
  });

  it("reads a first person payer as the 'you' member", () => {
    expect(readSegment("I paid 240 for cab", CTX).paidBy.value).toBe("me");
  });

  it("reads who a cost is shared between", () => {
    expect(readSegment("split between Arunima and Meera, paid 100", CTX).participants.value).toEqual([
      "Arunima",
      "Meera",
    ]);
  });

  it("expands half-each to the whole household", () => {
    expect(readSegment("paid 900 half each", CTX).participants.value).toEqual(["Arunima", "Meera"]);
  });

  it("defaults to the whole household when nothing says otherwise", () => {
    expect(readSegment("paid 240 for cab", CTX).participants.value).toEqual(["Arunima", "Meera"]);
  });
});

describe("categories", () => {
  it("maps the vocabulary a shared home actually uses", () => {
    expect(readSegment("paid 200 for the electricity bill", CTX).category.value).toBe("utilities");
    expect(readSegment("paid 300 for groceries at DMart", CTX).category.value).toBe("groceries");
    expect(readSegment("paid 60 for the auto", CTX).category.value).toBe("transport");
    expect(readSegment("paid 400 rent", CTX).category.value).toBe("rent");
    expect(readSegment("paid 120 for the gas cylinder", CTX).category.value).toBe("utilities");
    expect(readSegment("paid 90 for medicine", CTX).category.value).toBe("medicine");
  });

  it("returns null rather than forcing a wrong category", () => {
    expect(readSegment("paid 200 for something", CTX).category.value).toBeNull();
  });
});

describe("readText", () => {
  const SAMPLE = `Paid 2400 to BESCOM for the electricity bill, Arunima paid half
Meera sent me back 600 for the gas cylinder
split between me and Meera, I paid Rs 1450 for groceries at DMart yesterday
received refund 320 from the wifi router seller
house rent 8500 paid by Meera on 1 Oct`;

  it("finds every payment in a realistic paste", () => {
    const candidates = readText(SAMPLE, CTX);
    // Seven segments: the comma in "bill, Arunima paid half" and the one in
    // "Meera, I paid" each split a run-on line in two.
    expect(candidates).toHaveLength(7);
    // Five are writeable. "Arunima paid half" and "split between me and Meera"
    // carry no amount of their own, and khata says so rather than inventing one.
    expect(candidates.filter((c) => c.ready)).toHaveLength(5);
  });

  it("gets the direction of each one right from rules alone", () => {
    const candidates = readText(SAMPLE, CTX);
    const directions = candidates.map((c) => c.direction.value);
    expect(directions.filter((d) => d === "inflow")).toHaveLength(2);
    expect(directions.filter((d) => d === "outflow")).toHaveLength(4);
    // "split between me and Meera" carries no money of its own.
    expect(directions.filter((d) => d === "unclear")).toHaveLength(1);
  });

  it("finds the amount in a message whose only money word is 'refund'", () => {
    // Regression: without 'refund' in the money vocabulary, this line came back
    // with a direction and no amount, which is the worst failure the reader has.
    const candidate = readSegment("received refund 320 from the wifi router seller", CTX);
    expect(candidate.amountMinor.value).toBe(32000);
    expect(candidate.ready).toBe(true);
  });

  it("keeps every segment, including the ones it could not read", () => {
    const candidates = readText("paid 100\njust saying hello\npaid 200", CTX);
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((c) => !c.ready)).toHaveLength(1);
  });

  it("is deterministic: the same text and clock give the same output", () => {
    expect(JSON.stringify(readText(SAMPLE, CTX))).toBe(JSON.stringify(readText(SAMPLE, CTX)));
  });

  it("returns an empty list for empty input rather than throwing", () => {
    expect(readText("", CTX)).toEqual([]);
  });

  it("handles malformed input without throwing", () => {
    const messy = "₹₹₹,,,  ---  /-  ...  paid";
    expect(() => readText(messy, CTX)).not.toThrow();
  });

  it("handles a household with no members yet", () => {
    const candidates = readText("paid 240 for cab", { ...CTX, memberNames: [] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.caveats.join(" ")).toMatch(/no members/i);
  });

  it("reports a confidence between zero and one for every candidate", () => {
    for (const candidate of readText(SAMPLE, CTX)) {
      expect(candidate.confidence).toBeGreaterThanOrEqual(0);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("combineConfidence", () => {
  it("returns zero when nothing was found", () => {
    expect(combineConfidence([{ confidence: 0.9, value: null }])).toBe(0);
    expect(combineConfidence([])).toBe(0);
  });

  it("ignores fields that are missing rather than averaging them in as zero", () => {
    const withMissing = combineConfidence([
      { confidence: 1, value: 100 },
      { confidence: 0, value: null },
    ]);
    expect(withMissing).toBe(1);
  });
});