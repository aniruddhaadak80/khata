import type { Metadata } from "next";
import { Suspense } from "react";
import { ReaderConsole } from "@/components/reader-console";
import { openSession } from "@/lib/service";
import { Loading } from "@/components/states";

export const metadata: Metadata = {
  title: "Reader",
  description:
    "Paste the payment messages a shared home actually produces. A rule engine reads them instantly; an open-weight NLI model running in your own browser re-decides the directions rules get wrong.",
  alternates: { canonical: "/reader" },
};

export default async function ReaderPage() {
  const session = await openSession();
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <p className="rubric">Step one</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Reader</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          Paste the UPI SMS, the WhatsApp forward, the note on the back of a receipt. khata splits it
          into candidate lines, shows how sure it is about each field and which words it leaned on,
          and lets you correct anything before a single row is written.
        </p>
      </header>

      <Suspense fallback={<Loading label="Opening the reader…" />}>
        <ReaderConsole household={session.household} />
      </Suspense>
    </div>
  );
}