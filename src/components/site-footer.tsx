import Link from "next/link";
import { absoluteUrl, site } from "@/config/site";
import { GitHubMark } from "./github-mark";

const COLUMNS: Array<{ heading: string; links: Array<{ label: string; href: string; external?: boolean }> }> = [
  {
    heading: "The book",
    links: [
      { label: "Reader", href: "/reader" },
      { label: "Ledger", href: "/ledger" },
      { label: "Settle", href: "/settle" },
      { label: "Export", href: "/export" },
    ],
  },
  {
    heading: "Proof",
    links: [
      { label: "Verify the seal", href: "/verify" },
      { label: "Agent console", href: "/agent" },
      { label: "Settings", href: "/settings" },
      { label: "Method", href: "/settings#method" },
    ],
  },
  {
    heading: "Read",
    links: [
      { label: "API reference", href: "/api/health" },
      { label: "MCP manifest", href: "/mcp.json" },
      { label: "Source", href: site.repo.url, external: true },
      { label: "Report an issue", href: site.repo.issues, external: true },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="khata-cloth on-cloth mt-16 border-t border-[color-mix(in_srgb,var(--color-cloth-400)_30%,transparent)]">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <p className="font-display text-3xl text-[color:var(--color-rag-50)]">khata</p>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-[color:var(--color-cloth-400)]">
              A shared household ledger that reads your payment messages, runs an open-weight
              model in your own browser, and settles up in the fewest possible transfers.
            </p>
            <a
              href={site.repo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-quiet mt-5"
              aria-label={`${site.repo.cta} — ${site.repo.owner}/${site.repo.name}, opens in a new tab`}
            >
              <GitHubMark className="h-4 w-4" aria-hidden="true" />
              {site.repo.cta}
            </a>
            <p className="mt-4 text-xs text-[color:var(--color-cloth-400)]">
              MIT licensed. Built for {site.dedication.name}.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="rubric text-[color:var(--color-turmeric-300)]">{column.heading}</h2>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-[color:var(--color-cloth-400)] underline decoration-transparent underline-offset-4 hover:text-[color:var(--color-rag-50)] hover:decoration-[color:var(--color-madder-500)]"
                      >
                        {link.label}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-[color:var(--color-cloth-400)] underline decoration-transparent underline-offset-4 hover:text-[color:var(--color-rag-50)] hover:decoration-[color:var(--color-madder-500)]"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-[color-mix(in_srgb,var(--color-cloth-400)_22%,transparent)] pt-6 text-xs text-[color:var(--color-cloth-400)] sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {site.repo.owner}. Not a financial adviser — a bookkeeping tool.
          </p>
          <p className="font-data">
            <a
              href={absoluteUrl("/verify")}
              className="underline decoration-transparent underline-offset-4 hover:decoration-current"
            >
              {absoluteUrl("/verify")}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}