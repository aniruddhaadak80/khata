"use client";

/**
 * One ledger line, in full.
 *
 * The evidence is the point of this page. A number without the message it came
 * from is exactly the thing two people end up arguing about, so the raw text is
 * shown verbatim, the reader that produced it is named, and the per-field
 * confidence is exposed rather than hidden behind a single average.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Save, Trash2, TriangleAlert } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { CATEGORIES, CATEGORY_LABELS, type Category, type EntryStatus, type LedgerEntry } from "@/lib/types";
import type { EntryDetailResponse } from "@/lib/client-types";
import { formatDate, formatStamp, minorToInput, money } from "@/lib/format";
import { Seal } from "./seal";
import { Failure, Loading, Notice, Rubric } from "./states";

/**
 * The form is seeded from the fetched line and only re-seeded when a new line
 * arrives, so typing is never interrupted by a background refresh. `loading` is
 * derived from whether a response for this id has landed, which keeps the fetch
 * effect from calling setState synchronously and cascading a render.
 */
interface DetailState {
  data: EntryDetailResponse | null;
  error: { title?: string; message: string; fields?: Record<string, string> } | null;
}

export function EntryDetail({ id, baseCurrency }: { id: string; baseCurrency: string }) {
  const router = useRouter();
  const [state, setState] = useState<DetailState>({ data: null, error: null });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<Category>("other");
  const [paidBy, setPaidBy] = useState("");
  const [status, setStatus] = useState<EntryStatus>("draft");
  const [occurredOn, setOccurredOn] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await api.get<EntryDetailResponse>(`/api/entries/${id}`);
      if (cancelled) return;
      if (response.ok) {
        const e = response.data.entry;
        setAmount(minorToInput(e.amountMinor, e.currency));
        setNote(e.note);
        setCategory(e.category);
        setPaidBy(e.paidBy ?? "");
        setStatus(e.status);
        setOccurredOn(e.occurredOn);
        setDirty(false);
        setState({ data: response.data, error: null });
      } else {
        setState({ data: null, error: { title: "This line does not exist", message: errorText(response.error) } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  const data = state.data;
  const error = state.error;
  const loading = data === null && error === null;
  const reload = () => setNonce((n) => n + 1);

  const save = async () => {
    setBusy(true);
    setFlash(null);
    const major = Number.parseFloat(amount);
    const response = await api.patch<{ entry: LedgerEntry; sealShort: string }>(`/api/entries/${id}`, {
      amountMinor: Number.isFinite(major) ? Math.round(major * 100) : undefined,
      note,
      category,
      paidBy: paidBy || null,
      status,
      occurredOn,
    });
    if (response.ok) {
      setFlash(`Saved and sealed ${response.data.sealShort}.`);
      reload();
    } else {
      setState((prev) => ({
        ...prev,
        error: { title: "khata refused that change", message: errorText(response.error), fields: response.error.fields },
      }));
    }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    const response = await api.delete<{ sealShort: string }>(`/api/entries/${id}`);
    if (response.ok) {
      router.push("/ledger");
      router.refresh();
    } else {
      setState((prev) => ({
        ...prev,
        error: { title: "Could not remove that line", message: errorText(response.error) },
      }));
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading label="Opening the line…" />;

  if (error && !data) {
    return (
      <div className="space-y-4">
        <Failure title={error.title} message={error.message} fields={error.fields} onRetry={reload} />
        <Link href="/ledger" className="btn btn-quiet">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the ledger
        </Link>
      </div>
    );
  }

  if (!data) return null;

  const { entry, chain, household } = data;
  const members = household.members;
  const nameOf = (memberId: string | null) => members.find((m) => m.id === memberId)?.name ?? "Unrecorded";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/ledger" className="btn btn-quiet">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ledger
        </Link>
        <Seal seal={chain.headSeal} label={chain.ok ? "chain intact" : "chain broken"} tone={chain.ok ? "moss" : "madder"} />
      </div>

      <header>
        <p className="rubric">{formatDate(entry.occurredOn)} · {CATEGORY_LABELS[entry.category]}</p>
        <h1 className="font-display text-4xl text-[color:var(--color-ink-900)]">
          {money(entry.amountMinor, entry.currency)}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
          {entry.direction === "outflow" ? "Money left the household" : "Money came into the household"},
          paid by {nameOf(entry.paidBy)}.
        </p>
      </header>

      {flash ? <Notice tone="good">{flash}</Notice> : null}
      {error ? <Failure title={error.title} message={error.message} fields={error.fields} /> : null}

      {/* Evidence */}
      <section className="card khata-perf p-5 pl-8" aria-labelledby="evidence">
        <Rubric id="evidence">The evidence</Rubric>
        {entry.rawText.trim() ? (
          <blockquote className="mt-2 border-l-2 border-[color:var(--color-madder-600)] pl-4 font-data text-sm leading-relaxed text-[color:var(--color-ink-900)]">
            {entry.rawText}
          </blockquote>
        ) : (
          <p className="mt-2 text-sm text-[color:var(--color-ink-500)]">
            No message was kept for this line. That is the weakest kind of entry: there is nothing
            to check it against later, and the engine&apos;s evidence factor will say so.
          </p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact label="Written by" value={entry.parseEngine === "manual" ? "a person" : entry.parseEngine} />
          <Fact label="Read confidence" value={`${Math.round(entry.parseConfidence * 100)}%`} />
          <Fact label="Source" value={entry.evidence} />
          <Fact label="Receipt" value={entry.receiptRef ?? "none"} />
        </dl>
      </section>

      {/* Edit */}
      <section className="card p-5" aria-labelledby="edit">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="edit" className="font-display text-2xl text-[color:var(--color-ink-900)]">Change it</h2>
          {dirty ? <span className="rubric text-[color:var(--color-turmeric-500)]">unsaved</span> : null}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="e-amount" className="rubric">Amount ({entry.currency})</label>
            <input
              id="e-amount"
              type="number"
              step="0.01"
              className="field tabular mt-1"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setDirty(true); }}
            />
          </div>
          <div>
            <label htmlFor="e-date" className="rubric">Date</label>
            <input
              id="e-date"
              type="date"
              className="field tabular mt-1"
              value={occurredOn}
              onChange={(e) => { setOccurredOn(e.target.value); setDirty(true); }}
            />
          </div>
          <div>
            <label htmlFor="e-payer" className="rubric">Paid by</label>
            <select id="e-payer" className="field mt-1" value={paidBy} onChange={(e) => { setPaidBy(e.target.value); setDirty(true); }}>
              <option value="">Unrecorded</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="e-category" className="rubric">Category</label>
            <select id="e-category" className="field mt-1" value={category} onChange={(e) => { setCategory(e.target.value as Category); setDirty(true); }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="e-status" className="rubric">Decision</label>
            <select id="e-status" className="field mt-1" value={status} onChange={(e) => { setStatus(e.target.value as EntryStatus); setDirty(true); }}>
              <option value="draft">Draft — not yet agreed</option>
              <option value="confirmed">Confirmed — both agree</option>
              <option value="disputed">Disputed — needs talking about</option>
            </select>
          </div>
          <div>
            <label htmlFor="e-note" className="rubric">Note</label>
            <input
              id="e-note"
              type="text"
              className="field mt-1"
              value={note}
              maxLength={240}
              placeholder="What this was for"
              onChange={(e) => { setNote(e.target.value); setDirty(true); }}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {busy ? "Saving…" : "Save and seal"}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setStatus("confirmed")} disabled={busy || status === "confirmed"}>
            <Check className="h-4 w-4" aria-hidden="true" /> Mark agreed
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setStatus("disputed")} disabled={busy || status === "disputed"}>
            <TriangleAlert className="h-4 w-4" aria-hidden="true" /> Mark disputed
          </button>
          <button type="button" className="btn btn-quiet ml-auto" onClick={remove} disabled={busy}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
          </button>
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          Removing keeps a tombstone so this line&apos;s seal chain stays replayable. The Verify page
          will still show the deletion as a sealed event.
        </p>
      </section>

      {/* The split */}
      <section className="card p-5" aria-labelledby="split">
        <h2 id="split" className="font-display text-2xl text-[color:var(--color-ink-900)]">Who bears it</h2>
        <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
          {entry.splitMode === "equal"
            ? "Split equally between everyone named."
            : "Split by the exact amounts recorded."}
        </p>
        <ul className="mt-3 space-y-1">
          {members.map((m) => {
            const involved = entry.participants.includes(m.id);
            return (
              <li key={m.id} className="flex items-center justify-between border-b border-[color:var(--color-rule)] py-1.5 text-sm">
                <span className={involved ? "text-[color:var(--color-ink-900)]" : "text-[color:var(--color-ink-400)]"}>
                  {m.name}
                  {!involved ? <span className="ml-2 rubric">not on this line</span> : null}
                </span>
                <span className="tabular font-data text-[color:var(--color-ink-700)]">
                  {involved
                    ? entry.splitMode === "exact" && entry.exactShares
                      ? money(entry.exactShares[m.id] ?? 0, baseCurrency)
                      : `1/${entry.participants.length}`
                    : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* The chain */}
      <section className="card p-5" aria-labelledby="chain">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="chain" className="font-display text-2xl text-[color:var(--color-ink-900)]">Its chain</h2>
          <p className="rubric">{chain.checked} event{chain.checked === 1 ? "" : "s"}</p>
        </div>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Every change to this line is sealed. Replaying the chain recomputes each digest and reports
          the first one that does not match.
        </p>
        {!chain.ok ? (
          <div className="mt-3">
            <Failure title="This chain does not replay" message={chain.reason ?? "Unknown break."} />
          </div>
        ) : null}
        <ol className="mt-3 space-y-2">
          {chain.events.map((e, i) => (
            <li key={e.id} className="border-b border-[color:var(--color-rule)] pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-[color:var(--color-ink-900)]">
                  <span className="rubric mr-2">#{i + 1}</span>
                  {e.action}
                </span>
                <Seal seal={e.seal} />
              </div>
              <p className="font-data text-[11px] text-[color:var(--color-ink-500)]">
                {formatStamp(e.createdAt)} · prev {e.prevSeal.slice(0, 12)}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="rubric">{label}</dt>
      <dd className="mt-0.5 font-data text-sm text-[color:var(--color-ink-900)]">{value}</dd>
    </div>
  );
}