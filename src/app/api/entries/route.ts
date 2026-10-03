/**
 * `GET  /api/entries` — the ledger, filtered, sorted and paginated.
 * `POST /api/entries` — write one line.
 *
 * Filter, sort and page all live in the query string, so a filtered view can be
 * bookmarked, shared and survived by a refresh. Ownership comes from the
 * session cookie only; an `ownerId` in the body is not accepted, and one in
 * the query string is ignored.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createEntry, openSession, queryEntries } from "@/lib/service";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { ERROR_CODES, createEntrySchema, errorEnvelope, listEntriesQuerySchema, parseOrEnvelope } from "@/lib/validation";
import { shortSeal } from "@/lib/integrity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await openSession();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());

  const parsed = parseOrEnvelope(listEntriesQuerySchema, params);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 400 });

  const { items, total } = await queryEntries(session, parsed.value);
  const page = parsed.value;

  return NextResponse.json(
    {
      ok: true,
      data: {
        items,
        total,
        page: { limit: page.limit, offset: page.offset, returned: items.length },
        household: session.household,
        nextOffset: page.offset + items.length < total ? page.offset + items.length : null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const session = await openSession();

  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`);
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(
        ERROR_CODES.rateLimited,
        `Too many writes. Try again in ${throttle.retryAfterSeconds}s.`,
      ),
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

  const parsed = parseOrEnvelope(createEntrySchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await createEntry(session, parsed.value);
  if (!result.ok) {
    const status = result.response.error.code === ERROR_CODES.notFound ? 404 : 422;
    return NextResponse.json(result.response, { status });
  }

  return NextResponse.json(
    {
      ok: true,
      data: {
        entry: result.entry,
        seal: result.seal,
        sealShort: shortSeal(result.seal),
        fx: { status: result.fx.status, asOf: result.fx.asOf, provider: result.fx.provider },
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}