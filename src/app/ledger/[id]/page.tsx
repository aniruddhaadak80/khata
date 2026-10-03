import type { Metadata } from "next";
import { EntryDetail } from "@/components/entry-detail";
import { openSession } from "@/lib/service";

export const metadata: Metadata = {
  title: "One line",
  description: "One ledger line: the message it came from, who bears it, and its full seal chain.",
};

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await openSession();

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <EntryDetail id={id} baseCurrency={session.household.baseCurrency} />
    </div>
  );
}