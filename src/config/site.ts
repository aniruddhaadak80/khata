/**
 * Single site configuration.
 *
 * The repository URL and the production URL are declared here once and read
 * from here everywhere: the shared header, the mobile menu, the landing CTA,
 * the shared footer, the OpenGraph metadata, the sitemap and `public/mcp.json`.
 * Nothing else in the codebase hard-codes a repository or deployment URL.
 */

export const site = {
  name: "khata",
  /** Used in <title> and the masthead. */
  title: "khata",
  tagline: "The household ledger that reads your messages and settles the fewest times.",
  description:
    "khata turns the messy payment messages a shared home actually produces into a real ledger, " +
    "runs an open-weight model in your own browser to decide which way each payment moved, settles " +
    "up in the fewest possible transfers, and seals every line so nobody has to take your word for it.",

  /**
   * Canonical production origin. `SITE_URL` overrides it at build time so a
   * preview deployment does not advertise the production alias.
   */
  url: process.env.SITE_URL?.replace(/\/$/, "") ?? "https://khata-ai.vercel.app",

  repo: {
    owner: "aniruddhaadak80",
    name: "khata",
    url: "https://github.com/aniruddhaadak80/khata",
    /** Label reused by the header, the landing CTA and the footer. */
    cta: "Star on GitHub",
    source: "View source",
    issues: "https://github.com/aniruddhaadak80/khata/issues",
  },

  nav: [
    { href: "/reader", label: "Reader" },
    { href: "/ledger", label: "Ledger" },
    { href: "/settle", label: "Settle" },
    { href: "/export", label: "Export" },
    { href: "/verify", label: "Verify" },
    { href: "/agent", label: "Agent" },
    { href: "/settings", label: "Settings" },
  ],

  /**
   * The person this was built for. Named in the landing copy and in the README,
   * because the challenge asked for one real person and not a persona sketch.
   */
  dedication: {
    name: "Arunima Adak",
    note: "Built for my sister, who shares a flat and loses the thread of who paid for what.",
  },

  /** The open-weight model that runs in the visitor's browser. */
  model: {
    id: "Xenova/mobilebert-uncased-mnli",
    label: "MobileBERT NLI, int8",
    approxBytes: 28_000_000,
    license: "Apache-2.0",
  },

  /** The local Ollama model offered when a daemon is detected. */
  ollamaModel: "gemma3:1b",

  engineVersion: "khata-engine/1.0.0",

  license: "MIT",
} as const;

export type NavItem = (typeof site.nav)[number];

/** Absolute URL for a site-relative path, honouring the configured origin. */
export function absoluteUrl(path: string): string {
  return `${site.url}${path.startsWith("/") ? path : `/${path}`}`;
}