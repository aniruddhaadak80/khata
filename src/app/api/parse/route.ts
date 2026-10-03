/**
 * `POST /api/parse`
 *
 * The deterministic reader, over HTTP. This is the same `readText` the browser
 * uses for its instant pass and the same one the browser's open-weight model
 * refines, so `curl` and the interface can never disagree about what a message
 * says.
 *
 * The reader returns *every* segment, including the ones it could not read,
 * each with its confidence and the exact substring it leaned on. Silently
 * dropping the unreadable half would be the least trustworthy behaviour
 * available here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { openSession } from "@/lib/service";
import { isoToday, readText, segmentText } from "@/lib/reader";
import { ERROR_CODES, errorEnvelope, parseOrEnvelope, parseRequestSchema } from "@/lib/validation";
import { clientIp, consumeWrite } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const session = await openSession();

  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`, "parse");
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.rateLimited, `Too many reads. Try again in ${throttle.retryAfterSeconds}s.`),
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

  const parsed = parseOrEnvelope(parseRequestSchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const today = parsed.value.today ?? isoToday();
  const memberNames = session.household.members.map((m) => m.name);
  const selfMemberId = session.household.members.find((m) => m.kind === "you")?.id ?? session.household.members[0]?.id ?? "";

  const candidates = readText(parsed.value.text, { today, memberNames, selfMemberId });

  return NextResponse.json(
    {
      ok: true,
      data: {
        engine: "deterministic",
        engineVersion: "khata-reader/1.0.0",
        today,
        segments: segmentText(parsed.value.text).length,
        candidates,
        summary: {
          total: candidates.length,
          ready: candidates.filter((c) => c.ready).length,
          unreadable: candidates.filter((c) => !c.ready).length,
        },
        household: session.household,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}