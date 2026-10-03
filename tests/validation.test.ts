import { describe, expect, it } from "vitest";
import {
  cloudDirectionRequestSchema,
  createEntrySchema,
  memberInputSchema,
  memberIdSchema,
  updateEntrySchema,
} from "@/lib/validation";

/**
 * The hand-entry form at /ledger/new posts exactly this on its first render:
 * `paidBy` is the first household member (`me`) and `participants` are every
 * member (`me`, `them`). Both are shorter than the 3-character minimum this
 * schema used to carry, so saving a line by hand returned 422 while the
 * reader, the agent and the repository layer all accepted the same ids.
 */
const HAND_ENTRY_PAYLOAD = {
  occurredOn: "2026-10-03",
  direction: "outflow",
  amountMinor: 35000,
  currency: "INR",
  paidBy: "me",
  category: "groceries",
  note: "",
  rawText: "",
  evidence: "manual",
  parseEngine: "manual",
  parseConfidence: 1,
  splitMode: "equal",
  participants: ["me", "them"],
  status: "draft",
};

describe("memberIdSchema", () => {
  it("accepts the ids the default household is seeded with", () => {
    expect(memberIdSchema.parse("me")).toBe("me");
    expect(memberIdSchema.parse("them")).toBe("them");
    expect(memberIdSchema.parse("a")).toBe("a");
  });

  it("still rejects empty, over-long and non-alphabet ids", () => {
    expect(memberIdSchema.safeParse("").success).toBe(false);
    expect(memberIdSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(memberIdSchema.safeParse("not a member").success).toBe(false);
    expect(memberIdSchema.safeParse("id/with?chars").success).toBe(false);
  });
});

describe("createEntrySchema", () => {
  it("accepts the hand-entry form's default payload", () => {
    const parsed = createEntrySchema.safeParse(HAND_ENTRY_PAYLOAD);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.participants).toEqual(["me", "them"]);
      expect(parsed.data.paidBy).toBe("me");
    }
  });

  it("rejects a payload with nobody to bear the cost", () => {
    expect(createEntrySchema.safeParse({ ...HAND_ENTRY_PAYLOAD, participants: [] }).success).toBe(false);
  });

  it("still refuses a member id with a space in it", () => {
    const parsed = createEntrySchema.safeParse({ ...HAND_ENTRY_PAYLOAD, participants: ["me", "flat mate"] });
    expect(parsed.success).toBe(false);
  });

  it("refuses a member id that is only whitespace", () => {
    expect(createEntrySchema.safeParse({ ...HAND_ENTRY_PAYLOAD, participants: ["me", " "] }).success).toBe(false);
  });
});

describe("updateEntrySchema", () => {
  it("accepts reassigning a line to a two-character member id", () => {
    expect(updateEntrySchema.safeParse({ paidBy: "me", participants: ["me"] }).success).toBe(true);
  });

  it("rejects an empty change", () => {
    expect(updateEntrySchema.safeParse({}).success).toBe(false);
  });
});

describe("memberInputSchema", () => {
  it("lets a household keep its seeded ids when it is edited", () => {
    expect(memberInputSchema.safeParse({ id: "me", name: "You", kind: "you" }).success).toBe(true);
  });

  it("rejects an empty member id", () => {
    expect(memberInputSchema.safeParse({ id: "", name: "You", kind: "you" }).success).toBe(false);
  });
});

describe("cloudDirectionRequestSchema", () => {
  it("accepts a single pasted line", () => {
    expect(cloudDirectionRequestSchema.safeParse({ text: "wifi seller refunded me 320" }).success).toBe(true);
  });

  it("trims what it accepts", () => {
    expect(cloudDirectionRequestSchema.parse({ text: "  paid 100  " }).text).toBe("paid 100");
  });

  it("refuses an empty line, a stub and a whole paste", () => {
    expect(cloudDirectionRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(cloudDirectionRequestSchema.safeParse({ text: "hi" }).success).toBe(false);
    expect(cloudDirectionRequestSchema.safeParse({ text: "x".repeat(601) }).success).toBe(false);
  });

  it("refuses a body with no text at all", () => {
    expect(cloudDirectionRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("parseEngine", () => {
  it("records a line the hosted model decided as gemini, and still refuses nonsense", () => {
    const base = { ...HAND_ENTRY_PAYLOAD };
    expect(createEntrySchema.safeParse({ ...base, parseEngine: "gemini" }).success).toBe(true);
    expect(createEntrySchema.safeParse({ ...base, parseEngine: "chatgpt" }).success).toBe(false);
  });
});
