"use client";

/**
 * The balance beam.
 *
 * This is khata's signature interaction, and it is not decoration. The tilt is
 * the actual imbalance of the household's book:
 *
 *     mustMove = Σ|net_i| / 2          the total that has to change hands
 *     volume   = Σ paid + Σ owed       everything that passed through
 *     skew     = mustMove / volume
 *     angle    = skew × 12°
 *
 * So a beam sitting level is a real claim: every rupee that went out came back
 * in. A beam hanging to one side is also real, and the longer the hang, the more
 * of the household's money is still unresolved.
 *
 * Pressing the stamp does not animate a result — it commits to the engine's
 * minimum-transfer plan and prints the slips. With reduced motion, the beam
 * renders at the same angle with no transition and the stamp is a plain button.
 */

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Stamp } from "lucide-react";
import type { BalanceRow, SettlementResult } from "@/lib/types";
import { amountMinorAsMajor } from "@/lib/format";

const MAX_DEGREES = 12;

export function BalanceBeam({
  settlement,
  onPress,
  busy = false,
}: {
  settlement: SettlementResult;
  onPress: () => void;
  busy?: boolean;
}) {
  const reduce = useReducedMotion();
  const [pressed, setPressed] = useState(false);

  const balances = settlement.balances;
  const mustMove = balances.reduce((a, b) => a + Math.abs(b.netBaseMinor), 0) / 2;
  const volume = balances.reduce((a, b) => a + b.paidBaseMinor + b.shareBaseMinor, 0);
  const skew = volume > 0 ? mustMove / volume : 0;
  const angle = Math.min(MAX_DEGREES, skew * MAX_DEGREES);
  const currency = settlement.baseCurrency;

  // Who sits on which side, and how far out. Position is the member's own
  // fraction of the largest absolute balance, so the picture is a real chart.
  const maxAbs = Math.max(1, ...balances.map((b) => Math.abs(b.netBaseMinor)));
  const maxPaid = Math.max(1, ...balances.map((b) => b.paidBaseMinor));

  const handlePress = () => {
    setPressed(true);
    onPress();
  };

  return (
    <div className="card khata-rules p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-xl text-[color:var(--color-ink-900)]">The beam</h3>
        <p className="rubric">
          tilt = imbalance × {MAX_DEGREES}°
        </p>
      </div>

      <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
        {mustMove === 0
          ? "Level. Every amount that left the household came back, so nobody owes anybody."
          : `${amountMinorAsMajor(mustMove, currency)} ${currency} has not been accounted for yet.`}
      </p>

      {/* The pivot, the beam and one pip per member. */}
      <div className="relative mt-6 h-32 select-none" role="img" aria-label={describeBeam(angle, skew, balances)}>
        {/* Pivot */}
        <div
          aria-hidden="true"
          className="absolute bottom-6 left-1/2 h-8 w-1 -translate-x-1/2 bg-[color:var(--color-ink-900)]"
        />
        <div
          aria-hidden="true"
          className="absolute bottom-2 left-1/2 h-2 w-12 -translate-x-1/2 border-b-2 border-[color:var(--color-ink-900)]"
        />

        <motion.div
          className="absolute bottom-8 left-1/2 h-3 w-[min(100%,26rem)] -translate-x-1/2 origin-bottom bg-[color:var(--color-cloth-700)]"
          style={{ marginLeft: "-2px" }}
          animate={reduce ? undefined : { rotate: angle }}
          initial={false}
          transition={{ type: "spring", stiffness: 120, damping: 18, mass: 0.7 }}
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-px bg-[color:var(--color-madder-500)]"
            style={{ left: "50%" }}
          />
        </motion.div>

        {/* Members, positioned along the beam by their own balance. */}
        {balances.map((b) => {
          const shareOfMax = Math.abs(b.netBaseMinor) / maxAbs;
          const offset = (b.netBaseMinor / maxAbs) * 38; // percent from centre
          const creditor = b.netBaseMinor > 0;
          const square = b.netBaseMinor === 0;
          return (
            <div
              key={b.memberId}
              className="absolute bottom-14 -translate-x-1/2 text-center"
              style={{ left: `calc(50% + ${offset}%)` }}
            >
              <div
                aria-hidden="true"
                className={`mx-auto h-3 w-3 rounded-full border ${
                  square
                    ? "border-[color:var(--color-ink-400)] bg-transparent"
                    : creditor
                      ? "border-[color:var(--color-moss-600)] bg-[color:var(--color-moss-600)]"
                      : "border-[color:var(--color-madder-600)] bg-[color:var(--color-madder-600)]"
                }`}
                style={{ opacity: 0.4 + shareOfMax * 0.6 }}
              />
              <p className="mt-1 max-w-[7rem] truncate text-[11px] leading-tight text-[color:var(--color-ink-700)]">
                {b.name}
              </p>
              <p className="font-data text-[10px] leading-tight text-[color:var(--color-ink-500)]">
                {amountMinorAsMajor(b.netBaseMinor, currency)}
              </p>
            </div>
          );
        })}
      </div>

      {/* The same information as a table, so the beam is never the only way to
          read it and the signature survives with animation off. */}
      <table className="mt-4 w-full border-collapse text-sm">
        <caption className="sr-only">Balances by member, in {currency}</caption>
        <thead>
          <tr className="border-b border-[color:var(--color-madder-600)] text-left">
            <th scope="col" className="rubric py-1">Member</th>
            <th scope="col" className="rubric py-1 text-right">Paid</th>
            <th scope="col" className="rubric py-1 text-right">Owes</th>
            <th scope="col" className="rubric py-1 text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.memberId} className="border-b border-[color:var(--color-rule)]">
              <th scope="row" className="py-1.5 text-left font-normal text-[color:var(--color-ink-900)]">
                {b.name}
              </th>
              <td className="tabular py-1.5 text-right font-data text-[color:var(--color-ink-700)]">
                {amountMinorAsMajor(b.paidBaseMinor, currency)}
              </td>
              <td className="tabular py-1.5 text-right font-data text-[color:var(--color-ink-700)]">
                {amountMinorAsMajor(b.shareBaseMinor, currency)}
              </td>
              <td
                className={`tabular py-1.5 text-right font-data ${
                  b.netBaseMinor > 0
                    ? "text-[color:var(--color-moss-600)]"
                    : b.netBaseMinor < 0
                      ? "text-[color:var(--color-madder-600)]"
                      : "text-[color:var(--color-ink-400)]"
                }`}
              >
                {amountMinorAsMajor(b.netBaseMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="py-1.5 text-[color:var(--color-ink-500)]" colSpan={2}>
              Largest single outlay
            </td>
            <td className="tabular py-1.5 text-right font-data text-[color:var(--color-ink-500)]" colSpan={2}>
              {amountMinorAsMajor(maxPaid, currency)} {currency}
            </td>
          </tr>
        </tfoot>
      </table>

      <button
        type="button"
        className="btn btn-madder mt-5 w-full sm:w-auto"
        onClick={handlePress}
        disabled={busy || settlement.totals.entryCount === 0}
      >
        <Stamp className="h-4 w-4" aria-hidden="true" />
        {busy ? "Stamping…" : "Press the stamp"}
      </button>

      {pressed ? (
        <p className="mt-2 font-data text-xs text-[color:var(--color-moss-600)]" role="status">
          Stamped. The slips below are the engine&apos;s plan, not an illustration.
        </p>
      ) : (
        <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          Pressing the stamp re-runs the engine and writes a settlement event into the household
          seal chain, so the agreement itself is provable.
        </p>
      )}

      <TransferSlips settlement={settlement} />
    </div>
  );
}

function TransferSlips({ settlement }: { settlement: SettlementResult }) {
  if (settlement.transfers.length === 0) {
    return (
      <div className="mt-4 border border-dashed border-[color:var(--color-moss-600)] p-4">
        <p className="text-sm text-[color:var(--color-moss-600)]">
          No transfers. Everyone is square across {settlement.totals.entryCount} line
          {settlement.totals.entryCount === 1 ? "" : "s"}.
        </p>
      </div>
    );
  }

  const nameOf = (id: string) => settlement.balances.find((b) => b.memberId === id)?.name ?? id;

  return (
    <div className="mt-4 space-y-2">
      <p className="rubric">
        {settlement.transferCount} transfer{settlement.transferCount === 1 ? "" : "s"} ·{" "}
        {settlement.minimalTransfers ? "provably the fewest possible" : "minimality unverified"}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {settlement.transfers.map((t, i) => (
          <li
            key={`${t.fromMemberId}-${t.toMemberId}-${i}`}
            className="khata-perf border border-[color:var(--color-rule)] bg-[color:var(--color-rag-50)] py-3 pl-6 pr-3"
          >
            <p className="font-display text-lg text-[color:var(--color-ink-900)]">
              {nameOf(t.fromMemberId)} <span className="text-[color:var(--color-madder-600)]">pays</span>{" "}
              {nameOf(t.toMemberId)}
            </p>
            <p className="tabular font-data text-sm text-[color:var(--color-ink-700)]">
              {amountMinorAsMajor(t.amountBaseMinor, settlement.baseCurrency)} {settlement.baseCurrency}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[color:var(--color-ink-500)]">
        Each transfer clears at least one outstanding balance and the last clears two, so no plan
        can use fewer than {Math.max(0, settlement.balances.filter((b) => b.netBaseMinor !== 0).length - 1)} of
        them. This plan uses {settlement.transferCount}.
      </p>
    </div>
  );
}

function describeBeam(angle: number, skew: number, balances: BalanceRow[]): string {
  const direction =
    Math.abs(angle) < 0.4
      ? "level"
      : angle > 0
        ? "tilted toward the member who is owed"
        : "tilted toward the member who owes";
  const people = balances
    .map((b) => `${b.name} ${b.netBaseMinor > 0 ? "is owed" : b.netBaseMinor < 0 ? "owes" : "is square"}`)
    .join(", ");
  return `A beam ${direction} at ${angle.toFixed(1)} degrees, from an imbalance ratio of ${(skew * 100).toFixed(1)} percent. ${people}.`;
}