import type { Metadata, Viewport } from "next";
import { Anek_Latin, Azeret_Mono, Newsreader } from "next/font/google";
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
 * All three are SIL Open Font License.
 */
const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-newsreader",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const anek = Anek_Latin({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-anek",
  weight: ["400", "500", "600", "700"],
});

const azeret = Azeret_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-azeret",
  weight: ["400", "500"],
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