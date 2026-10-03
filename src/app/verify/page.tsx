import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyPanel } from "@/components/verify-panel";
import { Loading } from "@/components/states";

export const metadata: Metadata = {
  title: "Verify",
  description:
    "Replay every per-line SHA-384 seal chain and report the first broken link. The algorithm is printed next to the result.",
  alternates: { canonical: "/verify" },
};

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">The proof</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Verify the book</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          Every create, edit, decision, delete and stamped settlement is sealed into a per-line chain
          of <span className="font-data">SHA-384</span> digests. This page recomputes all of them
          and, if anything no longer matches, names the exact event that changed.
        </p>
      </header>

      <Suspense fallback={<Loading label="Recomputing every digest…" />}>
        <VerifyPanel />
      </Suspense>
    </div>
  );
}