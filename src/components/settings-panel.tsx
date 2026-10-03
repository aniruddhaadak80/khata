"use client";

/**
 * Settings: who is in the household, what currency the book is kept in, and an
 * honest account of where each line came from.
 */

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import type { CpiSnapshot, FxSnapshot, Household, Member, MemberKind } from "@/lib/types";
import { formatStamp } from "@/lib/format";
import { Failure, Notice } from "./states";

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "ZAR", "JPY"];
const COUNTRIES = [
  ["IN", "India"], ["US", "United States"], ["GB", "United Kingdom"], ["AE", "United Arab Emirates"],
  ["SG", "Singapore"], ["AU", "Australia"], ["CA", "Canada"], ["DE", "Germany"], ["JP", "Japan"], ["ZA", "South Africa"],
] as const;

const STATUS_TONE: Record<string, string> = {
  live: "text-[color:var(--color-moss-600)]",
  stale: "text-[color:var(--color-turmeric-500)]",
  fallback: "text-[color:var(--color-madder-600)]",
};

export function SettingsPanel({
  household,
  fx,
  cpi,
}: {
  household: Household;
  fx: FxSnapshot;
  cpi: CpiSnapshot | null;
}) {
  const [name, setName] = useState(household.name);
  const [currency, setCurrency] = useState(household.baseCurrency);
  const [country, setCountry] = useState(household.countryCode);
  const [members, setMembers] = useState<Member[]>(household.members);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setFlash(null);
    const response = await api.patch<{ household: Household; reassigned: string }>("/api/household", {
      name,
      baseCurrency: currency,
      countryCode: country,
      members: members.map((m) => ({ id: m.id, name: m.name.trim(), kind: m.kind })),
    });
    if (response.ok) {
      setFlash(
        `Saved. Note: ${response.data.reassigned}`,
      );
      setMembers(response.data.household.members);
      setName(response.data.household.name);
      setCurrency(response.data.household.baseCurrency);
      setCountry(response.data.household.countryCode);
    } else {
      setError({ message: errorText(response.error), fields: response.error.fields });
    }
    setBusy(false);
  };

  const addMember = () => {
    const n = members.length + 1;
    setMembers((prev) => [
      ...prev,
      { id: `member${n}`, name: `Member ${n}`, kind: n === 1 ? "you" : "flatmate" },
    ]);
  };

  const update = (id: string, changes: Partial<Member>) => {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  };

  return (
    <div className="space-y-6">
      <section className="card p-5" aria-labelledby="household">
        <h2 id="household" className="font-display text-2xl text-[color:var(--color-ink-900)]">
          The household
        </h2>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          One household per browser, held under an anonymous HTTP-only cookie. There are no accounts
          and no password, which is why the share links carry their own warning.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="h-name" className="rubric">Name</label>
            <input id="h-name" className="field mt-1" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="h-currency" className="rubric">Base currency</label>
            <select id="h-currency" className="field mt-1" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="h-country" className="rubric">Country, for consumer prices</label>
            <select id="h-country" className="field mt-1" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </div>
        </div>

        <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          Changing the base currency re-denominates balances, but the per-line rate captured when
          each line was written is kept — so an old foreign line does not silently re-price itself.
        </p>
      </section>

      <section className="card p-5" aria-labelledby="members">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="members" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            Who is in it
          </h2>
          <button type="button" className="btn btn-quiet" onClick={addMember} disabled={members.length >= 12}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add someone
          </button>
        </div>

        <ul className="mt-3 space-y-2">
          {members.map((m) => (
            <li key={m.id} className="grid gap-2 border-b border-[color:var(--color-rule)] pb-2 sm:grid-cols-[1fr_10rem_2rem] sm:items-end">
              <div>
                <label htmlFor={`m-name-${m.id}`} className="rubric">Name</label>
                <input
                  id={`m-name-${m.id}`}
                  className="field mt-1"
                  value={m.name}
                  maxLength={40}
                  onChange={(e) => update(m.id, { name: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`m-kind-${m.id}`} className="rubric">Role</label>
                <select
                  id={`m-kind-${m.id}`}
                  className="field mt-1"
                  value={m.kind}
                  onChange={(e) => update(m.id, { kind: e.target.value as MemberKind })}
                >
                  <option value="you">You</option>
                  <option value="flatmate">Flatmate</option>
                  <option value="family">Family</option>
                </select>
              </div>
              <button
                type="button"
                className="btn btn-quiet mb-0.5 justify-self-start sm:justify-self-end"
                onClick={() => setMembers((prev) => prev.filter((x) => x.id !== m.id))}
                disabled={members.length <= 1}
                aria-label={`Remove ${m.name}`}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
              <p className="font-data text-[11px] text-[color:var(--color-ink-400)] sm:col-span-3">
                id {m.id} · the agent tools use this id
              </p>
            </li>
          ))}
        </ul>

        {flash ? <div className="mt-3"><Notice tone="good">{flash}</Notice></div> : null}
        {error ? <div className="mt-3"><Failure title="khata refused that change" message={error.message} fields={error.fields} /></div> : null}

        <button type="button" className="btn btn-primary mt-4" onClick={save} disabled={busy}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? "Saving…" : "Save the household"}
        </button>
      </section>

      <section className="card p-5" aria-labelledby="sources">
        <h2 id="sources" className="font-display text-2xl text-[color:var(--color-ink-900)]">
          Where the outside numbers come from
        </h2>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Two keyless sources. Neither needs an account, and khata never presents a sealed sample as
          a live reading.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="border border-[color:var(--color-rule)] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-[color:var(--color-ink-900)]">Exchange rates</h3>
              <span className={`rubric ${STATUS_TONE[fx.status]}`}>{fx.status}</span>
            </div>
            <p className="mt-1 text-xs text-[color:var(--color-ink-700)]">{fx.attribution}</p>
            <p className="mt-2 font-data text-xs text-[color:var(--color-ink-500)]">
              as of {fx.asOf} · fetched {formatStamp(fx.fetchedAt)}
            </p>
            <p className="mt-2 font-data text-xs text-[color:var(--color-ink-900)]">
              1 {fx.base} = {fx.rates.USD ? fx.rates.USD : "—"} USD
              {fx.rates.EUR ? ` · ${fx.rates.EUR} EUR` : ""}
            </p>
            <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
              {fx.supported.length} currencies supported. A line in a currency outside this set is
              refused unless you supply the rate yourself.
            </p>
          </div>

          <div className="border border-[color:var(--color-rule)] p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-[color:var(--color-ink-900)]">Consumer prices</h3>
              <span className={`rubric ${cpi ? STATUS_TONE[cpi.status] : ""}`}>{cpi?.status ?? "none"}</span>
            </div>
            <p className="mt-1 text-xs text-[color:var(--color-ink-700)]">{cpi?.attribution ?? "No series available."}</p>
            {cpi ? (
              <>
                <p className="mt-2 font-data text-xs text-[color:var(--color-ink-500)]">
                  last updated {cpi.lastUpdated ?? "unknown"} · fetched {formatStamp(cpi.fetchedAt)}
                </p>
                <ul className="mt-2 space-y-0.5 font-data text-xs text-[color:var(--color-ink-900)]">
                  {cpi.series.slice(0, 5).map((p) => (
                    <li key={p.year} className="flex justify-between">
                      <span>{p.year}</span>
                      <span>{p.value === null ? "—" : p.value.toFixed(1)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section className="card p-5" id="method" aria-labelledby="method-heading">
        <h2 id="method-heading" className="font-display text-2xl text-[color:var(--color-ink-900)]">
          The method, in short
        </h2>

        <h3 className="mt-4 font-display text-lg text-[color:var(--color-ink-900)]">How money is attributed</h3>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          For every line the payer&apos;s <em>paid</em> rises by the amount and each participant&apos;s{" "}
          <em>share</em> rises by their portion. Then <code className="font-data">net = paid − share</code>,
          and a positive net means the household owes that person. An inflow follows the same rule,
          because receiving a refund on the household&apos;s behalf is arithmetically the same as
          fronting the money and recovering it. Each line keeps its own direction label so what the
          message actually said is never hidden.
        </p>
        <p className="mt-2 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Splitting uses the largest-remainder method, so the parts always sum to the whole exactly.
          Floor division would strand the remainder, and handing it to whoever came first in the
          list is the kind of small unfairness this product exists to remove.
        </p>

        <h3 className="mt-4 font-display text-lg text-[color:var(--color-ink-900)]">Why the transfer count is minimal</h3>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Every transfer clears at least one outstanding balance and the last clears two, so from{" "}
          <em>n</em> non-zero balances no plan can use fewer than <em>n − 1</em> transfers. The greedy
          pairing always pairs a debtor with a creditor, so it reaches that bound. khata reports the
          count and whether the bound held, so the claim can be checked rather than taken on trust.
        </p>

        <h3 className="mt-4 font-display text-lg text-[color:var(--color-ink-900)]">What the trust score is</h3>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Six weighted factors summing to exactly one: evidence, confirmation, freshness, read
          confidence, rate discipline and dispute load. The Settle page shows each one&apos;s weight,
          the quantity it measured and the sentence explaining it, so the score can be audited. It
          is not a judgement about the people — only about how well the book is written down.
        </p>

        <h3 className="mt-4 font-display text-lg text-[color:var(--color-ink-900)]">What is stored</h3>
        <ul className="mt-1 space-y-1 text-sm text-[color:var(--color-ink-700)]">
          <li>Ledger lines and their amounts, in a hosted Postgres.</li>
          <li>The original message text, because it is the evidence a line is checked against.</li>
          <li>Sealed audit events — no password, no card number, no document image.</li>
          <li>Nothing else. There is no analytics call, no third-party script and no font loaded from a CDN at runtime except the model weights you choose to download.</li>
        </ul>
      </section>
    </div>
  );
}