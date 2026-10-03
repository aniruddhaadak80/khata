"use client";

/**
 * Integrity replay.
 *
 * Recomputes every per-entity SHA-384 chain and reports the first broken link.
 * The point of showing the algorithm in plain text next to the result is that a
 * verification tool which will not say how it verifies is asking for trust
 * instead of earning it.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { formatStamp } from "@/lib/format";
import { Seal } from "./seal";
import { Empty, Failure, Loading, Rubric } from "./states";
import type { VerifyResponse } from "@/lib/client-types";

/**
 * Replay state is keyed by the request that produced it, so `loading` is
 * *derived* rather than a second piece of state that has to be kept in step.
 * The effect therefore only ever calls setState after its await, which is what
 * keeps this from cascading a render on every mount.
 */
interface VerifyState {
  data: VerifyResponse | null;
  error: { message: string; fields?: Record<string, string> } | null;
}

export function VerifyPanel() {
  const [state, setState] = useState<VerifyState>({ data: null, error: null });

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await api.get<VerifyResponse>("/api/verify");
      if (cancelled) return;
      setState({
        data: response.ok ? response.data : null,
        error: response.ok ? null : { message: errorText(response.error), fields: response.error.fields },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const data = state.data;
  const error = state.error;
  const loading = data === null && error === null;
  const recompute = async () => {
    setBusy(true);
    const response = await api.get<VerifyResponse>("/api/verify");
    setState({
      data: response.ok ? response.data : null,
      error: response.ok ? null : { message: errorText(response.error), fields: response.error.fields },
    });
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <section className="card khata-margin p-6 pl-8" aria-labelledby="verify-result">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="rubric">Replay</p>
            {loading && !data ? (
              <p className="mt-1 font-display text-3xl text-[color:var(--color-ink-900)]">Walking the chains…</p>
            ) : data ? (
              <>
                <p
                  className={`mt-1 font-display text-4xl ${
                    data.ok ? "text-[color:var(--color-moss-600)]" : "text-[color:var(--color-madder-600)]"
                  }`}
                >
                  {data.ok ? "Every chain replays clean" : `${data.brokenChains.length} chain${data.brokenChains.length === 1 ? "" : "s"} broken`}
                </p>
                <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
                  {data.chains} chain{data.chains === 1 ? "" : "s"}, {data.events} event{data.events === 1 ? "" : "s"},
                  recomputed at {formatStamp(data.checkedAt)}.
                </p>
              </>
            ) : null}
          </div>
          <button type="button" className="btn btn-quiet" onClick={recompute} disabled={busy}>
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
            Replay again
          </button>
        </div>

        {data ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="rubric">ledger seal</span>
            <code className="break-all font-data text-xs text-[color:var(--color-ink-900)]">{data.ledgerSeal}</code>
          </div>
        ) : null}
      </section>

      {error ? <Failure title="The replay could not run" message={error.message} fields={error.fields} onRetry={recompute} /> : null}

      {loading && !data ? <Loading label="Recomputing every digest…" /> : null}

      {data && data.brokenChains.length > 0 ? (
        <section aria-labelledby="broken">
          <h2 id="broken" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            The first broken links
          </h2>
          <ul className="mt-3 space-y-3">
            {data.brokenChains.map((b) => (
              <li key={b.chainId} className="card border-l-4 border-l-[color:var(--color-madder-600)] p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-[color:var(--color-madder-600)]">
                  <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                  chain {b.chainId}
                </p>
                <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">{b.reason}</p>
                <p className="mt-1 font-data text-xs text-[color:var(--color-ink-500)]">
                  first break at index {b.firstBrokenAt ?? "?"} · event {b.firstBrokenId ?? "?"}
                </p>
                <Link href={`/ledger/${b.chainId}`} className="btn btn-quiet mt-2">
                  Inspect the chain
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data && data.chains === 0 ? (
        <Empty
          title="There is nothing to replay yet."
          action={<Link href="/reader" className="btn btn-primary">Write a line first</Link>}
        >
          A chain starts when the first change is written. Once a line exists, every create, edit,
          decision and delete is sealed, and this page recomputes all of it.
        </Empty>
      ) : null}

      {data && data.chains > 0 && data.ok ? (
        <p className="card flex items-center gap-2 border-l-4 border-l-[color:var(--color-moss-600)] p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 text-[color:var(--color-moss-600)]" aria-hidden="true" />
          Every seal matches. Nothing in this book has been edited after it was written.
        </p>
      ) : null}

      {data ? (
        <>
          <section className="card p-5" aria-labelledby="algorithm">
            <h2 id="algorithm" className="font-display text-2xl text-[color:var(--color-ink-900)]">
              How this is checked
            </h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="rubric">Seal</dt>
                <dd className="mt-0.5 font-data text-[color:var(--color-ink-900)]">{data.algorithm.seal}</dd>
              </div>
              <div>
                <dt className="rubric">Genesis</dt>
                <dd className="mt-0.5 font-data text-[color:var(--color-ink-900)]">{data.algorithm.genesis}</dd>
              </div>
              <div>
                <dt className="rubric">Canonical JSON</dt>
                <dd className="mt-0.5 text-[color:var(--color-ink-700)]">{data.algorithm.canonicalJson}</dd>
              </div>
              <div>
                <dt className="rubric">Order</dt>
                <dd className="mt-0.5 text-[color:var(--color-ink-700)]">{data.algorithm.order}</dd>
              </div>
            </dl>
            <p className="mt-3 max-w-prose text-sm text-[color:var(--color-ink-700)]">
              Canonical JSON sorts object keys recursively because otherwise a harmless refactor that
              reordered two fields would look exactly like tampering, and every replay would fail.
              Ordering breaks ties on the event id because a timestamp alone is not a total order —
              two events written in the same millisecond would otherwise replay differently
              depending on database row order, which would make the replay irreproducible.
            </p>
            {data.truncated ? (
              <p className="mt-2 text-xs text-[color:var(--color-turmeric-500)]">
                This replay covered the most recent {data.events} of {data.available} events. Older
                chains are still sealed; ask for a specific chain to walk all of it.
              </p>
            ) : null}
          </section>

          <section className="card p-5" aria-labelledby="heads">
            <h2 id="heads" className="font-display text-2xl text-[color:var(--color-ink-900)]">
              Chain heads
            </h2>
            <ul className="mt-3 space-y-1">
              {data.heads.map((h) => (
                <li key={h.chainId} className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--color-rule)] py-1.5 text-sm">
                  <Link href={`/ledger/${h.chainId}`} className="truncate font-data text-[color:var(--color-ink-900)] underline decoration-transparent underline-offset-4 hover:decoration-[color:var(--color-madder-600)]">
                    {h.chainId}
                  </Link>
                  <span className="flex items-center gap-2">
                    <span className="rubric">{h.events} event{h.events === 1 ? "" : "s"}</span>
                    <Seal seal={h.headSeal} />
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-5" aria-labelledby="timeline">
            <h2 id="timeline" className="font-display text-2xl text-[color:var(--color-ink-900)]">
              What happened, most recent first
            </h2>
            <ol className="mt-3 space-y-1">
              {data.timeline.map((t, i) => (
                <li key={`${t.chainId}-${t.seal}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--color-rule)] py-1.5 text-sm">
                  <span className="min-w-0">
                    <span className="rubric mr-2">{t.action}</span>
                    <span className="font-data text-xs text-[color:var(--color-ink-500)]">{formatStamp(t.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-data text-[11px] text-[color:var(--color-ink-400)]">prev {t.prevSealShort}</span>
                    <Seal seal={t.seal} />
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}

      <Rubric>Try to break it</Rubric>
      <p className="max-w-prose text-sm leading-relaxed text-[color:var(--color-ink-700)]">
        The replay is deterministic and has unit tests pinned to hand-computed digests, so the
        check is reproducible rather than merely green. If you want to see a chain fail, edit a row
        directly in Postgres and reload this page: the seal stops matching and the page names the
        exact event that changed.
      </p>
    </div>
  );
}