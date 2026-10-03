"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { site } from "@/config/site";
import { GitHubMark } from "./github-mark";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="khata-cloth on-cloth sticky top-0 z-50 border-b border-[color-mix(in_srgb,var(--color-cloth-400)_30%,transparent)]">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="group flex shrink-0 items-baseline gap-2 text-[color:var(--color-rag-50)]">
          <span className="font-display text-2xl leading-none tracking-tight">khata</span>
          <span className="rubric hidden text-[color:var(--color-turmeric-300)] sm:inline">ledger</span>
        </Link>

        <nav aria-label="Primary" className="ml-auto hidden lg:block">
          <ul className="flex items-center gap-1">
            {site.nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  className={`rounded-sm px-2.5 py-1.5 text-sm transition-colors ${
                    isActive(pathname, item.href)
                      ? "bg-[color-mix(in_srgb,var(--color-cloth-400)_20%,transparent)] text-[color:var(--color-rag-50)] underline decoration-[color:var(--color-madder-500)] underline-offset-[6px]"
                      : "text-[color:var(--color-cloth-400)] hover:text-[color:var(--color-rag-50)]"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <a
          href={site.repo.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-quiet ml-auto hidden shrink-0 sm:inline-flex lg:ml-3"
          aria-label={`${site.repo.cta} — ${site.repo.owner}/${site.repo.name}, opens in a new tab`}
        >
          <GitHubMark className="h-4 w-4" aria-hidden="true" />
          {site.repo.cta}
        </a>

        <button
          type="button"
          className="btn btn-quiet ml-auto shrink-0 lg:hidden"
          aria-expanded={open}
          aria-controls="khata-mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </div>

      {open ? (
        <div id="khata-mobile-nav" className="border-t border-[color-mix(in_srgb,var(--color-cloth-400)_24%,transparent)] lg:hidden">
          <nav aria-label="Mobile" className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
            <ul className="grid grid-cols-2 gap-1">
              {site.nav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={close}
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                    className={`block rounded-sm px-3 py-2.5 text-sm ${
                      isActive(pathname, item.href)
                        ? "bg-[color-mix(in_srgb,var(--color-cloth-400)_20%,transparent)] text-[color:var(--color-rag-50)]"
                        : "text-[color:var(--color-cloth-400)]"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <a
              href={site.repo.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              className="btn btn-quiet mt-3 w-full"
              aria-label={`${site.repo.cta} — ${site.repo.owner}/${site.repo.name}, opens in a new tab`}
            >
              <GitHubMark className="h-4 w-4" aria-hidden="true" />
              {site.repo.cta}
            </a>
          </nav>
        </div>
      ) : null}
    </header>
  );
}