"use client";

/**
 * The settlement view: the beam, the factors, the flags, and what to do next.
 *
 * Every number on this page comes out of `analyseSettlement` in
 * `src/lib/engine.ts`. Nothing is recomputed here, and the factors are shown
 * with their weights and their measured quantities so the score can be
 * audited rather than believed.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { formatStamp, money } from "@/lib/format";
import { BalanceBeam } from "./balance-beam";
import { Seal } from "./seal";
import { Empty, Failure, Loading, Rubric } from "./states";
import type { SettlementResponse } from "@/lib/client-types";
import type { FlagSeverity } from "@/lib/types";

const WINDOWS = [7, 30, 90, 365];

const SEVERITY_ICON: Record<FlagSeverity, typeof Info> = {
  info: Info,
  warn: TriangleAlert,
  critical: AlertTriangle,
};

const SEVERITY_TONE: Record<FlagSeverity, string> = {
  info: "border-l-[color:var(--color-ink-400)]",
  warn: "border-l-[color:var(--color-turmeric-500)]",
  critical: "border-l-[color:var(--color-madder-600)]",
};

export function SettlePanel({ initialWindow = 30 }: { initialWindow?: number }) {
  const [windowDays, setWindowDays] = useState(initialWindow);
  const [state, setState] = useState<{
    data: SettlementResponse | null;
    error: { message: string; fields?: Record<string, string> } | null;
  }>({ data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const [stamping, setStamping] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * The window is part of the request key, so changing it refetches, and the
   * result is stored against the key that produced it. `loading` and `data` are
   * therefore derived rather than two pieces of state that must be kept in step,
   * which is also what keeps the effect from cascading a render.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await api.get<SettlementResponse>(`/api/settlement?windowDays=${windowDays}`);
      if (cancelled) return;
      setState({
        data: response.ok ? response.data : null,
        error: response.ok ? null : { message: errorText(response.error), fields: response.error.fields },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays, nonce]);

  const data = state.data;
  const error = state.error;
  const loading = data === null && error === null;
  const recompute = () => setNonce((n) => n + 1);

  /**
   * Writing the settlement into the chain.
   *
   * A real mutation: `POST /api/settlement` re-runs the engine through the same
   * service layer everything else uses and appends a sealed `settlement.stamp`
   * event, so "we agreed this is what we owe" is itself provable and dated.
   */
  const stamp = useCallback(async () => {
    setStamping(true);
    setFlash(null);
    const response = await api.post<{ sealShort: string; transferCount: number; score: number }>(
      "/api/settlement",
      { windowDays },
    );
    if (response.ok) {
      setFlash(
        `Settlement sealed ${response.data.sealShort}: ${response.data.transferCount} transfer${
          response.data.transferCount === 1 ? "" : "s"
        } at a trust score of ${response.data.score}. Replay it on the Verify page, or send the statement from Export.`,
      );
      recompute();
    } else {
      setState((prev) => ({
        ...prev,
        error: { message: errorText(response.error), fields: response.error.fields },
      }));
    }
    setStamping(false);
  }, [windowDays]);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3" aria-label="Window">
        <div>
          <Rubric>Window</Rubric>
          <div className="mt-1 flex flex-wrap gap-2">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`btn ${windowDays === w ? "btn-primary" : "btn-quiet"}`}
                onClick={() => setWindowDays(w)}
                aria-pressed={windowDays === w}
              >
                {w === 365 ? "A year" : `${w} days`}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-quiet" onClick={recompute} disabled={loading}>
          {loading ? "Recomputing…" : "Recompute"}
        </button>
      </section>

      {flash ? (
        <p className="card border-l-4 border-l-[color:var(--color-moss-600)] p-3 text-sm" role="status">
          {flash} <Link href="/export" className="underline underline-offset-4">Share it</Link>
        </p>
      ) : null}

      {error ? <Failure title="The settlement could not be computed" message={error.message} fields={error.fields} onRetry={recompute} /> : null}

      {loading && !data ? <Loading label="Running the engine…" /> : null}

      {data ? (
        <>
          <header className="card khata-margin p-6 pl-8">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="rubric">{data.settlement.headline}</p>
                <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
                  {data.settlement.fromDate} to {data.settlement.toDate} · {data.settlement.totals.entryCount} line
                  {data.settlement.totals.entryCount === 1 ? "" : "s"} in the window
                </p>
              </div>
              <div className="text-right">
                <p className="font-display text-5xl tabular text-[color:var(--color-ink-900)]">{data.settlement.score}</p>
                <p className="rubric">trust score / 100</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className={`rubric ${
                  data.settlement.verdict === "healthy"
                    ? "text-[color:var(--color-moss-600)]"
                    : data.settlement.verdict === "review"
                      ? "text-[color:var(--color-turmeric-500)]"
                      : "text-[color:var(--color-madder-600)]"
                }`}
              >
                {data.settlement.verdict}
              </span>
              <span className="rubric">engine {data.settlement.version}</span>
              {data.settlement.seal ? <Seal seal={data.settlement.seal} label="household chain" tone="ink" /> : null}
            </div>
          </header>

          {data.settlement.totals.entryCount === 0 ? (
            <Empty
              title="Nothing to settle yet."
              action={<Link href="/reader" className="btn btn-primary">Paste some messages in</Link>}
            >
              The engine ran and returned an empty window. That is a real result, not an error: there
              are no lines dated inside the last {windowDays} days.
            </Empty>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
              <BalanceBeam settlement={data.settlement} onPress={stamp} busy={stamping} />

              <div className="space-y-4">
                <section className="card p-5" aria-labelledby="factors">
                  <h2 id="factors" className="font-display text-2xl text-[color:var(--color-ink-900)]">
                    What the score is made of
                  </h2>
                  <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
                    Six weights that sum to exactly 1. Each shows the quantity it measured, in its own
                    units, and one sentence saying why it reads that way.
                  </p>
                  <ul className="mt-4 space-y-4">
                    {data.settlement.factors.map((f) => (
                      <li key={f.id}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-[color:var(--color-ink-900)]">{f.label}</span>
                          <span className="tabular font-data text-xs text-[color:var(--color-ink-500)]">
                            weight {f.weight} · adds {(f.contribution * 100).toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-1 h-2 w-full bg-[color:var(--color-rag-200)]">
                          <div
                            className="h-2 bg-[color:var(--color-cloth-600)]"
                            style={{ width: `${Math.round(f.normalized * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-[color:var(--color-ink-700)]">{f.evidence}</p>
                        <p className="font-data text-[11px] text-[color:var(--color-ink-400)]">
                          measured {(f.raw * 100).toFixed(1)} {f.unit}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="card p-5" aria-labelledby="totals">
                  <h2 id="totals" className="font-display text-2xl text-[color:var(--color-ink-900)]">The window</h2>
                  <dl className="mt-3 space-y-2 text-sm">
                    <Row label="Money out" value={money(data.settlement.totals.outflowBaseMinor, data.settlement.baseCurrency)} />
                    <Row label="Money in" value={money(data.settlement.totals.inflowBaseMinor, data.settlement.baseCurrency)} />
                    <Row
                      label="Net spent"
                      value={money(data.settlement.totals.netSpendBaseMinor, data.settlement.baseCurrency)}
                      strong
                    />
                    <Row label="Still unconfirmed" value={`${data.settlement.totals.unconfirmedCount}`} />
                    <Row label="Disputed" value={`${data.settlement.totals.disputedCount}`} />
                    <Row label="Foreign-currency lines" value={`${data.settlement.totals.foreignCurrencyCount}`} />
                  </dl>
                </section>
              </div>
            </div>
          )}

          {data.settlement.actions.length > 0 ? (
            <section className="card p-5" aria-labelledby="actions">
              <h2 id="actions" className="font-display text-2xl text-[color:var(--color-ink-900)]">Do this next</h2>
              <ol className="mt-3 space-y-2">
                {data.settlement.actions.map((a, i) => (
                  <li key={a} className="flex gap-3 text-sm text-[color:var(--color-ink-900)]">
                    <span className="tabular shrink-0 font-data text-[color:var(--color-madder-600)]">{i + 1}.</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {data.settlement.flags.length > 0 ? (
            <section aria-labelledby="flags">
              <h2 id="flags" className="font-display text-2xl text-[color:var(--color-ink-900)]">
                Flags
              </h2>
              <ul className="mt-3 space-y-2">
                {data.settlement.flags.map((flag) => {
                  const Icon = SEVERITY_ICON[flag.severity];
                  return (
                    <li
                      key={flag.id}
                      className={`card flex items-start gap-2 border-l-4 p-3 text-sm ${SEVERITY_TONE[flag.severity]}`}
                    >
                      <Icon
                        className={`mt-0.5 h-4 w-4 shrink-0 ${
                          flag.severity === "critical"
                            ? "text-[color:var(--color-madder-600)]"
                            : flag.severity === "warn"
                              ? "text-[color:var(--color-turmeric-500)]"
                              : "text-[color:var(--color-ink-400)]"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="text-[color:var(--color-ink-900)]">
                        {flag.message}{" "}
                        {flag.entryId ? (
                          <Link href={`/ledger/${flag.entryId}`} className="underline underline-offset-4">
                            Open the line
                          </Link>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            <p className="card flex items-center gap-2 border-l-4 border-l-[color:var(--color-moss-600)] p-3 text-sm">
              <CheckCircle2 className="h-4 w-4 text-[color:var(--color-moss-600)]" aria-hidden="true" />
              No flags. Nothing in this window is missing a payer, an amount or a message.
            </p>
          )}

          {/* Provenance */}
          <section className="card p-5" aria-labelledby="provenance">
            <h2 id="provenance" className="font-display text-2xl text-[color:var(--color-ink-900)]">
              Where the numbers came from
            </h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="rubric">
                  Exchange rates · {data.fx.status}
                  {data.fx.status !== "live" ? " — not a live quote" : ""}
                </dt>
                <dd className="mt-0.5 text-[color:var(--color-ink-700)]">
                  {data.fx.attribution} As of {data.fx.asOf}, from {data.fx.provider}.
                </dd>
              </div>
              {data.cpi ? (
                <div>
                  <dt className="rubric">
                    Consumer prices · {data.cpi.status}
                    {data.cpi.lastUpdated ? ` · last updated ${data.cpi.lastUpdated}` : ""}
                  </dt>
                  <dd className="mt-0.5 text-[color:var(--color-ink-700)]">{data.cpi.attribution}</dd>
                </div>
              ) : (
                <div>
                  <dt className="rubric">Consumer prices</dt>
                  <dd className="mt-0.5 text-[color:var(--color-ink-700)]">
                    No series is available for this household&apos;s country.
                  </dd>
                </div>
              )}
              <div>
                <dt className="rubric">Computed</dt>
                <dd className="mt-0.5 text-[color:var(--color-ink-700)]">
                  {formatStamp(data.settlement.computedAt)} by {data.settlement.engine} {data.settlement.version}.
                </dd>
              </div>
            </dl>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--color-rule)] pb-1.5">
      <dt className={strong ? "font-medium text-[color:var(--color-ink-900)]" : "text-[color:var(--color-ink-700)]"}>
        {label}
      </dt>
      <dd className={`tabular font-data ${strong ? "text-[color:var(--color-ink-900)]" : "text-[color:var(--color-ink-700)]"}`}>
        {value}
      </dd>
    </div>
  );
}