import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { absoluteUrl, site } from "@/config/site";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

/**
 * Three faces, each with a job.
 *
 * Newsreader — an old-style serif with old-style figures, so the money in this
 * book reads like an account book rather than like a dashboard.
 * Anek Latin — a humanist grotesque designed alongside Devanagari, so an
 * Indian household name renders properly instead of being transliterated badly.
 * Azeret Mono — wide, geometric and uncommon, for seals, hashes and dates.
 *
 * Self-hosted rather than fetched from `next/font/google`, for three reasons:
 *
 *   1. It works with no network. `next/font/google` reaches out to Google's CDN
 *      the first time a page is compiled or rendered, which is exactly the
 *      dependency a "keep the household's data on your machine" product should
 *      not have.
 *   2. Three families in one `next/font/google` call chain breaks the dev
 *      server's font import map in Next 16 ("next/font/google queries have
 *      exactly one entry"), which made `npm run dev` fail outright.
 *   3. No third-party request at runtime, so the README's claim of no
 *      third-party script is actually true.
 *
 * All three are SIL Open Font License, which permits redistribution. The files
 * are the latin subset Google serves, so they cover the whole product.
 */
const newsreader = localFont({
  src: "./fonts/newsreader-latin.woff2",
  variable: "--font-newsreader",
  display: "swap",
  weight: "400 700",
  style: "normal",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

const anek = localFont({
  src: "./fonts/aneklatin-latin.woff2",
  variable: "--font-anek",
  display: "swap",
  weight: "400 700",
  style: "normal",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const azeret = localFont({
  src: "./fonts/azeretmono-latin.woff2",
  variable: "--font-azeret",
  display: "swap",
  weight: "400 500",
  style: "normal",
  fallback: ["ui-monospace", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} — ${site.tagline}`,
    template: `%s · ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  authors: [{ name: site.repo.owner, url: `https://github.com/${site.repo.owner}` }],
  creator: site.repo.owner,
  publisher: site.repo.owner,
  keywords: [
    "household ledger",
    "shared expenses",
    "expense splitting",
    "settlement",
    "open-weight model",
    "transformers.js",
    "local-first",
    "MCP",
    "Next.js",
    "Neon Postgres",
  ],
  alternates: { canonical: absoluteUrl("/") },
  openGraph: {
    type: "website",
    url: absoluteUrl("/"),
    siteName: site.name,
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
    locale: "en_GB",
  },
  twitter: {
    card: "summary_large_image",
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
    creator: "@aniruddhaadak",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  category: "productivity",
};

export const viewport: Viewport = {
  themeColor: "#131f3f",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${anek.variable} ${azeret.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}