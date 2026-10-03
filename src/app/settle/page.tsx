import type { Metadata } from "next";
import { Suspense } from "react";
import { SettlePanel } from "@/components/settle-panel";
import { Loading } from "@/components/states";

export const metadata: Metadata = {
  title: "Settle",
  description:
    "Who pays whom, in the fewest possible transfers, with every factor of the trust score shown alongside the quantity it measured.",
  alternates: { canonical: "/settle" },
};

export default function SettlePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">Step three</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Settle up</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          One deterministic function answers both questions: who owes whom, and how few payments
          settle it. The beam tilts by the book&apos;s real imbalance, and the factors are shown with
          their weights so the score can be audited.
        </p>
      </header>

      <Suspense fallback={<Loading label="Running the engine…" />}>
        <SettlePanel />
      </Suspense>
    </div>
  );
}