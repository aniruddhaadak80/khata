"use client";

/**
 * The agent console.
 *
 * A live JSON-RPC 2.0 client against `POST /api/mcp`, in the page, with the raw
 * request and response visible. Two reasons for showing the wire format rather
 * than hiding it behind friendly cards:
 *
 *   1. It is the same thing an agent sends. If a tool works here, it works for
 *      the model, because the transport is identical.
 *   2. A tool panel that hides its own failures is how a broken integration
 *      ships. Every error below is the server's actual JSON-RPC error.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Play, RotateCcw, Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { Failure, Loading, Notice, Rubric } from "./states";
import { Seal } from "./seal";
import type { Household } from "@/lib/types";

interface ToolSummary {
  name: string;
  title: string;
  kind?: string;
  description?: string;
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface WireEntry {
  id: number;
  label: string;
  request: unknown;
  response: unknown;
  ok: boolean;
  at: string;
}

let wireSeq = 0;

/* Stable, module-level snapshots for useSyncExternalStore. The origin never
 * changes during a session, so this never subscribes to anything. */
const noopSubscribe = () => () => {};
const getOrigin = () => (typeof window === "undefined" ? "" : window.location.origin);
const getServerOrigin = () => "";

export function AgentConsole({ household }: { household: Household }) {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [wire, setWire] = useState<WireEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [amount, setAmount] = useState("1250");
  const [category, setCategory] = useState("utilities");

  /**
   * The absolute origin, read through `useSyncExternalStore`.
   *
   * Deliberately *not* `typeof window === "undefined" ? "/api/mcp" : origin`.
   * That branch is the first item on React's own list of hydration-mismatch
   * causes: the server renders the relative path, the client renders the origin,
   * and the whole tree is regenerated.
   *
   * `useSyncExternalStore` is the right tool rather than an effect: it takes the
   * server snapshot as its third argument, so the first client render agrees
   * with the server by construction, and no `setState` is needed.
   */
  const origin = useSyncExternalStore(noopSubscribe, getOrigin, getServerOrigin);

  const call = useCallback(async (label: string, payload: unknown) => {
    setBusy(label);
    setError(null);
    const response = await fetch("/api/mcp", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({ parseError: true }));
    wireSeq += 1;
    const ok = Boolean(body && typeof body === "object" && "result" in body && !(body as { error?: unknown }).error);
    setWire((prev) => [
      { id: wireSeq, label, request: payload, response: body, ok, at: new Date().toISOString() },
      ...prev,
    ]);
    setBusy(null);
    return { body: body as Record<string, unknown>, ok };
  }, []);

  /* Handshake, then discovery — exactly the order an agent follows. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const init = await call("initialize", {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "khata console", version: "1.0.0" } },
      });
      if (cancelled) return;
      setInitialised(Boolean(init.body?.result));
      const list = await call("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list" });
      if (cancelled) return;
      const result = list.body?.result as { tools?: ToolSummary[] } | undefined;
      setTools(result?.tools ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  const runSummary = async () => {
    const { body } = await call("tools/call get_khata_summary", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: { name: "get_khata_summary", arguments: {} },
    });
    void body;
  };

  const runAnalyse = async () => {
    await call("tools/call analyse_settlement", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: { name: "analyse_settlement", arguments: { windowDays: 30 } },
    });
  };

  const runRead = async () => {
    await call("tools/call read_message", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: {
        name: "read_message",
        arguments: {
          text: "Paid 2400 to BESCOM, split between me and Meera\nreceived refund 320 from the wifi router seller",
          today: new Date().toISOString().slice(0, 10),
        },
      },
    });
  };

  /**
   * The mutating tool. Uses an idempotency key derived from the amount and the
   * second, so pressing the button twice writes one line rather than two — which
   * is exactly the retry case the key exists for, demonstrated rather than
   * described.
   */
  const runRecord = async () => {
    const major = Number.parseFloat(amount);
    if (!Number.isFinite(major) || major <= 0) {
      setError("Enter an amount greater than zero first.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const key = `console-${category}-${Math.round(major * 100)}-${today}`;
    const { body } = await call("tools/call record_entry", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: {
        name: "record_entry",
        arguments: {
          occurredOn: today,
          direction: "outflow",
          amountMinor: Math.round(major * 100),
          currency: household.baseCurrency,
          paidBy: household.members[0]?.id ?? null,
          category,
          note: "Written by the agent console",
          rawText: "Recorded through POST /api/mcp tools/call record_entry",
          status: "draft",
          idempotencyKey: key,
        },
      },
    });
    const structured = (body?.result as { structuredContent?: { entry?: { id?: string } } } | undefined)?.structuredContent;
    const id = structured?.entry?.id;
    if (id) setCreatedId(id);
  };

  const runDecide = async () => {
    if (!createdId) {
      setError("Record a line first, then confirm it.");
      return;
    }
    await call("tools/call decide_entry", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: { name: "decide_entry", arguments: { id: createdId, status: "confirmed" } },
    });
  };

  const runVerify = async () => {
    await call("HTTP GET /api/verify", null);
    const response = await api.get<{ ledgerSeal: string; ok: boolean; events: number }>("/api/verify");
    setWire((prev) => [
      {
        id: wireSeq + 1,
        label: "HTTP GET /api/verify",
        request: "GET /api/verify",
        response: response.ok ? response.data : { error: response.error },
        ok: response.ok,
        at: new Date().toISOString(),
      },
      ...prev,
    ]);
  };

  const runDelete = async () => {
    if (!createdId) {
      setError("Record a line first, then remove it.");
      return;
    }
    await call("tools/call delete_entry", {
      jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: { name: "delete_entry", arguments: { id: createdId } },
    });
    setCreatedId(null);
  };

  return (
    <div className="space-y-6">
      <section className="card khata-cloth on-cloth p-5" aria-labelledby="mcp-endpoint">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="mcp-endpoint" className="font-display text-2xl text-[color:var(--color-rag-50)]">
            MCP endpoint
          </h2>
          <span
            className={`khata-stamp px-2 py-1 text-[10px] ${
              initialised ? "text-[color:var(--color-moss-300)]" : "text-[color:var(--color-turmeric-300)]"
            }`}
          >
            {initialised ? "initialised" : "not initialised"}
          </span>
        </div>
        <p className="mt-2 max-w-prose text-sm text-[color:var(--color-cloth-400)]">
          JSON-RPC 2.0 over HTTP POST. Point an MCP client at this URL; the manifest at{" "}
          <Link href="/mcp.json" className="underline underline-offset-4">/mcp.json</Link> has the
          live address and the tool names.
        </p>
        <p className="mt-2 font-data text-xs text-[color:var(--color-turmeric-300)]">
          POST {origin ? `${origin}/api/mcp` : "/api/mcp"}
        </p>
      </section>

      <section aria-labelledby="tools">
        <h2 id="tools" className="font-display text-2xl text-[color:var(--color-ink-900)]">
          Tools
        </h2>
        {loading && !tools ? <div className="mt-3"><Loading label="Discovering tools…" /></div> : null}
        {tools ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {tools.map((t) => (
              <li key={t.name} className="card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <code className="font-data text-sm text-[color:var(--color-ink-900)]">{t.name}</code>
                  {t.kind ? <span className="rubric">{t.kind}</span> : null}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-[color:var(--color-ink-700)]">{t.description}</p>
                {t.inputSchema?.required ? (
                  <p className="mt-1 font-data text-[11px] text-[color:var(--color-ink-400)]">
                    requires {t.inputSchema.required.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card p-5" aria-labelledby="calls">
        <h2 id="calls" className="font-display text-2xl text-[color:var(--color-ink-900)]">
          One-click calls
        </h2>
        <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
          Each button sends exactly the JSON an agent would send. The request and the server&apos;s
          real reply are both kept in the log below.
        </p>

        {error ? <div className="mt-3"><Failure message={error} /></div> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-quiet" onClick={runSummary} disabled={busy !== null}>
            <Play className="h-4 w-4" aria-hidden="true" /> get_khata_summary
          </button>
          <button type="button" className="btn btn-quiet" onClick={runRead} disabled={busy !== null}>
            read_message
          </button>
          <button type="button" className="btn btn-quiet" onClick={runAnalyse} disabled={busy !== null}>
            analyse_settlement
          </button>
          <button type="button" className="btn btn-quiet" onClick={runVerify} disabled={busy !== null}>
            verify_integrity
          </button>
        </div>

        <div className="mt-5 border-t border-[color:var(--color-rule)] pt-4">
          <Rubric>Mutating tools</Rubric>
          <p className="mt-1 max-w-prose text-sm text-[color:var(--color-ink-700)]">
            These write through the same service layer the interface uses. Press record twice: the
            idempotency key means one line is written, not two.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="agent-amount" className="rubric">Amount ({household.baseCurrency})</label>
              <input
                id="agent-amount"
                type="number"
                step="0.01"
                className="field tabular mt-1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="agent-category" className="rubric">Category</label>
              <select id="agent-category" className="field mt-1" value={category} onChange={(e) => setCategory(e.target.value)}>
                {["groceries", "utilities", "rent", "transport", "medicine", "household", "fees", "other"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-madder" onClick={runRecord} disabled={busy !== null}>
              <Terminal className="h-4 w-4" aria-hidden="true" /> record_entry
            </button>
            <button type="button" className="btn btn-quiet" onClick={runDecide} disabled={busy !== null || !createdId}>
              decide_entry
            </button>
            <button type="button" className="btn btn-quiet" onClick={runDelete} disabled={busy !== null || !createdId}>
              delete_entry
            </button>
          </div>

          {createdId ? (
            <div className="mt-3">
              <Notice tone="good">
                The agent wrote <code className="font-data">{createdId.slice(0, 8)}</code>. It is a real
                line in the same book the interface reads —{" "}
                <Link href={`/ledger/${createdId}`} className="underline underline-offset-4">open it</Link>.
              </Notice>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card p-5" aria-labelledby="wire">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="wire" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            The wire
          </h2>
          <button type="button" className="btn btn-quiet" onClick={() => setWire([])} disabled={wire.length === 0}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Clear log
          </button>
        </div>

        {wire.length === 0 ? (
          <p className="mt-3 text-sm text-[color:var(--color-ink-500)]">
            Nothing yet. The handshake that discovered the tools is logged too.
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {wire.map((w) => (
              <li key={w.id} className={`card border-l-4 p-3 ${w.ok ? "border-l-[color:var(--color-moss-600)]" : "border-l-[color:var(--color-madder-600)]"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-data text-sm text-[color:var(--color-ink-900)]">{w.label}</span>
                  <span className="rubric">{w.at.slice(11, 19)}</span>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-[color:var(--color-ink-500)]">
                    Request and response
                  </summary>
                  <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    <div>
                      <p className="rubric">Request</p>
                      <pre className="mt-1 max-h-64 overflow-auto bg-[color:var(--color-ink-900)] p-2 font-data text-[11px] leading-relaxed text-[color:var(--color-rag-100)]">
{JSON.stringify(w.request, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="rubric">Response</p>
                      <pre className="mt-1 max-h-64 overflow-auto bg-[color:var(--color-ink-900)] p-2 font-data text-[11px] leading-relaxed text-[color:var(--color-rag-100)]">
{JSON.stringify(w.response, null, 2)}
                      </pre>
                    </div>
                  </div>
                </details>
                {extractSeal(w.response) ? <Seal seal={extractSeal(w.response) as string} label="returned by the tool" /> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function nextId(): number {
  wireSeq += 1;
  return wireSeq;
}

function extractSeal(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const structured = (response as { result?: { structuredContent?: Record<string, unknown> } }).result?.structuredContent;
  const candidate =
    structured?.seal ?? (structured?.settlement as { seal?: string } | undefined)?.seal ?? structured?.ledgerSeal;
  return typeof candidate === "string" && candidate.length === 96 ? candidate : null;
}