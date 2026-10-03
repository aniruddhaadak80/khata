/**
 * Display formatting.
 *
 * Deliberately **not** a client module.
 *
 * These are pure functions with no state and no browser APIs, and both server
 * and client components need them. An earlier version lived in
 * `src/components/format.ts` with a `"use client"` banner, which made every
 * export a client reference: the read-only statement page is a server
 * component, and calling `formatStamp()` there failed at render time with
 * "Attempted to call formatStamp() from the server but formatStamp is on the
 * client". A shared formatter belongs in `lib`, and a component file that needs
 * no interactivity should not claim to be one.
 */

import { toMajor } from "./money";

/** Format integer minor units the way an account book would. */
export function money(minor: number, currency: string, opts: { sign?: boolean } = {}): string {
  const value = toMajor(Math.abs(minor), currency);
  const digits = currency === "JPY" ? 0 : 2;
  const body = value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (!opts.sign) return `${body} ${currency}`;
  if (minor === 0) return `${body} ${currency}`;
  return `${minor > 0 ? "+" : "−"}${body} ${currency}`;
}

/** Plain number, no currency suffix, for compact places like the beam labels. */
export function amountMinorAsMajor(minor: number, currency: string): string {
  const digits = currency === "JPY" ? 0 : 2;
  return toMajor(Math.abs(minor), currency).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

/** 24050 -> "240.50", for a controlled number input. */
export function minorToInput(minor: number, currency: string): string {
  const digits = currency === "JPY" ? 0 : 2;
  return toMajor(minor, currency).toFixed(digits);
}

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export const CATEGORY_TONE: Record<string, string> = {
  groceries: "text-[color:var(--color-moss-600)]",
  utilities: "text-[color:var(--color-cloth-600)]",
  rent: "text-[color:var(--color-madder-600)]",
  transport: "text-[color:var(--color-turmeric-500)]",
  medicine: "text-[color:var(--color-madder-500)]",
  household: "text-[color:var(--color-ink-700)]",
  fees: "text-[color:var(--color-cloth-600)]",
  other: "text-[color:var(--color-ink-500)]",
};