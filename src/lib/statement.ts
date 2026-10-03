/**
 * Statement rendering.
 *
 * One builder, three outputs (Markdown, CSV, JSON), so the downloadable file,
 * the on-screen statement and the shareable statement can never disagree. Every
 * output carries the source attribution and the seal it was built from —
 * a statement without a seal is just an opinion.
 */

import { CATEGORY_LABELS, type CpiSnapshot, type FxSnapshot, type Household, type LedgerEntry, type SettlementResult } from "./types";
import { currencyExponent, toMajor } from "./money";
import { shortSeal } from "./integrity";

export interface StatementInput {
  household: Household;
  entries: readonly LedgerEntry[];
  settlement: SettlementResult;
  fx: Pick<FxSnapshot, "status" | "asOf" | "provider" | "attribution">;
  cpi: Pick<CpiSnapshot, "status" | "lastUpdated" | "provider" | "attribution"> | null;
  generatedAt: string;
  seal: string;
}

function money(minor: number, currency: string): string {
  const value = toMajor(Math.abs(minor), currency);
  const sign = minor < 0 ? "-" : "";
  return `${sign}${value.toLocaleString("en-IN", { minimumFractionDigits: currencyExponent(currency), maximumFractionDigits: currencyExponent(currency) })} ${currency}`;
}

function memberName(household: Household, id: string | null): string {
  if (!id) return "Unrecorded";
  return household.members.find((m) => m.id === id)?.name ?? id;
}

/** Escape a value for RFC 4180 CSV: quote it, and double any inner quote. */
function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildStatementMarkdown(input: StatementInput): string {
  const { household, entries, settlement, fx, cpi, generatedAt, seal } = input;
  const lines: string[] = [];

  lines.push(`# ${household.name} — settlement statement`);
  lines.push("");
  lines.push(`Generated ${generatedAt} · engine \`${settlement.version}\` · window ${settlement.windowDays} days (${settlement.fromDate} to ${settlement.toDate})`);
  lines.push("");
  lines.push(`**${settlement.headline}**`);
  lines.push("");
  lines.push(`Trust score **${settlement.score}/100** — ${settlement.verdict}.`);
  lines.push("");

  lines.push("## Who pays whom");
  lines.push("");
  if (settlement.transfers.length === 0) {
    lines.push("Everyone is square. Nothing to transfer.");
  } else {
    lines.push("| From | To | Amount |");
    lines.push("| --- | --- | --- |");
    for (const t of settlement.transfers) {
      lines.push(
        `| ${memberName(household, t.fromMemberId)} | ${memberName(household, t.toMemberId)} | ${money(t.amountBaseMinor, settlement.baseCurrency)} |`,
      );
    }
    lines.push("");
    lines.push(
      `That is ${settlement.transferCount} transfer${settlement.transferCount === 1 ? "" : "s"}, the fewest the current balances allow (${settlement.minimalTransfers ? "verified minimal" : "minimality not verified"}).`,
    );
  }
  lines.push("");

  lines.push("## Balances");
  lines.push("");
  lines.push("| Member | Paid | Owes | Net |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const b of settlement.balances) {
    lines.push(
      `| ${b.name} | ${money(b.paidBaseMinor, settlement.baseCurrency)} | ${money(b.shareBaseMinor, settlement.baseCurrency)} | ${money(b.netBaseMinor, settlement.baseCurrency)} |`,
    );
  }
  lines.push("");

  lines.push("## What the score is made of");
  lines.push("");
  lines.push("| Factor | Weight | Reading | Contribution |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const f of settlement.factors) {
    lines.push(`| ${f.label} | ${f.weight} | ${(f.normalized * 100).toFixed(1)}% | ${(f.contribution * 100).toFixed(2)} |`);
  }
  lines.push("");
  lines.push(`Weights sum to ${settlement.factors.reduce((a, f) => a + f.weight, 0).toFixed(4)}.`);
  lines.push("");

  lines.push("## Every line");
  lines.push("");
  lines.push("| Date | Direction | Amount | Base | Paid by | Category | Status | Evidence |");
  lines.push("| --- | --- | ---: | ---: | --- | --- | --- | --- |");
  for (const e of entries) {
    lines.push(
      `| ${e.occurredOn} | ${e.direction} | ${money(e.amountMinor, e.currency)} | ${money(e.amountBaseMinor, settlement.baseCurrency)} | ${memberName(household, e.paidBy)} | ${CATEGORY_LABELS[e.category]} | ${e.status} | ${e.rawText ? "message kept" : e.receiptRef ? `receipt ${e.receiptRef}` : "none"} |`,
    );
  }
  lines.push("");

  if (settlement.flags.length > 0) {
    lines.push("## Flags");
    lines.push("");
    for (const flag of settlement.flags) lines.push(`- **${flag.severity}** ${flag.message}`);
    lines.push("");
  }

  lines.push("## Where the numbers came from");
  lines.push("");
  lines.push(`- Exchange rates: ${fx.attribution} — ${fx.status}, as of ${fx.asOf}.`);
  lines.push(
    `- Consumer prices: ${cpi ? `${cpi.attribution} — ${cpi.status}${cpi.lastUpdated ? `, last updated ${cpi.lastUpdated}` : ""}.` : "No consumer price series is available for this household's country."}`,
  );
  lines.push(`- Everything else was typed in by a person, and every change is sealed.`);
  lines.push("");

  lines.push("## Seal");
  lines.push("");
  lines.push(`\`${seal}\``);
  lines.push("");
  lines.push(
    "Each ledger line carries its own chain of `SHA-384( UTF-8(prevSeal) || canonicalJson(event) )` events, starting from 96 zeroes. Open the Verify page to replay this book and find the first broken link, if any.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("khata is a bookkeeping tool, not a financial adviser. It does not tell you what to buy or whether you can afford it.");
  lines.push("");

  return lines.join("\n");
}

export function buildStatementCsv(input: StatementInput): string {
  const { household, entries, settlement } = input;
  const header = [
    "occurred_on", "direction", "amount", "currency", "fx_rate_to_base", "amount_base",
    "base_currency", "paid_by", "category", "status", "split_mode", "participants",
    "reader", "reader_confidence", "evidence_kept", "receipt_ref", "raw_text", "created_at",
  ];
  const rows = entries.map((e) =>
    [
      e.occurredOn,
      e.direction,
      (toMajor(e.amountMinor, e.currency)).toFixed(currencyExponent(e.currency)),
      e.currency,
      String(e.fxRateToBase),
      (toMajor(e.amountBaseMinor, settlement.baseCurrency)).toFixed(currencyExponent(settlement.baseCurrency)),
      settlement.baseCurrency,
      memberName(household, e.paidBy),
      e.category,
      e.status,
      e.splitMode,
      e.participants.map((p) => memberName(household, p)).join("|"),
      e.parseEngine,
      String(e.parseConfidence),
      e.rawText.trim().length > 0 ? "yes" : "no",
      e.receiptRef ?? "",
      // Newlines inside a cell are handled by csvCell quoting.
      e.rawText,
      e.createdAt,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

export function buildStatementJson(input: StatementInput) {
  const { household, entries, settlement, generatedAt, seal, fx, cpi } = input;
  return {
    format: "khata.statement/1",
    generatedAt,
    seal,
    sealShort: shortSeal(seal),
    household: {
      id: household.id,
      name: household.name,
      baseCurrency: household.baseCurrency,
      countryCode: household.countryCode,
      members: household.members,
    },
    engine: {
      version: settlement.version,
      windowDays: settlement.windowDays,
      fromDate: settlement.fromDate,
      toDate: settlement.toDate,
      score: settlement.score,
      verdict: settlement.verdict,
      factors: settlement.factors,
    },
    balances: settlement.balances,
    transfers: settlement.transfers,
    transferCount: settlement.transferCount,
    minimalTransfers: settlement.minimalTransfers,
    totals: settlement.totals,
    flags: settlement.flags,
    entries,
    provenance: { fx, cpi },
    disclaimer:
      "khata is a bookkeeping tool, not a financial adviser. Figures are reproduced from the household's own records.",
  };
}

export function buildCsvEscapeProbe(): string {
  return csvCell('a "quoted", comma\nand a newline');
}