import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NewEntryForm } from "./page.client";
import { openSession } from "@/lib/service";

export const metadata: Metadata = {
  title: "Add a line",
  description: "Write one ledger line by hand, converted at the live rate and sealed immediately.",
  alternates: { canonical: "/ledger/new" },
};

export default async function NewEntryPage() {
  const session = await openSession();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/ledger" className="btn btn-quiet">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ledger
      </Link>
      <header className="mb-6 mt-4">
        <p className="rubric">By hand</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Add a line</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          For the payment nobody messaged you about. It goes through exactly the same conversion,
          split and sealing as a line the reader produced — there is no second, cheaper path.
        </p>
      </header>

      <NewEntryForm household={session.household} />
    </div>
  );
}