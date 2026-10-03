import type { Metadata } from "next";
import { Suspense } from "react";
import { LedgerBook } from "@/components/ledger-book";
import { openSession } from "@/lib/service";
import { Loading } from "@/components/states";

export const metadata: Metadata = {
  title: "Ledger",
  description:
    "Every line of the household's ledger: both amounts, the payer, the category, whether the original message was kept, and whether it has been agreed.",
  alternates: { canonical: "/ledger" },
};

export default async function LedgerPage() {
  const session = await openSession();
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">Step two</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">The ledger</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          {session.household.name}, kept in {session.household.baseCurrency}. Filters and order live in
          the address bar, so a filtered view can be bookmarked or pasted to someone else and it will
          survive a refresh.
        </p>
      </header>

      <Suspense fallback={<Loading label="Opening the book…" />}>
        <LedgerBook baseCurrency={session.household.baseCurrency} />
      </Suspense>
    </div>
  );
}