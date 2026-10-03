/**
 * `POST /api/reader/commit`
 *
 * Commit reader candidates as ledger lines, in one transaction-shaped batch.
 *
 * The candidates may come from the deterministic reader or from the
 * open-weight model in the visitor's browser. Both produce the same shape, so
 * this route does not care which ran — it records the engine on each line, and
 * the line's own audit event carries it into the chain.
 *
 * Partial success is reported honestly: a batch where two of five lines were
 * unreadable returns 201 with the three that were written and the two that were
 * not, each with a reason. Nothing is silently swallowed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { commitCandidates, openSession } from "@/lib/service";
import { CATEGORIES } from "@/lib/types";
import { ERROR_CODES, errorEnvelope, parseOrEnvelope } from "@/lib/validation";
import { clientIp, consumeWrite } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const candidateSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  direction: z.enum(["outflow", "inflow"]),
  amountMinor: z.number().int().positive().max(100_000_000_00),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paidBy: z.string().max(64).nullable(),
  category: z.enum(CATEGORIES).nullable(),
  participants: z.array(z.string().max(64)).max(12).optional(),
  parseEngine: z.enum(["manual", "deterministic", "mobilebert-mnli", "ollama", "agent"]),
  parseConfidence: z.number().min(0).max(1),
  evidence: z.enum(["paste", "sms", "forward", "manual", "agent"]).optional(),
});

const commitSchema = z.object({
  candidates: z.array(candidateSchema).min(1, "nothing to commit").max(50, "50 lines per batch is the limit"),
});

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
    return NextResponse.json(errorEnvelope(ERROR_CODES.badRequest, "Request body was not valid JSON."), {
      status: 400,
    });
  }

  const parsed = parseOrEnvelope(commitSchema, body);
  if (!parsed.ok) return NextResponse.json(parsed.response, { status: 422 });

  const result = await commitCandidates(session, parsed.value.candidates);
  if (!result.ok) return NextResponse.json(result.response, { status: 422 });

  return NextResponse.json(
    {
      ok: true,
      data: {
        created: result.created,
        failed: result.failed,
        summary: {
          requested: parsed.value.candidates.length,
          created: result.created.length,
          failed: result.failed.length,
          engines: [...new Set(result.created.map((e) => e.parseEngine))],
        },
        // No per-line seal lookup here on purpose: it would add one round trip
        // per row to the batch. A line's own page and the verify route both show
        // its seal, and the audit chain is the authority, not this response.
        chainHint: "Every written line has a sealed chain. Open the line, or replay the book on /verify.",
      },
    },
    { status: result.created.length > 0 ? 201 : 422, headers: { "cache-control": "no-store" } },
  );
}