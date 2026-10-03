import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Cpu, Hash, Scale, ShieldCheck } from "lucide-react";
import { site } from "@/config/site";
import { GitHubMark } from "@/components/github-mark";
import { Seal } from "@/components/seal";
import { openSession } from "@/lib/service";
import { shortSeal } from "@/lib/integrity";
import { isToday } from "@/components/landing-helpers";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
    alternates: { canonical: "/" },
  };
}

const STEPS = [
  {
    href: "/reader",
    label: "Reader",
    body: "Paste the messages that actually arrived. A rule engine reads them instantly with no download, and an open-weight NLI model in your own browser re-decides the directions rules get wrong.",
  },
  {
    href: "/ledger",
    label: "Ledger",
    body: "The book. Every line keeps the message it came from, its currency, the rate captured on the day, and who has agreed it.",
  },
  {
    href: "/settle",
    label: "Settle",
    body: "A beam that tilts by the real imbalance, and a transfer plan provably using the fewest payments the balances allow.",
  },
  {
    href: "/export",
    label: "Export",
    body: "A statement you can download in three formats, or send as a link the other person can check without believing you.",
  },
];

const PROMISES = [
  {
    icon: Cpu,
    title: "The model runs on your machine",
    body: `MobileBERT NLI, int8, from ${site.model.id}. Downloaded once into your browser's cache and executed through onnxruntime-web. No API key exists in this project. After the first load it works with the network switched off.`,
  },
  {
    icon: Scale,
    title: "The arithmetic is exact",
    body: "Amounts are integer minor units. Splits use the largest-remainder method, so three ways always sums to the whole exactly — no stray paise to argue about.",
  },
  {
    icon: Hash,
    title: "Every change is sealed",
    body: "Per line, a chain of SHA-384 over canonical JSON. Replay it on the verify page and it names the first event that no longer matches.",
  },
  {
    icon: ShieldCheck,
    title: "Nobody else's book is reachable",
    body: "No accounts, no login. Ownership is an unguessable HTTP-only cookie, and an owner id in a request body is never trusted.",
  },
];

export default async function LandingPage() {
  // The landing page shows a real computed verdict, not a marketing claim. The
  // same engine that powers /settle runs here.
  const session = await openSession();
  const settled = await session.repository.headSeal(session.ownerId, session.household.id);

  return (
    <div>
      {/* Masthead */}
      <section className="khata-cloth on-cloth relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, #fff 0 1px, transparent 1px 3px), repeating-linear-gradient(0deg, #000 0 1px, transparent 1px 4px)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="rubric text-[color:var(--color-turmeric-300)]">
            A shared household ledger · built for {site.dedication.name}
          </p>

          <h1 className="mt-4 max-w-4xl font-display text-5xl leading-[1.05] text-[color:var(--color-rag-50)] sm:text-6xl lg:text-7xl">
            {site.tagline}
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-[color:var(--color-cloth-400)] sm:text-lg">
            A shared home produces a specific, boring, weekly problem: the electricity bill arrives as
            a screenshot, someone paid it, and three weeks later nobody can remember who covered
            what. khata reads the messages, keeps the evidence, works out the shortest way to settle,
            and seals every change so the number can be checked instead of believed.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/reader" className="btn btn-madder">
              Paste a message in <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <Link href="/settle" className="btn btn-quiet">
              See who pays whom
            </Link>
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

          <p className="mt-6 max-w-xl text-xs leading-relaxed text-[color:var(--color-cloth-400)]">
            No account, no key, no install. This book belongs to the browser you are reading it in.
            {site.dedication.note}
          </p>
        </div>
      </section>

      {/* Live state */}
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="card khata-margin grid gap-4 p-6 pl-8 sm:grid-cols-3">
          <div>
            <p className="rubric">Your book</p>
            <p className="mt-1 font-display text-2xl text-[color:var(--color-ink-900)]">{session.household.name}</p>
            <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
              kept in {session.household.baseCurrency} · {session.household.members.length} member
              {session.household.members.length === 1 ? "" : "s"}
            </p>
          </div>
          <div>
            <p className="rubric">Chain</p>
            <p className="mt-1 font-display text-2xl text-[color:var(--color-ink-900)]">
              {shortSeal(settled)}
            </p>
            <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
              {settled === "0".repeat(96)
                ? "At genesis. Write something and it starts."
                : "The current head of this household's chain."}
            </p>
          </div>
          <div>
            <p className="rubric">Today</p>
            <p className="mt-1 font-display text-2xl text-[color:var(--color-ink-900)]">{isToday()}</p>
            <p className="mt-1 text-sm text-[color:var(--color-ink-700)]">
              Rates are fetched live from the European Central Bank via Frankfurter, and labelled
              with their as-of date wherever they appear.
            </p>
          </div>
        </div>
      </section>

      {/* The loop */}
      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6" aria-labelledby="loop">
        <h2 id="loop" className="font-display text-3xl text-[color:var(--color-ink-900)]">
          The whole loop, four pages
        </h2>
        <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.href}>
              <Link href={step.href} className="card khata-perf block h-full p-5 pl-8 hover:bg-[color:var(--color-rag-50)]">
                <p className="tabular font-data text-xs text-[color:var(--color-madder-600)]">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-1 font-display text-xl text-[color:var(--color-ink-900)]">{step.label}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink-700)]">{step.body}</p>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {/* Promises */}
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6" aria-labelledby="promises">
        <h2 id="promises" className="font-display text-3xl text-[color:var(--color-ink-900)]">
          Four things this will not fake
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {PROMISES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card p-5">
              <Icon className="h-5 w-5 text-[color:var(--color-madder-600)]" aria-hidden="true" />
              <h3 className="mt-2 font-display text-xl text-[color:var(--color-ink-900)]">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-ink-700)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Openness */}
      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6" aria-labelledby="open">
        <div className="card khata-cloth on-cloth p-6">
          <h2 id="open" className="font-display text-3xl text-[color:var(--color-rag-50)]">
            Why open, specifically
          </h2>
          <div className="mt-4 grid gap-5 text-sm leading-relaxed text-[color:var(--color-cloth-400)] md:grid-cols-2">
            <div>
              <p>
                A household ledger is one of the few things where a closed API is not just a cost but
                a structural problem. Every message about who paid the gas bill is personal financial
                data about two real people, and a service that reads it does not have to be trusted to
                forget it.
              </p>
              <p className="mt-3">
                Here the reader runs in the page. The messages are not sent to us to be classified —
                they are already in your browser, because you pasted them there.
              </p>
            </div>
            <div>
              <p>
                It also means it works where nothing else would: a laptop on a train with no signal,
                on a holiday where the roaming is off, or in a flat whose broadband is one of the
                things being argued about. The rule engine needs no network at all; the model needs
                only its first download.
              </p>
              <p className="mt-3">
                And it is swappable. The model is one string in{" "}
                <code className="font-data text-[color:var(--color-turmeric-300)]">src/lib/local-model.ts</code>.
                Point it at a different open-weights checkpoint, or swap the in-browser model for a
                local Ollama daemon running{" "}
                <code className="font-data text-[color:var(--color-turmeric-300)]">{site.ollamaModel}</code>, and
                the rest of the product does not change.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Seal seal={settled} label="this book, right now" tone="ink" />
            <Link href="/agent" className="btn btn-quiet">
              Try the agent tools
            </Link>
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
      </section>

      {/* Disclaimer */}
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <p className="max-w-3xl text-sm leading-relaxed text-[color:var(--color-ink-700)]">
          <strong>khata is a bookkeeping tool, not a financial adviser.</strong> It records what people
          in one household tell it and computes the arithmetic between those records. A settlement it
          produces is an agreement between two people, not a judgement about money, and it says
          nothing about whether anyone can afford what they are spending. Amounts shown as converted
          are converted at the exchange rate captured on the day the line was written, not at
          today&apos;s quote.
        </p>
        <p className="mt-3 max-w-3xl text-xs text-[color:var(--color-ink-500)]">
          Exchange rates by the European Central Bank via the Frankfurter API. Consumer prices from
          World Bank Open Data. Model weights from the Hugging Face hub, Apache-2.0. Typography: Newsreader,
          Anek Latin and Azeret Mono, all SIL Open Font License.
        </p>
      </section>
    </div>
  );
}