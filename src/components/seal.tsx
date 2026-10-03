import { shortSeal } from "@/lib/integrity";

/**
 * A seal, printed the way a stamp is printed: a madder rectangle, rotated as
 * though it had been hit by hand, with the seal in data type.
 *
 * The full 96-character seal is always available to assistive technology and to
 * anyone who selects the text, even though the visible form is abbreviated.
 */
export function Seal({
  seal,
  label,
  tone = "madder",
  pressed = false,
}: {
  seal: string;
  label?: string;
  tone?: "madder" | "moss" | "ink";
  pressed?: boolean;
}) {
  const colour =
    tone === "moss"
      ? "text-[color:var(--color-moss-600)]"
      : tone === "ink"
        ? "text-[color:var(--color-ink-700)]"
        : "text-[color:var(--color-madder-600)]";

  return (
    <span
      className={`khata-stamp inline-flex items-center gap-1.5 px-2 py-1 text-[10px] ${colour} ${
        pressed ? "khata-press khata-stamp-pressed" : ""
      }`}
    >
      {label ? <span className="opacity-80">{label}</span> : null}
      <span aria-hidden="true">{shortSeal(seal)}</span>
      <span className="sr-only">seal {seal}</span>
    </span>
  );
}