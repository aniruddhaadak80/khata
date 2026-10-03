import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Inbox } from "lucide-react";

/** Truthful loading state: says what is being waited for. */
export function Loading({ label }: { label: string }) {
  return (
    <div className="card flex items-center gap-3 p-5" role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin text-[color:var(--color-madder-600)]" aria-hidden="true" />
      <p className="text-sm text-[color:var(--color-ink-700)]">{label}</p>
    </div>
  );
}

/** Truthful empty state: says what would fill it and how to do that. */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card khata-perf flex flex-col items-start gap-3 p-6 pl-8">
      <div className="flex items-center gap-2 text-[color:var(--color-ink-500)]">
        <Inbox className="h-4 w-4" aria-hidden="true" />
        <p className="rubric">Empty</p>
      </div>
      <h3 className="font-display text-xl text-[color:var(--color-ink-900)]">{title}</h3>
      {children ? <div className="max-w-prose text-sm leading-relaxed text-[color:var(--color-ink-700)]">{children}</div> : null}
      {action}
    </div>
  );
}

/**
 * Truthful failure state. Shows the code so the reader can tell a validation
 * refusal from a rate limit from a broken database, and never prints a stack
 * trace or an environment variable.
 */
export function Failure({
  title,
  message,
  fields,
  onRetry,
}: {
  title?: string;
  message: string;
  fields?: Record<string, string>;
  onRetry?: () => void;
}) {
  return (
    <div
      className="card border-l-4 border-l-[color:var(--color-madder-600)] p-5"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-madder-600)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {title ? <h3 className="font-display text-lg text-[color:var(--color-ink-900)]">{title}</h3> : null}
          <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-ink-700)]">{message}</p>
          {fields && Object.keys(fields).length > 0 ? (
            <ul className="mt-2 space-y-1">
              {Object.entries(fields).map(([field, detail]) => (
                <li key={field} className="font-data text-xs text-[color:var(--color-ink-500)]">
                  <span className="text-[color:var(--color-madder-600)]">{field}</span>: {detail}
                </li>
              ))}
            </ul>
          ) : null}
          {onRetry ? (
            <button type="button" className="btn btn-quiet mt-3" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A short, truthful confirmation. */
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" }) {
  const colour =
    tone === "good"
      ? "border-l-[color:var(--color-moss-600)]"
      : tone === "warn"
        ? "border-l-[color:var(--color-turmeric-500)]"
        : "border-l-[color:var(--color-ink-400)]";
  return (
    <div
      className={`card border-l-4 p-3 text-sm ${colour}`}
      role="status"
      aria-live="polite"
    >
      {children}
    </div>
  );
}

/** A section heading in the rubric a ledger would use. */
export function Rubric({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="rubric scroll-mt-24">
      {children}
    </h2>
  );
}