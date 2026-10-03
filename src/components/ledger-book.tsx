"use client";

/**
 * The Ledger: the book itself.
 *
 * Filter, sort and page all live in the URL, so a filtered view survives a
 * refresh and can be pasted to someone else. Nothing is fetched until the URL
 * changes, which means the browser Back button behaves the way a person
 * expects rather than re-running every query.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Filter, Plus, Trash2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { CATEGORIES, CATEGORY_LABELS, type EntryStatus, type LedgerEntry } from "@/lib/types";
import { CATEGORY_TONE, formatDate, money } from "@/lib/format";
import { Empty, Failure, Loading, Rubric } from "./states";
import type { ListEntriesResponse } from "@/lib/client-types";

const SORTS = [
  { value: "created_desc", label: "Newest first" },
  { value: "created_asc", label: "Oldest first" },
  { value: "occurred_desc", label: "Most recent date" },
  { value: "occurred_asc", label: "Earliest date" },
] as const;

const STATUSES: Array<{ value: EntryStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "confirmed", label: "Confirmed" },
  { value: "disputed", label: "Disputed" },
];

export function LedgerBook({ baseCurrency }: { baseCurrency: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [data, setData] = useState<ListEntriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const query = useMemo(() => {
    const q: Record<string, string> = {};
    for (const key of ["status", "direction", "category", "member", "sort", "limit", "offset"]) {
      const value = params.get(key);
      if (value) q[key] = value;
    }
    return q;
  }, [params]);

  const key = JSON.stringify(query);

  const load = useCallback(async () => {
    setLoading(true);
    const search = new URLSearchParams(query);
    const response = await api.get<ListEntriesResponse>(`/api/entries?${search.toString()}`);
    if (response.ok) {
      setData(response.data);
      setError(null);
    } else {
      setError({ message: errorText(response.error), fields: response.error.fields });
    }
    setLoading(false);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const search = new URLSearchParams(query);
      const response = await api.get<ListEntriesResponse>(`/api/entries?${search.toString()}`);
      if (cancelled) return;
      if (response.ok) {
        setData(response.data);
        setError(null);
      } else {
        setError({ message: errorText(response.error), fields: response.error.fields });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(name);
    else next.set(name, value);
    // Any change to a filter invalidates the page offset.
    if (name !== "offset") next.delete("offset");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const decide = async (entry: LedgerEntry, status: EntryStatus) => {
    setBusyId(entry.id);
    const response = await api.patch<{ entry: LedgerEntry; sealShort: string }>(`/api/entries/${entry.id}`, { status });
    if (response.ok) {
      setFlash(
        status === "confirmed"
          ? `Confirmed, and sealed ${response.data.sealShort}.`
          : `Marked disputed, and sealed ${response.data.sealShort}.`,
      );
      await load();
    } else {
      setError({ message: errorText(response.error), fields: response.error.fields });
    }
    setBusyId(null);
  };

  const remove = async (entry: LedgerEntry) => {
    setBusyId(entry.id);
    const response = await api.delete<{ sealShort: string; tombstone: { kept: boolean } }>(`/api/entries/${entry.id}`);
    if (response.ok) {
      setFlash(
        `Removed. A tombstone is kept so the seal chain stays replayable — see the verify page for ${response.data.sealShort}.`,
      );
      await load();
    } else {
      setError({ message: errorText(response.error) });
    }
    setBusyId(null);
  };

  const total = data?.total ?? 0;
  const returned = data?.items.length ?? 0;
  const offset = Number(query.offset ?? 0);
  const limit = Number(query.limit ?? 25);
  const members = data?.household.members ?? [];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <section className="card p-4" aria-label="Filters">
        <div className="flex items-center gap-2 text-[color:var(--color-ink-500)]">
          <Filter className="h-4 w-4" aria-hidden="true" />
          <p className="rubric">Filters live in the address bar</p>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="f-status" className="rubric">Status</label>
            <select id="f-status" className="field mt-1" value={query.status ?? "all"} onChange={(e) => setParam("status", e.target.value)}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-direction" className="rubric">Direction</label>
            <select id="f-direction" className="field mt-1" value={query.direction ?? "all"} onChange={(e) => setParam("direction", e.target.value)}>
              <option value="all">All</option>
              <option value="outflow">Money out</option>
              <option value="inflow">Money in</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-category" className="rubric">Category</label>
            <select id="f-category" className="field mt-1" value={query.category ?? "all"} onChange={(e) => setParam("category", e.target.value)}>
              <option value="all">All</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-sort" className="rubric">Order</label>
            <select id="f-sort" className="field mt-1" value={query.sort ?? "created_desc"} onChange={(e) => setParam("sort", e.target.value)}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {members.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rubric">Member</span>
            <button type="button" className={`btn ${!query.member ? "btn-primary" : "btn-quiet"}`} onClick={() => setParam("member", "")} aria-pressed={!query.member}>
              Anyone
            </button>
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn ${query.member === m.id ? "btn-primary" : "btn-quiet"}`}
                onClick={() => setParam("member", query.member === m.id ? "" : m.id)}
                aria-pressed={query.member === m.id}
              >
                {m.name}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {flash ? (
        <p className="card border-l-4 border-l-[color:var(--color-moss-600)] p-3 text-sm text-[color:var(--color-ink-900)]" role="status">
          {flash}
        </p>
      ) : null}

      {error ? <Failure title="The ledger did not load" message={error.message} fields={error.fields} onRetry={load} /> : null}

      {/* The book */}
      {loading && !data ? <Loading label="Opening the book…" /> : null}

      {data && returned === 0 && !loading ? (
        <Empty
          title={total === 0 && !query.status && !query.direction && !query.category ? "The book is empty." : "No lines match those filters."}
          action={
            total === 0 ? (
              <div className="flex flex-wrap gap-2">
                <Link href="/reader" className="btn btn-primary">Paste messages in</Link>
                <Link href="/ledger/new" className="btn btn-quiet">Add one by hand</Link>
              </div>
            ) : (
              <button type="button" className="btn btn-quiet" onClick={() => router.replace(pathname, { scroll: false })}>
                Clear the filters
              </button>
            )
          }
        >
          {total === 0
            ? "Paste the payment messages that arrive in a shared home, or add a line by hand. Every line keeps the message it came from, so there is something to check later."
            : `There are ${total} line${total === 1 ? "" : "s"} in this book, but none match. Widen the filters.`}
        </Empty>
      ) : null}

      {data && returned > 0 ? (
        <>
          <section aria-label="Ledger lines">
            <div className="hidden border-b border-[color:var(--color-madder-600)] md:grid md:grid-cols-[6rem_1fr_8rem_7rem_8rem_7rem] md:gap-3">
              <span className="rubric py-1">Date</span>
              <span className="rubric py-1">What</span>
              <span className="rubric py-1 text-right">Out / in</span>
              <span className="rubric py-1 text-right">In {baseCurrency}</span>
              <span className="rubric py-1">Paid by</span>
              <span className="rubric py-1 text-right">Decide</span>
            </div>

            <ul>
              {data.items.map((entry, i) => (
                <li
                  key={entry.id}
                  className="khata-bleed grid gap-2 border-b border-[color:var(--color-rule)] py-3 md:grid-cols-[6rem_1fr_8rem_7rem_8rem_7rem] md:items-center md:gap-3"
                  style={{ animationDelay: `${Math.min(i * 45, 400)}ms` }}
                >
                  <span className="tabular font-data text-xs text-[color:var(--color-ink-500)]">{formatDate(entry.occurredOn)}</span>

                  <span className="min-w-0">
                    <Link href={`/ledger/${entry.id}`} className="block truncate font-display text-base text-[color:var(--color-ink-900)] underline decoration-transparent underline-offset-4 hover:decoration-[color:var(--color-madder-600)]">
                      {entry.note.trim() || (entry.rawText.trim() ? `“${entry.rawText.trim().slice(0, 70)}”` : CATEGORY_LABELS[entry.category])}
                    </Link>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className={`rubric ${CATEGORY_TONE[entry.category] ?? ""}`}>{CATEGORY_LABELS[entry.category]}</span>
                      <span className="rubric">{entry.parseEngine}</span>
                      {entry.status !== "confirmed" ? (
                        <span className={`rubric ${entry.status === "disputed" ? "text-[color:var(--color-madder-600)]" : "text-[color:var(--color-turmeric-500)]"}`}>
                          {entry.status}
                        </span>
                      ) : null}
                    </span>
                  </span>

                  <span className={`tabular text-right font-data text-sm ${entry.direction === "outflow" ? "text-[color:var(--color-madder-600)]" : "text-[color:var(--color-moss-600)]"}`}>
                    {entry.direction === "outflow" ? "−" : "+"}
                    {money(entry.amountMinor, entry.currency).replace(` ${entry.currency}`, "")}
                    <span className="ml-1 text-[10px] opacity-70">{entry.currency}</span>
                  </span>

                  <span className="tabular text-right font-data text-sm text-[color:var(--color-ink-900)]">
                    {money(entry.amountBaseMinor, baseCurrency)}
                  </span>

                  <span className="truncate text-sm text-[color:var(--color-ink-700)]">
                    {members.find((m) => m.id === entry.paidBy)?.name ?? "Unrecorded"}
                  </span>

                  <span className="flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => decide(entry, "confirmed")}
                      disabled={busyId === entry.id}
                      aria-label={`Confirm the ${money(entry.amountMinor, entry.currency)} line from ${formatDate(entry.occurredOn)}`}
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => decide(entry, "disputed")}
                      disabled={busyId === entry.id}
                      aria-label={`Mark the ${money(entry.amountMinor, entry.currency)} line as disputed`}
                    >
                      Dispute
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => remove(entry)}
                      disabled={busyId === entry.id}
                      aria-label={`Remove the ${money(entry.amountMinor, entry.currency)} line from ${formatDate(entry.occurredOn)}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
            <p className="rubric">
              Showing {offset + 1}–{offset + returned} of {total}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setParam("offset", String(Math.max(0, offset - limit)))}
                disabled={offset === 0}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setParam("offset", String(offset + limit))}
                disabled={offset + returned >= total}
              >
                Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
              <Link href="/ledger/new" className="btn btn-primary">
                <Plus className="h-4 w-4" aria-hidden="true" /> Add by hand
              </Link>
            </div>
          </nav>
        </>
      ) : null}

      <Rubric>Reading the columns</Rubric>
      <p className="max-w-prose text-sm leading-relaxed text-[color:var(--color-ink-700)]">
        &ldquo;Out / in&rdquo; is the line&apos;s own currency, exactly as it was recorded. &ldquo;In {baseCurrency}&rdquo;
        is the same amount converted at the rate captured when the line was written, so a foreign
        line keeps the rate that was true on the day rather than drifting with today&apos;s quote.
      </p>
    </div>
  );
}