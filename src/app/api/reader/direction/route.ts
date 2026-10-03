/**
 * `GET  /api/reader/direction` — is the cloud tier offered on this deployment?
 * `POST /api/reader/direction` — ask the hosted model for one line's direction.
 *
 * The GET exists so the interface can decide whether to render the button at
 * all: with no `GEMINI_API_KEY` configured, the tier is not merely broken, it
 * is absent, and the app is the same app that was verified without it.
 *
 * The POST is a thin, honest shell. It rate-limits, validates, calls
 * `cloudDirection`, and maps every failure to a status that says what actually
 * happened — never a fabricated answer, and never the key, which exists only
 * in the server's environment.
 */

import { NextResponse, type NextRequest } from "next/server";
import { openSession } from "@/lib/service";
import { CloudModelError, cloudConfig, cloudDirection } from "@/lib/cloud-model";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import {
  ERROR_CODES,
  cloudDirectionRequestSchema,
  errorEnvelope,
  parseOrEnvelope,
} from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const config = cloudConfig();
  return NextResponse.json(
    {
      ok: true,
      data: {
        ...config,
        runs: config.configured
          ? "on the server, only for the lines the rules left unclear"
          : "not offered: this deployment has no cloud key configured",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const config = cloudConfig();
  if (!config.configured) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.unsupported, "The cloud model is not configured on this deployment."),
      { status: 503 },
    );
  }

  const session = await openSession();
  const throttle = consumeWrite(`${session.ownerId}:${clientIp(request.headers)}`, "cloud-direction");
  if (!throttle.allowed) {
    return NextResponse.json(
      errorEnvelope(ERROR_CODES.rateLimited, `Too many cloud reads. Try again in ${throttle.retryAfterSeconds}s.`),
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

  const parsed = parseOrEnvelope(cloudDirectionRequestSchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  try {
    const answer = await cloudDirection(parsed.value.text);
    return NextResponse.json(
      {
        ok: true,
        data: {
          ...answer,
          engine: "gemini",
          provider: config.provider,
          source: "cloud",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof CloudModelError) {
      const message = err.code === "not-configured"
        ? "The cloud model is not configured on this deployment."
        : err.message;
      return NextResponse.json(errorEnvelope(ERROR_CODES.upstream, message), { status: 503 });
    }
    return NextResponse.json(errorEnvelope(ERROR_CODES.internal, "The cloud model failed unexpectedly."), {
      status: 500,
    });
  }
}
