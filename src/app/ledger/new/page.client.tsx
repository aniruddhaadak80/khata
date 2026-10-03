"use client";

/**
 * Add one line by hand.
 *
 * The same reader, narrowed to a single row: type the amount, pick the payer and
 * the direction, and khata converts it at the live rate and seals it. There is a
 * fast path for the common case and an expandable one for everything else, so a
 * single grocery line does not have to become a form-filling exercise.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { CATEGORY_LABELS, type Category, type EntryStatus, type Household } from "@/lib/types";
import { money } from "@/lib/format";
import { Failure, Notice } from "@/components/states";

const QUICK_NOTES = ["Electricity", "Water", "Gas cylinder", "Groceries", "Rent", "Medicine", "Bus fare"];

export function NewEntryForm({ household }: { household: Household }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"outflow" | "inflow">("outflow");
  const [paidBy, setPaidBy] = useState(household.members[0]?.id ?? "");
  const [category, setCategory] = useState<Category>("groceries");
  const [note, setNote] = useState("");
  const [occurredOn, setOccurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<EntryStatus>("draft");
  const [advanced, setAdvanced] = useState(false);
  const [rawText, setRawText] = useState("");
  const [splitMode, setSplitMode] = useState<"equal" | "exact">("equal");
  const [participants, setParticipants] = useState<string[]>(household.members.map((m) => m.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [created, setCreated] = useState<{ id: string; amountBaseMinor: number; sealShort: string } | null>(null);

  const submit = async () => {
    const major = Number.parseFloat(amount);
    if (!Number.isFinite(major) || major <= 0) {
      setError({ message: "Enter an amount greater than zero." });
      return;
    }
    setBusy(true);
    setError(null);

    const response = await api.post<{
      entry: { id: string; amountBaseMinor: number };
      sealShort: string;
    }>("/api/entries", {
      occurredOn,
      direction,
      amountMinor: Math.round(major * 100),
      currency: household.baseCurrency,
      paidBy: paidBy || null,
      category,
      note: note.trim(),
      rawText: rawText.trim(),
      evidence: rawText.trim() ? "paste" : "manual",
      parseEngine: rawText.trim() ? "manual" : "manual",
      parseConfidence: 1,
      splitMode,
      participants,
      status,
    });

    if (response.ok) {
      setCreated({
        id: response.data.entry.id,
        amountBaseMinor: response.data.entry.amountBaseMinor,
        sealShort: response.data.sealShort,
      });
    } else {
      setError({ message: errorText(response.error), fields: response.error.fields });
    }
    setBusy(false);
  };

  if (created) {
    return (
      <div className="card khata-margin p-6 pl-8">
        <h2 className="font-display text-2xl text-[color:var(--color-ink-900)]">Written and sealed</h2>
        <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
          {money(created.amountBaseMinor, household.baseCurrency)} is in the book, sealed{" "}
          <span className="font-data">{created.sealShort}</span>.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/ledger/${created.id}`} className="btn btn-primary">Inspect the line</Link>
          <Link href="/ledger" className="btn btn-quiet">Back to the ledger</Link>
          <Link href="/settle" className="btn btn-quiet">See who pays whom</Link>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setCreated(null);
              setAmount("");
              setNote("");
              setRawText("");
            }}
          >
            Add another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="card p-5" aria-labelledby="quick">
        <h2 id="quick" className="font-display text-2xl text-[color:var(--color-ink-900)]">The quick version</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="n-amount" className="rubric">Amount ({household.baseCurrency})</label>
            <input
              id="n-amount"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              className="field tabular mt-1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="2400.00"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="n-date" className="rubric">Date</label>
            <input
              id="n-date"
              type="date"
              className="field tabular mt-1"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>
        </div>

        <fieldset className="mt-3">
          <legend className="rubric">Which way</legend>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              className={`btn ${direction === "outflow" ? "btn-madder" : "btn-quiet"}`}
              onClick={() => setDirection("outflow")}
              aria-pressed={direction === "outflow"}
            >
              Money out
            </button>
            <button
              type="button"
              className={`btn ${direction === "inflow" ? "btn-primary" : "btn-quiet"}`}
              onClick={() => setDirection("inflow")}
              aria-pressed={direction === "inflow"}
            >
              Money in
            </button>
          </div>
        </fieldset>

        <fieldset className="mt-3">
          <legend className="rubric">What for</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["groceries", "utilities", "rent", "transport", "medicine", "household", "fees", "other"] as Category[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`btn ${category === c ? "btn-primary" : "btn-quiet"}`}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {QUICK_NOTES.map((q) => (
              <button key={q} type="button" className="btn btn-quiet" onClick={() => setNote(q)}>
                {q}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-3">
          <label htmlFor="n-note" className="rubric">Note</label>
          <input
            id="n-note"
            type="text"
            className="field mt-1"
            maxLength={240}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="October electricity"
          />
        </div>
      </section>

      <section className="card p-5" aria-labelledby="advanced">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          aria-controls="advanced-body"
        >
          <span>
            <span className="rubric">Everything else</span>
            <span className="block font-display text-2xl text-[color:var(--color-ink-900)]">The rest of the fields</span>
          </span>
          <Plus className={`h-5 w-5 shrink-0 text-[color:var(--color-madder-600)] ${advanced ? "rotate-45 transition-transform" : "transition-transform"}`} aria-hidden="true" />
        </button>

        <div id="advanced-body" hidden={!advanced} className="mt-4 space-y-4">
          <div>
            <label htmlFor="n-payer" className="rubric">Paid by</label>
            <select id="n-payer" className="field mt-1" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              <option value="">Nobody recorded</option>
              {household.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="n-status" className="rubric">Decision</label>
            <select id="n-status" className="field mt-1" value={status} onChange={(e) => setStatus(e.target.value as EntryStatus)}>
              <option value="draft">Draft</option>
              <option value="confirmed">Confirmed</option>
              <option value="disputed">Disputed</option>
            </select>
          </div>

          <div>
            <label htmlFor="n-raw" className="rubric">Keep the original message</label>
            <textarea
              id="n-raw"
              rows={3}
              className="field khata-rules mt-1 font-data text-sm"
              value={rawText}
              maxLength={2000}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Paste the SMS here. It becomes this line's evidence, and the engine's evidence factor reads it."
            />
          </div>

          <fieldset>
            <legend className="rubric">Shared between</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {household.members.map((m) => {
                const on = participants.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`btn ${on ? "btn-primary" : "btn-quiet"}`}
                    onClick={() =>
                      setParticipants((prev) => (prev.includes(m.id) ? prev.filter((p) => p !== m.id) : [...prev, m.id]))
                    }
                    aria-pressed={on}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
            <label htmlFor="n-split" className="rubric mt-3 block">How to split</label>
            <select id="n-split" className="field mt-1" value={splitMode} onChange={(e) => setSplitMode(e.target.value as "equal" | "exact")}>
              <option value="equal">Equally between everyone selected</option>
              <option value="exact">By exact amounts, entered after saving</option>
            </select>
            {splitMode === "exact" ? (
              <p className="mt-1 text-xs text-[color:var(--color-ink-500)]">
                Save the line, then open it to enter exact amounts per person. khata will adjust the
                last share by a minor unit if the parts do not add to the whole, and record what it did.
              </p>
            ) : null}
          </fieldset>
        </div>
      </section>

      {error ? <Failure title="khata refused that" message={error.message} fields={error.fields} /> : null}
      <Notice>The line is sealed the moment it is written. Nothing you type here leaves the book.</Notice>

      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Writing…" : "Write and seal"}
      </button>
      <button
        type="button"
        className="btn btn-quiet ml-2"
        onClick={() => router.push("/ledger")}
      >
        Cancel
      </button>

    </div>
  );
}