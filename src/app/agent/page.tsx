import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentConsole } from "@/components/agent-console";
import { openSession } from "@/lib/service";
import { Loading } from "@/components/states";

export const metadata: Metadata = {
  title: "Agent",
  description:
    "A live MCP-style JSON-RPC 2.0 console: initialize, tools/list and tools/call against the same service layer the interface uses, with the raw wire visible.",
  alternates: { canonical: "/agent" },
};

export default async function AgentPage() {
  const session = await openSession();
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <p className="rubric">The proof, again</p>
        <h1 className="mt-1 font-display text-4xl text-[color:var(--color-ink-900)]">Agent console</h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[color:var(--color-ink-700)]">
          Eleven typed tools over one shared service layer: four that read, two that analyse, and five
          that write. The writing ones are not special-cased — they call the same functions this page
          of the interface calls, which is the only way &ldquo;the agent and the app agree&rdquo; stays
          true as both change.
        </p>
      </header>

      <Suspense fallback={<Loading label="Opening the console…" />}>
        <AgentConsole household={session.household} />
      </Suspense>
    </div>
  );
}