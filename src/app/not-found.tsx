import Link from "next/link";
import { GitHubMark } from "@/components/github-mark";
import { site } from "@/config/site";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
      <p className="rubric">No such page</p>
      <h1 className="mt-2 font-display text-5xl text-[color:var(--color-ink-900)]">Nothing written here</h1>
      <p className="mt-3 text-base leading-relaxed text-[color:var(--color-ink-700)]">
        khata has seven pages, and this is not one of them. If you followed a ledger link, the line it
        pointed at has probably been removed — removals keep a sealed tombstone so the chain still
        replays, but the line itself is gone.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/" className="btn btn-primary">Home</Link>
        <Link href="/ledger" className="btn btn-quiet">The ledger</Link>
        <Link href="/reader" className="btn btn-quiet">Reader</Link>
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
  );
}