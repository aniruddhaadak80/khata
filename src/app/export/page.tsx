import type { Metadata } from "next";
import { ExportPanel } from "@/components/export-panel";

export const metadata: Metadata = {
  title: "Export",
  description:
    "Take the statement with you: Markdown, CSV or JSON, or send an unguessable link that renders a read-only statement anyone can check.",
  alternates: { canonical: "/export" },
};

export default function ExportPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">Step four</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Take it with you</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          The point of a ledger is that it can leave the room. Download the statement, or mint a link
          your flatmate can open and check instead of taking your word for it.
        </p>
      </header>

      <ExportPanel />
    </div>
  );
}