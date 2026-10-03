/**
 * `GET /api/settlement`
 *
 * The engine, over HTTP. Same `analyseSettlement` the interface renders and the
 * `analyse_settlement` MCP tool calls. The response carries the household-level
 * seal so a caller can tie the numbers they are about to show to a specific
 * point in the chain.
 */

import { NextResponse, type NextRequest } from "next/server";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { computeSettlement, openSession, stampSettlement } from "@/lib/service";
import { shortSeal } from "@/lib/integrity";
import { ERROR_CODES, errorEnvelope, parseOrEnvelope, settlementQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await openSession();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());

  const parsed = parseOrEnvelope(settlementQuerySchema, params);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 400 });

  const result = await computeSettlement(session, params);
  if (!result.ok) return NextResponse.json(result.response, { status: 400 });

  return NextResponse.json(
    { ok: true, data: result.value },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * `POST /api/settlement` — press the stamp.
 *
 * Re-runs the engine through the service layer and appends a sealed
 * `settlement.stamp` event to the household chain. This is a real mutation, not
 * an animation: the response carries the new seal.
 */
export async function POST(request: NextRequest) {
  const session = await openSession();

  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`);
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.rateLimited, `Too many writes. Try again in ${throttle.retryAfterSeconds}s.`),
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
    );
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json(errorEnvelope(ERROR_CODES.badRequest, "Request body was not valid JSON."), {
      status: 400,
    });
  }

  const parsed = parseOrEnvelope(settlementQuerySchema, body ?? {});
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await stampSettlement(session, parsed.value.windowDays);
  if (!result.ok) return NextResponse.json(result.response, { status: 422 });

  return NextResponse.json(
    {
      ok: true,
      data: {
        stamped: true,
        seal: result.seal,
        sealShort: shortSeal(result.seal),
        settlement: result.settlement,
        meaning:
          "A settlement.stamp event is now in the household chain carrying these balances, this transfer plan and this score. Replay it on the Verify page.",
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}