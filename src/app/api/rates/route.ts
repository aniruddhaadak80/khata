/**
 * `GET /api/rates` — live external data, normalised and honestly labelled.
 *
 * Returns the ECB rate set and the World Bank consumer price index for the
 * household's currency and country. Every payload carries `status`
 * (`live` | `stale` | `fallback`), `fetchedAt` and `attribution`, because a
 * rate without its as-of date is a rumour.
 */

import { NextResponse } from "next/server";
import { getCpiSnapshot, getFxSnapshot, rateFor } from "@/lib/fx";
import { openSession } from "@/lib/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await openSession();
  const base = session.household.baseCurrency;

  const fx = await getFxSnapshot(base);
  const cpi = await getCpiSnapshot(session.household.countryCode);

  return NextResponse.json(
    {
      ok: true,
      data: {
        fx,
        cpi,
        /** The rate that would be used to convert a line in `currency`. */
        rateFor: (currency: string) => rateFor(fx, currency),
        baseCurrency: base,
        countryCode: session.household.countryCode,
      },
    },
    {
      // Short shared cache: enough to survive a burst of page views, short
      // enough that "today's rate" stays honest.
      headers: { "cache-control": "private, max-age=300" },
    },
  );
}