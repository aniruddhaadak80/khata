/**
 * `GET /api/verify`
 *
 * Replay every per-entity chain and report the first broken link.
 *
 * The chain is per ledger line: each line's history starts from genesis and is
 * independent of every other line's. Replay therefore groups by `chainId`,
 * orders each group into a total order (`createdAt`, then id — timestamps alone
 * are not a total order, and an irreproducible replay would be worthless), and
 * recomputes every seal.
 */

import { NextResponse, type NextRequest } from "next/server";
import { openSession } from "@/lib/service";
import { compareEvents, replayAllChains, shortSeal } from "@/lib/integrity";
import type { AuditEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await openSession();
  const only = request.nextUrl.searchParams.get("chain");
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "500", 10);

  const rows = await session.repository.listAudit(session.ownerId, only ?? undefined);
  const capped = Number.isFinite(limit) && limit > 0 ? limit : 500;
  const events: AuditEvent[] = rows
    .slice()
    .sort(compareEvents)
    .slice(0, capped);

  const result = replayAllChains(events);

  // Replay in the arrival order the routes use for display, so an operator can
  // see the actual sequence rather than a per-chain grouping.
  const timeline = events.slice(-50).reverse();

  return NextResponse.json(
    {
      ok: true,
      data: {
        ok: result.ok,
        chains: result.chains,
        events: result.events,
        truncated: rows.length > events.length,
        available: rows.length,
        ledgerSeal: result.headSeal,
        ledgerSealShort: shortSeal(result.headSeal),
        brokenChains: result.brokenChains,
        heads: result.heads,
        timeline: timeline.map((e) => ({
          chainId: e.chainId,
          action: e.action,
          seal: e.seal,
          sealShort: shortSeal(e.seal),
          prevSealShort: shortSeal(e.prevSeal),
          createdAt: e.createdAt,
        })),
        algorithm: {
          seal: "SHA-384( UTF-8(prevSeal) || canonicalJson(event) )",
          genesis: "96 zeroes",
          canonicalJson: "object keys sorted recursively, arrays in order, non-finite numbers as null",
          order: "createdAt ascending, ties broken by event id",
        },
        checkedAt: new Date().toISOString(),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}