/**
 * `POST /api/share` — mint a read-only statement link.
 *
 * This is the takeaway artifact: a URL that renders the settlement, the
 * balances and the seal for anyone who opens it. There are no accounts, so the
 * only thing protecting the data is the token's unguessability, and the UI says
 * exactly that before the link is created rather than burying it afterwards.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createShareLink, openSession } from "@/lib/service";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { ERROR_CODES, errorEnvelope, parseOrEnvelope, shareCreateSchema } from "@/lib/validation";
import { absoluteUrl } from "@/config/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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
    body = {};
  }

  const parsed = parseOrEnvelope(shareCreateSchema, body ?? {});
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await createShareLink(session, parsed.value.label, parsed.value.days);
  if (!result.ok) return NextResponse.json(result.response, { status: 422 });

  return NextResponse.json(
    {
      ok: true,
      data: {
        path: result.url,
        url: absoluteUrl(result.url),
        expiresAt: result.link.expiresAt,
        label: result.link.label,
        seal: result.link.seal,
        warning:
          "Anyone with this link can read this statement. It contains member names and amounts, so only share it with the person it is about.",
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}