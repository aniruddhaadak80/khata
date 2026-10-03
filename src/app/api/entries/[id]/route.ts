/**
 * `GET    /api/entries/[id]` — one line, with its full seal chain.
 * `PATCH  /api/entries/[id]` — edit, decide (confirm / dispute) or re-read.
 * `DELETE /api/entries/[id]` — soft delete.
 *
 * A delete keeps a tombstone row so the line's SHA-384 chain stays replayable:
 * "it existed and was removed" has to remain provable, which is the whole point
 * of a chain. The response says so explicitly in `tombstone`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { deleteEntry, getEntry, openSession, updateEntry } from "@/lib/service";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { replayChain, shortSeal } from "@/lib/integrity";
import { ERROR_CODES, badRequest, errorEnvelope, updateEntrySchema, parseOrEnvelope } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await openSession();
  const entry = await getEntry(session, id);
  if (!entry) {
    return NextResponse.json(errorEnvelope(ERROR_CODES.notFound, "That ledger line does not exist."), {
      status: 404,
    });
  }

  const events = await session.repository.listAudit(session.ownerId, entry.id);
  const replay = replayChain(entry.id, events);

  return NextResponse.json(
    {
      ok: true,
      data: {
        entry,
        chain: {
          events,
          ok: replay.ok,
          checked: replay.checked,
          headSeal: replay.headSeal,
          headSealShort: shortSeal(replay.headSeal),
          firstBrokenAt: replay.firstBrokenAt,
          firstBrokenId: replay.firstBrokenId,
          reason: replay.reason,
        },
        household: session.household,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
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
    return NextResponse.json(badRequest("Request body was not valid JSON."), { status: 400 });
  }

  const parsed = parseOrEnvelope(updateEntrySchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await updateEntry(session, id, parsed.value);
  if (!result.ok) {
    const status = result.response.error.code === ERROR_CODES.notFound ? 404 : 422;
    return NextResponse.json(result.response, { status });
  }

  return NextResponse.json(
    {
      ok: true,
      data: { entry: result.entry, seal: result.seal, sealShort: shortSeal(result.seal) },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = await openSession();

  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`);
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.rateLimited, `Too many writes. Try again in ${throttle.retryAfterSeconds}s.`),
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
    );
  }

  const result = await deleteEntry(session, id);
  if (!result.ok) {
    return NextResponse.json(result.response, { status: 404 });
  }

  const events = await session.repository.listAudit(id);
  const replay = replayChain(id, events);

  return NextResponse.json(
    {
      ok: true,
      data: {
        deleted: true,
        tombstone: {
          kept: true,
          reason:
            "The row is retained with deleted = true so the line's seal chain stays replayable.",
          entryId: id,
        },
        entry: result.entry,
        seal: result.seal,
        sealShort: shortSeal(result.seal),
        chain: { ok: replay.ok, checked: replay.checked, headSeal: replay.headSeal },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}