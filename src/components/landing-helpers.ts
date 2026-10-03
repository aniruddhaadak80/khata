/** Small pure helpers the landing page needs, kept out of the component so
 *  they can be imported from anywhere without pulling in a client bundle. */

export function isToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Format integer minor units the way an account book would. */
export function money(minor: number, currency: string): string {
  const factor = currency === "JPY" ? 1 : 100;
  const digits = factor === 1 ? 0 : 2;
  const value = Math.abs(minor) / factor;
  return `${minor < 0 ? "−" : ""}${value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currency}`;
}