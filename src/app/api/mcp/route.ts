/**
 * `POST /api/mcp` — a live MCP-style JSON-RPC 2.0 endpoint.
 *
 * Implements `initialize`, `tools/list` and `tools/call`, with the standard
 * error codes (-32700, -32600, -32601, -32602, -32603) and an implemented
 * `notifications/initialized` acknowledgement.
 *
 * Tools, by kind:
 *   read       get_khata_summary, list_entries, get_entry
 *   analysis   analyse_settlement, read_message
 *   mutating   record_entry, decide_entry, delete_entry, export_statement, create_share_link
 *
 * Every mutating tool calls the same `src/lib/service.ts` functions the browser
 * UI calls. There is no agent-only write path, which is what makes "the agent
 * and the app agree" a tested fact rather than an aspiration.
 *
 * Mutating tools accept an `idempotencyKey`, so an agent that retries after a
 * timeout does not double-charge anybody. Scoping is the anonymous session
 * cookie, the same one the UI uses; a client-supplied `scope` argument is only
 * honoured when it matches the real one (compared in constant time).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ENGINE_VERSION } from "@/lib/engine";
import {
  commitCandidates,
  computeSettlement,
  createEntry,
  createShareLink,
  deleteEntry,
  getEntry,
  openSession,
  queryEntries,
  updateEntry,
  type Session,
} from "@/lib/service";
import { readText } from "@/lib/reader";
import { buildStatementJson } from "@/lib/statement";
import { CATEGORIES } from "@/lib/types";
import { scopeMatches } from "@/lib/session";
import { clientIp, consumeWrite } from "@/lib/rate-limit";
import { shortSeal } from "@/lib/integrity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "khata", version: "1.0.0" };

/* -------------------------------------------------------------------------- */
/* JSON-RPC plumbing                                                           */
/* -------------------------------------------------------------------------- */

const JSONRPC = "2.0";

type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: RpcId, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: JSONRPC, id, result });
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: JSONRPC, id, error: { code, message, ...(data ? { data } : {}) } });
}

/* JSON-RPC 2.0 reserved codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/* -------------------------------------------------------------------------- */
/* Tool schemas                                                                */
/* -------------------------------------------------------------------------- */

const str = z.string().min(1);
const memberRef = z.string().max(64);

const TOOLS = [
  {
    name: "get_khata_summary",
    title: "Household summary",
    kind: "read" as const,
    description:
      "The current household: its members, base currency, and how many ledger lines exist. Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_entries",
    title: "List ledger lines",
    kind: "read" as const,
    description:
      "List ledger lines, newest first, with filters for status, direction, category and member. Bounded at 100 rows.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        offset: { type: "integer", minimum: 0, default: 0 },
        status: { type: "string", enum: ["draft", "confirmed", "disputed", "all"], default: "all" },
        direction: { type: "string", enum: ["outflow", "inflow", "all"], default: "all" },
        category: { type: "string", enum: [...CATEGORIES, "all"], default: "all" },
        member: { type: "string", description: "A member id: matches lines they paid or lines charged to them." },
        sort: {
          type: "string",
          enum: ["created_desc", "created_asc", "occurred_desc", "occurred_asc"],
          default: "created_desc",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_entry",
    title: "Inspect one line",
    kind: "read" as const,
    description: "One ledger line plus its full seal chain, replayed.",
    inputSchema: {
      type: "object",
      properties: { id: str },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_message",
    title: "Read a payment message",
    kind: "analysis" as const,
    description:
      "Run the deterministic reader over messy payment text and return candidate ledger lines with a confidence and the exact substring each field came from. Use this before record_entry when the caller has a message rather than structured data.",
    inputSchema: {
      type: "object",
      properties: {
        text: z.string().min(1).max(4000),
        today: { type: "string", description: "YYYY-MM-DD, to resolve 'today' and 'yesterday'. Defaults to today." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "analyse_settlement",
    title: "Who pays whom",
    kind: "analysis" as const,
    description:
      "Run the deterministic settlement engine: balances, a minimum-transfer plan, six weighted trust factors with their evidence, flags and a recommendation. The same function backs the Settle page.",
    inputSchema: {
      type: "object",
      properties: {
        windowDays: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        today: { type: "string", description: "YYYY-MM-DD. Freeze the clock for a reproducible run." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "record_entry",
    title: "Record a ledger line",
    kind: "mutating" as const,
    description:
      "Write one ledger line through the same service layer the UI uses. Converts to the household's base currency at the live ECB rate, normalises the split so it sums exactly, and appends a sealed audit event. Safe to retry with the same idempotencyKey.",
    inputSchema: {
      type: "object",
      properties: {
        occurredOn: { type: "string", description: "YYYY-MM-DD" },
        direction: { type: "string", enum: ["outflow", "inflow"] },
        amountMinor: { type: "integer", minimum: 1, description: "Amount in minor units, e.g. 24050 paise for ₹250.50" },
        currency: { type: "string", minLength: 3, maxLength: 3, default: "INR" },
        fxRateToBase: { type: "number", exclusiveMinimum: 0, description: "Optional manual rate. Required for a currency the ECB does not publish." },
        paidBy: { type: ["string", "null"], description: "Member id. Defaults to the 'you' member." },
        category: { type: "string", enum: [...CATEGORIES], default: "other" },
        note: { type: "string", maxLength: 240 },
        rawText: { type: "string", maxLength: 2000, description: "The original message. This is the evidence." },
        splitMode: { type: "string", enum: ["equal", "exact"], default: "equal" },
        participants: { type: "array", items: memberRef, description: "Who bears the cost. Defaults to everyone." },
        exactShares: { type: ["object", "null"], description: "memberId -> minor units. Required when splitMode is 'exact'." },
        receiptRef: { type: ["string", "null"], maxLength: 80 },
        status: { type: "string", enum: ["draft", "confirmed", "disputed"], default: "draft" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
      },
      required: ["occurredOn", "direction", "amountMinor"],
      additionalProperties: false,
    },
  },
  {
    name: "record_entries",
    title: "Record several lines at once",
    kind: "mutating" as const,
    description:
      "Commit up to 50 reader candidates in one call. Reports partial success honestly: the lines it wrote and the lines it refused, each with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              direction: { type: "string", enum: ["outflow", "inflow"] },
              amountMinor: { type: "integer", minimum: 1 },
              currency: { type: "string" },
              occurredOn: { type: "string" },
              paidBy: { type: ["string", "null"] },
              category: { type: ["string", "null"] },
              parseEngine: {
                type: "string",
                enum: ["manual", "deterministic", "mobilebert-mnli", "ollama", "agent"],
              },
              parseConfidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["text", "direction", "amountMinor", "currency", "occurredOn"],
          },
        },
      },
      required: ["candidates"],
      additionalProperties: false,
    },
  },
  {
    name: "decide_entry",
    title: "Confirm or dispute a line",
    kind: "mutating" as const,
    description:
      "Move a line to confirmed or disputed, or edit its fields. This is the decision step: it is what changes who owes what, and it is sealed.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        status: { type: "string", enum: ["draft", "confirmed", "disputed"] },
        amountMinor: { type: "integer", minimum: 1 },
        occurredOn: { type: "string" },
        paidBy: { type: ["string", "null"] },
        participants: { type: "array", items: memberRef },
        note: { type: "string", maxLength: 240 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_entry",
    title: "Remove a line",
    kind: "mutating" as const,
    description:
      "Soft-delete a line. The row is kept as a tombstone with deleted = true so its seal chain stays replayable, and a delete event is appended.",
    inputSchema: {
      type: "object",
      properties: { id: str },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "export_statement",
    title: "Export the statement",
    kind: "mutating" as const,
    description:
      "Build the full settlement statement as JSON, with balances, the transfer plan, every factor with its evidence, the FX and CPI provenance, and the seal it was built from.",
    inputSchema: {
      type: "object",
      properties: { windowDays: { type: "integer", minimum: 1, maximum: 365, default: 30 } },
      additionalProperties: false,
    },
  },
  {
    name: "create_share_link",
    title: "Create a statement link",
    kind: "mutating" as const,
    description:
      "Mint an unguessable link that renders a read-only statement anyone with the URL can open. Returns the path.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", maxLength: 80 },
        days: { type: "integer", minimum: 1, maximum: 30, default: 7 },
      },
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));

/* -------------------------------------------------------------------------- */
/* Argument schemas for the tools that need them                              */
/* -------------------------------------------------------------------------- */

const listArgs = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.enum(["draft", "confirmed", "disputed", "all"]).default("all"),
  direction: z.enum(["outflow", "inflow", "all"]).default("all"),
  category: z.enum([...CATEGORIES, "all"]).default("all"),
  member: z.string().max(64).optional(),
  sort: z
    .enum(["created_desc", "created_asc", "occurred_desc", "occurred_asc"])
    .default("created_desc"),
});

const recordArgs = z.object({
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["outflow", "inflow"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).default("INR"),
  fxRateToBase: z.number().positive().max(1_000_000).optional(),
  paidBy: z.string().max(64).nullable().optional(),
  category: z.enum(CATEGORIES).default("other"),
  note: z.string().max(240).default(""),
  rawText: z.string().max(2000).default(""),
  splitMode: z.enum(["equal", "exact"]).default("equal"),
  participants: z.array(z.string().max(64)).max(12).optional(),
  exactShares: z.record(z.string(), z.number().int().min(0)).nullable().optional(),
  receiptRef: z.string().max(80).nullable().optional(),
  status: z.enum(["draft", "confirmed", "disputed"]).default("draft"),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

/* -------------------------------------------------------------------------- */
/* Tool execution                                                              */
/* -------------------------------------------------------------------------- */

interface ToolContext {
  session: Session;
  throttle: (scope: string) => { allowed: boolean; retryAfterSeconds: number };
}

async function callTool(name: ToolName, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const { session } = ctx;

  switch (name) {
    case "get_khata_summary": {
      const { items, total } = await queryEntries(session, {
        limit: 1, offset: 0, status: "all", direction: "all", category: "all", sort: "created_desc",
      });
      const settlement = await computeSettlement(session, { windowDays: "30" });
      return {
        household: session.household,
        lineCount: total,
        newest: items[0] ?? null,
        settlement: settlement.ok ? settlement.value.settlement : null,
        seal: settlement.ok ? settlement.value.settlement.seal : null,
      };
    }

    case "list_entries": {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "list_entries arguments are invalid.", parsed.error.issues);
      const { items, total } = await queryEntries(session, parsed.data);
      return { items, total, offset: parsed.data.offset, limit: parsed.data.limit };
    }

    case "get_entry": {
      const id = z.string().min(1).safeParse(args.id);
      if (!id.success) throw new ToolError(INVALID_PARAMS, "get_entry needs an id.");
      const entry = await getEntry(session, id.data);
      if (!entry) throw new ToolError(INVALID_PARAMS, `No ledger line with id ${id.data}.`);
      const events = await session.repository.listAudit(session.ownerId, entry.id);
      return { entry, chain: events, seal: events[events.length - 1]?.seal ?? null };
    }

    case "read_message": {
      const parsed = z.object({ text: z.string().min(1).max(4000), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "read_message needs text.", parsed.error.issues);
      const today = parsed.data.today ?? new Date().toISOString().slice(0, 10);
      const candidates = readText(parsed.data.text, {
        today,
        memberNames: session.household.members.map((m) => m.name),
        selfMemberId: session.household.members.find((m) => m.kind === "you")?.id ?? session.household.members[0]?.id ?? "",
      });
      return { engine: "deterministic", today, candidates };
    }

    case "analyse_settlement": {
      const parsed = z
        .object({ windowDays: z.coerce.number().int().min(1).max(365).default(30), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
        .safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "analyse_settlement arguments are invalid.", parsed.error.issues);
      const result = await computeSettlement(session, parsed.data);
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message);
      return result.value.settlement;
    }

    case "record_entry": {
      const gate = ctx.throttle("mcp-write");
      if (!gate.allowed) throw new ToolError(INVALID_PARAMS, `Rate limited. Retry in ${gate.retryAfterSeconds}s.`);
      const parsed = recordArgs.safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "record_entry arguments are invalid.", parsed.error.issues);
      const result = await createEntry(session, { ...parsed.data, evidence: "agent", parseEngine: "agent" });
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message, result.response.error.fields);
      return {
        entry: result.entry,
        seal: result.seal,
        sealShort: shortSeal(result.seal),
        fx: { status: result.fx.status, asOf: result.fx.asOf, provider: result.fx.provider },
      };
    }

    case "record_entries": {
      const gate = ctx.throttle("mcp-write");
      if (!gate.allowed) throw new ToolError(INVALID_PARAMS, `Rate limited. Retry in ${gate.retryAfterSeconds}s.`);
      const parsed = z
        .object({
          candidates: z
            .array(
              z.object({
                text: z.string().min(1).max(2000),
                direction: z.enum(["outflow", "inflow"]),
                amountMinor: z.number().int().positive(),
                currency: z.string().regex(/^[A-Za-z]{3}$/),
                occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                paidBy: z.string().max(64).nullable(),
                category: z.enum(CATEGORIES).nullable(),
                participants: z.array(z.string().max(64)).max(12).optional(),
                parseEngine: z.enum(["manual", "deterministic", "mobilebert-mnli", "ollama", "agent"]),
                parseConfidence: z.number().min(0).max(1),
              }),
            )
            .min(1)
            .max(50),
        })
        .safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "record_entries arguments are invalid.", parsed.error.issues);
      const result = await commitCandidates(session, parsed.data.candidates);
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message);
      return {
        created: result.created,
        failed: result.failed,
        summary: { requested: parsed.data.candidates.length, created: result.created.length, failed: result.failed.length },
      };
    }

    case "decide_entry": {
      const gate = ctx.throttle("mcp-write");
      if (!gate.allowed) throw new ToolError(INVALID_PARAMS, `Rate limited. Retry in ${gate.retryAfterSeconds}s.`);
      const parsed = z
        .object({
          id: str,
          status: z.enum(["draft", "confirmed", "disputed"]).optional(),
          amountMinor: z.number().int().positive().optional(),
          occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          paidBy: z.string().max(64).nullable().optional(),
          participants: z.array(z.string().max(64)).max(12).optional(),
          note: z.string().max(240).optional(),
        })
        .safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "decide_entry arguments are invalid.", parsed.error.issues);
      const { id, ...patch } = parsed.data;
      const result = await updateEntry(session, id, patch);
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message);
      return { entry: result.entry, seal: result.seal, sealShort: shortSeal(result.seal) };
    }

    case "delete_entry": {
      const gate = ctx.throttle("mcp-write");
      if (!gate.allowed) throw new ToolError(INVALID_PARAMS, `Rate limited. Retry in ${gate.retryAfterSeconds}s.`);
      const parsed = z.object({ id: str }).safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "delete_entry needs an id.");
      const result = await deleteEntry(session, parsed.data.id);
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message);
      return { deleted: true, tombstoneKept: true, entryId: parsed.data.id, seal: result.seal, sealShort: shortSeal(result.seal) };
    }

    case "export_statement": {
      const parsed = z.object({ windowDays: z.coerce.number().int().min(1).max(365).default(30) }).safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "export_statement arguments are invalid.");
      const settlementResult = await computeSettlement(session, { windowDays: String(parsed.data.windowDays) });
      if (!settlementResult.ok) throw new ToolError(INVALID_PARAMS, settlementResult.response.error.message);
      const { settlement, fx, cpi } = settlementResult.value;
      const { items } = await queryEntries(session, {
        limit: 100, offset: 0, status: "all", direction: "all", category: "all", sort: "occurred_asc",
      });
      return buildStatementJson({
        household: session.household,
        entries: items,
        settlement,
        fx: { status: fx.status, asOf: fx.asOf, provider: fx.provider, attribution: fx.attribution },
        cpi,
        generatedAt: new Date().toISOString(),
        seal: settlement.seal ?? "",
      });
    }

    case "create_share_link": {
      const gate = ctx.throttle("mcp-write");
      if (!gate.allowed) throw new ToolError(INVALID_PARAMS, `Rate limited. Retry in ${gate.retryAfterSeconds}s.`);
      const parsed = z
        .object({ label: z.string().max(80).default(""), days: z.coerce.number().int().min(1).max(30).default(7) })
        .safeParse(args);
      if (!parsed.success) throw new ToolError(INVALID_PARAMS, "create_share_link arguments are invalid.");
      const result = await createShareLink(session, parsed.data.label, parsed.data.days);
      if (!result.ok) throw new ToolError(INVALID_PARAMS, result.response.error.message);
      return { path: result.url, expiresAt: result.link.expiresAt, seal: result.link.seal, sealShort: shortSeal(result.link.seal) };
    }

    default: {
      // Exhaustiveness: adding a tool without a case here is a type error.
      const exhaustive: never = name;
      throw new ToolError(METHOD_NOT_FOUND, `Tool "${String(exhaustive)}" is not implemented.`);
    }
  }
}

class ToolError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return rpcError(null, PARSE_ERROR, "Request body was not valid JSON.");
  }

  if (Array.isArray(payload)) {
    return rpcError(null, INVALID_REQUEST, "khata accepts one JSON-RPC request per call, not a batch.");
  }

  const body = payload as RpcRequest;
  if (typeof body !== "object" || body === null) {
    return rpcError(null, INVALID_REQUEST, "A JSON-RPC request must be an object.");
  }
  if (body.jsonrpc !== JSONRPC) {
    return rpcError(body.id ?? null, INVALID_REQUEST, `"jsonrpc" must be exactly "${JSONRPC}".`);
  }
  if (typeof body.method !== "string") {
    return rpcError(body.id ?? null, INVALID_REQUEST, '"method" must be a string.');
  }

  const id = body.id ?? null;
  const isNotification = body.id === undefined;

  try {
    switch (body.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "khata is a shared household ledger. Typical order: read_message on a pasted payment message, record_entry for each line it found, decide_entry to confirm, then analyse_settlement for who pays whom. Every mutating tool accepts an idempotencyKey so a retry is safe.",
        });

      case "notifications/initialized":
        return new NextResponse(null, { status: 204 });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            kind: t.kind,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              readOnlyHint: t.kind === "read" || t.kind === "analysis",
              destructiveHint: t.kind === "mutating" && t.name === "delete_entry",
            },
          })),
        });

      case "tools/call": {
        const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : "";
        if (!TOOL_NAMES.has(name)) {
          return rpcError(id, INVALID_PARAMS, `Unknown tool "${name}". Call tools/list first.`);
        }

        const session = await openSession();
        const ip = clientIp(request.headers);
        const bucket = `${session.ownerId}:${ip}`;

        // An echoed scope must match the real one, or be absent. Checked in
        // constant time so a wrong scope cannot be learned by timing.
        const echoed = (params.arguments as Record<string, unknown> | undefined)?.scope;
        if (typeof echoed === "string" && !scopeMatches(echoed, session.ownerId)) {
          return rpcError(id, INVALID_PARAMS, "The supplied scope does not match this session.");
        }
        if (params.arguments && typeof params.arguments === "object") {
          delete (params.arguments as Record<string, unknown>).scope;
        }

        const throttle = (scope: string) => {
          const decision = consumeWrite(bucket, scope);
          return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
        };

        try {
          const result = await callTool(name as ToolName, params.arguments, { session, throttle });
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          });
        } catch (err) {
          if (err instanceof ToolError) {
            return rpcResult(id, {
              content: [{ type: "text", text: err.message }],
              structuredContent: { error: err.message, ...(err.data ? { detail: err.data } : {}) },
              isError: true,
            });
          }
          return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Tool failed.");
        }
      }

      default:
        if (isNotification) return new NextResponse(null, { status: 204 });
        return rpcError(id, METHOD_NOT_FOUND, `Method "${body.method}" is not implemented. khata speaks initialize, notifications/initialized, ping, tools/list and tools/call.`);
    }
  } catch (err) {
    return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Unhandled error.");
  }
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      data: {
        transport: "JSON-RPC 2.0 over HTTP POST",
        protocolVersion: PROTOCOL_VERSION,
        methods: ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"],
        tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, title: t.title })),
        engine: ENGINE_VERSION,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}