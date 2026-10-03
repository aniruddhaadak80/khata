/**
 * `GET   /api/household` — the household this session owns.
 * `PATCH /api/household` — rename it, change the base currency or country, or
 *                           edit the member list.
 *
 * Removing a member who still appears on old lines would leave the engine
 * reporting an unknown participant, so the service reassigns those lines to the
 * first remaining member and seals the change. The response says so in
 * `reassigned`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { openSession, patchHousehold } from "@/lib/service";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { ERROR_CODES, errorEnvelope, householdPatchSchema, parseOrEnvelope } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await openSession();
  const head = await session.repository.headSeal(session.ownerId, session.household.id);
  return NextResponse.json(
    { ok: true, data: { household: session.household, seal: head } },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: NextRequest) {
  const session = await openSession();

  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`);
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.rateLimited, `Too many writes. Try again in ${throttle.retryAfterSeconds}s.`),
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorEnvelope(ERROR_CODES.badRequest, "Request body was not valid JSON."), {
      status: 400,
    });
  }

  const parsed = parseOrEnvelope(householdPatchSchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await patchHousehold(session, parsed.value);
  if (!result.ok) {
    return NextResponse.json(result.response, {
      status: result.response.error.code === ERROR_CODES.notFound ? 404 : 422,
    });
  }

  return NextResponse.json(
    {
      ok: true,
      data: {
        household: result.household,
        reassigned:
          "Any line that referenced a removed member now belongs to the first remaining member, and each such change is sealed.",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}