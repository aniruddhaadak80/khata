import type { Metadata } from "next";
import { SettingsPanel } from "@/components/settings-panel";
import { getCpiSnapshot, getFxSnapshot } from "@/lib/fx";
import { openSession } from "@/lib/service";

export const metadata: Metadata = {
  title: "Settings",
  description:
    "Who is in the household, what currency the book is kept in, where the outside numbers came from, and the method in plain words.",
  alternates: { canonical: "/settings" },
};

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await openSession();
  const fx = await getFxSnapshot(session.household.baseCurrency);
  const cpi = await getCpiSnapshot(session.household.countryCode);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">Configuration</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Settings</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          Everything about this book, in one place: who is in it, what it is kept in, where the
          outside numbers came from, and the method in plain words.
        </p>
      </header>

      <SettingsPanel household={session.household} fx={fx} cpi={cpi} />
    </div>
  );
}