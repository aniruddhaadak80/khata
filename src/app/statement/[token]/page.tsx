import type { Metadata } from "next";
import Link from "next/link";
import { resolveStatement } from "@/lib/service";
import { shareTokenSchema } from "@/lib/validation";
import { shortSeal } from "@/lib/integrity";
import { CATEGORY_LABELS } from "@/lib/types";
import { toMajor, currencyExponent } from "@/lib/money";
import { formatDate, formatStamp, money } from "@/lib/format";
import { GitHubMark } from "@/components/github-mark";
import { site } from "@/config/site";

export const dynamic = "force-dynamic";

/**
 * Never index a statement. It contains real names and real amounts, reachable by
 * an unguessable URL — which is exactly the kind of page a crawler must not be
 * invited to.
 */
export const metadata: Metadata = {
  title: "Settlement statement",
  robots: { index: false, follow: false, nocache: true },
};

function invalidPage(message: string) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl text-[color:var(--color-ink-900)]">This statement is not available</h1>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--color-ink-700)]">{message}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/" className="btn btn-primary">Open khata</Link>
        <a
          href={site.repo.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-quiet"
          aria-label={`${site.repo.cta} — ${site.repo.owner}/${site.repo.name}, opens in a new tab`}
        >
          <GitHubMark className="h-4 w-4" aria-hidden="true" />
          {site.repo.cta}
        </a>
      </div>
    </div>
  );
}

export default async function StatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!shareTokenSchema.safeParse(token).success) {
    return invalidPage("That link is not shaped like a khata statement token, so nothing was looked up.");
  }

  const result = await resolveStatement(token);

  if (result.status === "missing") {
    return invalidPage("No statement exists at this address. It may have been created in a different browser, or the link was never valid.");
  }

  if (result.status === "expired") {
    return invalidPage(
      `This statement link expired at ${formatStamp(result.expiredAt)}. Ask whoever shared it to mint a new one from the Export page.`,
    );
  }

  const { household, entries, settlement, link, fx, cpi } = result;
  const nameOf = (id: string | null) => household.members.find((m) => m.id === id)?.name ?? "Unrecorded";
  const currency = settlement.baseCurrency;
  const digits = currencyExponent(currency);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="khata-cloth on-cloth -mx-4 -mt-10 px-4 py-10 sm:-mx-6 sm:px-6">
        <p className="rubric text-[color:var(--color-turmeric-300)]">
          {link.label || "Settlement statement"} · read only
        </p>
        <h1 className="mt-2 font-display text-4xl text-[color:var(--color-rag-50)]">{household.name}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-cloth-400)]">
          {settlement.headline} This page cannot be edited and expires {formatStamp(link.expiresAt)}.
        </p>
      </header>

      <div className="mt-8 space-y-6">
        <section className="card khata-margin p-6 pl-8" aria-labelledby="who">
          <h2 id="who" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            Who pays whom
          </h2>
          {settlement.transfers.length === 0 ? (
            <p className="mt-2 text-sm text-[color:var(--color-moss-600)]">
              Everyone is square across {settlement.totals.entryCount} line
              {settlement.totals.entryCount === 1 ? "" : "s"}. Nothing to transfer.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-2">
                {settlement.transfers.map((t, i) => (
                  <li key={`${t.fromMemberId}-${t.toMemberId}-${i}`} className="khata-perf border border-[color:var(--color-rule)] py-3 pl-6 pr-3">
                    <p className="font-display text-lg text-[color:var(--color-ink-900)]">
                      {nameOf(t.fromMemberId)} pays {nameOf(t.toMemberId)}
                    </p>
                    <p className="tabular font-data text-sm text-[color:var(--color-ink-700)]">
                      {money(t.amountBaseMinor, currency)}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
                {settlement.transferCount} transfer{settlement.transferCount === 1 ? "" : "s"},{" "}
                {settlement.minimalTransfers ? "the fewest the current balances allow" : "minimality unverified"}.
              </p>
            </>
          )}
        </section>

        <section className="card p-5" aria-labelledby="balances">
          <h2 id="balances" className="font-display text-2xl text-[color:var(--color-ink-900)]">Balances</h2>
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[color:var(--color-madder-600)] text-left">
                <th scope="col" className="rubric py-1">Member</th>
                <th scope="col" className="rubric py-1 text-right">Paid</th>
                <th scope="col" className="rubric py-1 text-right">Owes</th>
                <th scope="col" className="rubric py-1 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {settlement.balances.map((b) => (
                <tr key={b.memberId} className="border-b border-[color:var(--color-rule)]">
                  <th scope="row" className="py-2 text-left font-normal text-[color:var(--color-ink-900)]">{b.name}</th>
                  <td className="tabular py-2 text-right font-data text-[color:var(--color-ink-700)]">{money(b.paidBaseMinor, currency)}</td>
                  <td className="tabular py-2 text-right font-data text-[color:var(--color-ink-700)]">{money(b.shareBaseMinor, currency)}</td>
                  <td className={`tabular py-2 text-right font-data ${b.netBaseMinor > 0 ? "text-[color:var(--color-moss-600)]" : b.netBaseMinor < 0 ? "text-[color:var(--color-madder-600)]" : "text-[color:var(--color-ink-400)]"}`}>
                    {money(b.netBaseMinor, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between border-b border-[color:var(--color-rule)] pb-1">
              <dt className="text-[color:var(--color-ink-700)]">Money out</dt>
              <dd className="tabular font-data text-[color:var(--color-ink-900)]">{money(settlement.totals.outflowBaseMinor, currency)}</dd>
            </div>
            <div className="flex justify-between border-b border-[color:var(--color-rule)] pb-1">
              <dt className="text-[color:var(--color-ink-700)]">Money in</dt>
              <dd className="tabular font-data text-[color:var(--color-ink-900)]">{money(settlement.totals.inflowBaseMinor, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="font-medium text-[color:var(--color-ink-900)]">Net spent</dt>
              <dd className="tabular font-data text-[color:var(--color-ink-900)]">{money(settlement.totals.netSpendBaseMinor, currency)}</dd>
            </div>
          </dl>
        </section>

        <section className="card p-5" aria-labelledby="score">
          <h2 id="score" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            How well the book is written down
          </h2>
          <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
            A trust score of {settlement.score}/100 over {settlement.windowDays} days. It measures the
            bookkeeping, not the people.
          </p>
          <ul className="mt-3 space-y-2">
            {settlement.factors.map((f) => (
              <li key={f.id}>
                <div className="flex justify-between text-sm">
                  <span className="text-[color:var(--color-ink-900)]">{f.label}</span>
                  <span className="tabular font-data text-xs text-[color:var(--color-ink-500)]">
                    weight {f.weight} · {(f.normalized * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-xs text-[color:var(--color-ink-700)]">{f.evidence}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="card khata-rules p-5" aria-labelledby="lines">
          <h2 id="lines" className="font-display text-2xl text-[color:var(--color-ink-900)]">Every line</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[color:var(--color-madder-600)] text-left">
                  <th scope="col" className="rubric py-1">Date</th>
                  <th scope="col" className="rubric py-1">Way</th>
                  <th scope="col" className="rubric py-1 text-right">Amount</th>
                  <th scope="col" className="rubric py-1 text-right">In {currency}</th>
                  <th scope="col" className="rubric py-1">Paid by</th>
                  <th scope="col" className="rubric py-1">Category</th>
                  <th scope="col" className="rubric py-1">Agreed</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-[color:var(--color-rule)]">
                    <td className="tabular py-1.5 font-data text-xs text-[color:var(--color-ink-500)]">{formatDate(e.occurredOn)}</td>
                    <td className={`py-1.5 font-data text-xs ${e.direction === "outflow" ? "text-[color:var(--color-madder-600)]" : "text-[color:var(--color-moss-600)]"}`}>
                      {e.direction === "outflow" ? "out" : "in"}
                    </td>
                    <td className="tabular py-1.5 text-right font-data text-xs text-[color:var(--color-ink-900)]">
                      {toMajor(e.amountMinor, e.currency).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })} {e.currency}
                    </td>
                    <td className="tabular py-1.5 text-right font-data text-xs text-[color:var(--color-ink-900)]">
                      {toMajor(e.amountBaseMinor, currency).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}
                    </td>
                    <td className="py-1.5 text-xs text-[color:var(--color-ink-700)]">{nameOf(e.paidBy)}</td>
                    <td className="py-1.5 text-xs text-[color:var(--color-ink-700)]">{CATEGORY_LABELS[e.category]}</td>
                    <td className="py-1.5 text-xs text-[color:var(--color-ink-500)]">{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card p-5" aria-labelledby="provenance">
          <h2 id="provenance" className="font-display text-2xl text-[color:var(--color-ink-900)]">Provenance</h2>
          <ul className="mt-3 space-y-2 text-sm text-[color:var(--color-ink-700)]">
            <li>
              Exchange rates: {fx.attribution} Status <strong>{fx.status}</strong>, as of {fx.asOf}, via {fx.provider}.
            </li>
            {cpi ? (
              <li>
                Consumer prices: {cpi.attribution} Status <strong>{cpi.status}</strong>
                {cpi.lastUpdated ? `, last updated ${cpi.lastUpdated}` : ""}.
              </li>
            ) : null}
            <li>
              Computed {formatStamp(settlement.computedAt)} by {settlement.engine} {settlement.version}.
            </li>
          </ul>

          <div className="mt-4 border border-[color:var(--color-rule)] bg-[color:var(--color-ink-900)] p-4">
            <p className="rubric text-[color:var(--color-turmeric-300)]">Seal at the moment this link was minted</p>
            <p className="mt-1 break-all font-data text-xs text-[color:var(--color-rag-100)]">{link.seal}</p>
            <p className="mt-2 font-data text-[10px] text-[color:var(--color-cloth-400)]">
              short form {shortSeal(link.seal)}
            </p>
          </div>

          <p className="mt-3 text-sm text-[color:var(--color-ink-700)]">
            Anyone can replay this book&apos;s chains and check them against that seal. The{" "}
            <Link href="/verify" className="underline underline-offset-4">verify page</Link> prints the
            algorithm it uses.
          </p>
        </section>

        <section className="card p-5" aria-labelledby="note">
          <h2 id="note" className="font-display text-2xl text-[color:var(--color-ink-900)]">What this is</h2>
          <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-ink-700)]">
            A bookkeeping record of what people in one household said happened, plus the arithmetic
            between those statements. It is not a financial judgement and not a debt collection
            notice. If you think a line here is wrong, the raw message behind it is kept on the owner&apos;s
            own ledger, and they can correct it — which changes this statement.
          </p>
          <a
            href={site.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-quiet mt-4"
            aria-label={`${site.repo.cta} — ${site.repo.owner}/${site.repo.name}, opens in a new tab`}
          >
            <GitHubMark className="h-4 w-4" aria-hidden="true" />
            {site.repo.cta}
          </a>
        </section>
      </div>
    </div>
  );
}