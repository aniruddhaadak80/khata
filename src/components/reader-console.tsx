"use client";

/**
 * The Reader.
 *
 * The core loop, in the order a real shared home experiences it:
 *
 *   1. paste the messages that actually arrived (a UPI SMS, a WhatsApp forward)
 *   2. the rule engine reads them instantly, with no download and no network,
 *      and says out loud how sure it is about each field
 *   3. optionally load an open-weight NLI model that runs *in this browser* and
 *      re-decides only the directions the rules were unsure about
 *   4. correct anything by hand, then write the lines into the ledger
 *
 * Step 4 reports exactly which lines were written and which were refused, with
 * the reason, because a partial failure that says nothing is indistinguishable
 * from a partial success.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Cloud, Cpu, Download, Loader2, PenLine, Wand2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { isoToday, readText, resolveDirection, summariseRead } from "@/lib/reader";
import {
  MODEL_BYTES,
  classifyDirections,
  loadDirectionModel,
  probeOllama,
  type Classification,
  type ModelStatus,
  type OllamaProbe,
} from "@/lib/local-model";
import { CATEGORIES, CATEGORY_LABELS, type Category, type Household, type ReadCandidate } from "@/lib/types";
import { money, minorToInput } from "@/lib/format";
import { Failure, Loading, Notice, Rubric } from "./states";

/**
 * A worked example, written for khata. Not a capture of anyone's real
 * messages — it is a fixture, and the interface says so next to it.
 */
const SAMPLE = `Paid 2400 to BESCOM for the electricity bill, Arunima paid half
Meera sent me back 600 for the gas cylinder
split between me and Meera, I paid Rs 1450 for groceries at DMart yesterday
received refund 320 from the wifi router seller
house rent 8500 paid by Meera on 1 Oct
sent 250 to the plumber for the kitchen tap`;

interface Draft extends ReadCandidate {
  id: string;
  selected: boolean;
  directionOverride: "outflow" | "inflow" | null;
  engineUsed: string;
  /** What the model said, when the model has run. */
  modelDirection: Classification["direction"] | null;
  modelConfidence: number | null;
  modelScores: Record<string, number> | null;
}

let draftSeq = 0;

function toDraft(c: ReadCandidate): Draft {
  draftSeq += 1;
  return {
    ...c,
    id: `d${draftSeq}`,
    selected: c.ready,
    directionOverride: null,
    engineUsed: "rules",
    modelDirection: null,
    modelConfidence: null,
    modelScores: null,
  };
}

export function ReaderConsole({ household }: { household: Household }) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [readError, setReadError] = useState<string | null>(null);

  const [model, setModel] = useState<ModelStatus>({
    state: "idle", progress: 0, file: null, error: null, transport: null,
  });
  const [modelBusy, setModelBusy] = useState(false);
  const [ollama, setOllama] = useState<OllamaProbe | null>(null);
  /**
   * Whether this deployment offers the server's hosted-model tier at all.
   * `null` until the server has answered, and it stays `null` if the question
   * fails — the button is rendered only on an explicit yes.
   */
  const [cloud, setCloud] = useState<{ configured: boolean; model: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<
    | { kind: "written"; created: Array<{ id: string; amountBaseMinor: number; currency: string; parseEngine: string }>; failed: Array<{ text: string; reason: string }> }
    | { kind: "failed"; message: string }
    | null
  >(null);

  const today = useMemo(() => isoToday(), []);
  const memberNames = useMemo(() => household.members.map((m) => m.name), [household.members]);
  const selfMemberId = useMemo(
    () => household.members.find((m) => m.kind === "you")?.id ?? household.members[0]?.id ?? "",
    [household.members],
  );
  const liveRef = useRef<HTMLParagraphElement | null>(null);

  /* Probe for a local Ollama once, so the option is offered only if it works. */
  useEffect(() => {
    let cancelled = false;
    probeOllama().then((probe) => {
      if (!cancelled) setOllama(probe);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Ask the server once whether a hosted tier exists. A deployment with no
     key answers "no" and never shows the control, so adding this feature
     changed nothing at all for a keyless deployment. */
  useEffect(() => {
    let cancelled = false;
    api.get<{ configured: boolean; model: string }>("/api/reader/direction").then((res) => {
      if (!cancelled && res.ok) setCloud(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const read = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setReadError("Paste at least one payment message first.");
      return;
    }
    const candidates = readText(trimmed, { today, memberNames, selfMemberId });
    setDrafts(candidates.map(toDraft));
    setResult(null);
    setReadError(null);
    requestAnimationFrame(() => liveRef.current?.focus());
  }, [text, today, memberNames, selfMemberId]);

  const loadModel = useCallback(async () => {
    setModelBusy(true);
    try {
      await loadDirectionModel(setModel);
    } catch {
      // Status already carries the message; nothing further to do here.
    } finally {
      setModelBusy(false);
    }
  }, []);

  const runModel = useCallback(async () => {
    const interesting = drafts.filter(
      (d) => d.direction.confidence < 0.8 && d.amountMinor.value !== null,
    );
    if (interesting.length === 0) {
      setResult({ kind: "failed", message: "The rules were already confident about every line, so there was nothing for the model to decide." });
      return;
    }
    setModelBusy(true);
    try {
      const out = await classifyDirections(interesting.map((d) => d.text));
      const byId = new Map(interesting.map((d, i) => [d.id, out[i]]));
      setDrafts((prev) =>
        prev.map((d) => {
          const c = byId.get(d.id);
          if (!c) return d;
          // The model decides when the rules gave up, and only overrules a
          // confident rule when it is at least as sure itself.
          const resolved = summariseRead({ ...d, direction: resolveDirection(d.direction, c) });
          return {
            ...resolved,
            id: d.id,
            // A line the model just made readable becomes writable and joins
            // the batch, exactly as it would have if the rules had read it.
            selected: resolved.ready || d.selected,
            directionOverride: d.directionOverride,
            engineUsed: "model",
            modelDirection: c.direction,
            modelConfidence: c.confidence,
            modelScores: c.scores,
          };
        }),
      );
    } catch (err) {
      setModel({
        state: "error",
        progress: 0,
        file: null,
        error: err instanceof Error ? err.message : "The model could not be reached.",
        transport: null,
      });
    } finally {
      setModelBusy(false);
    }
  }, [drafts]);

  /**
   * The same job as `runModel`, one tier up: lines the rules were unsure
   * about, decided by the hosted model on the server.
   *
   * Deliberately sequential — a household paste is a handful of lines, and the
   * free tier's quota is per minute, so firing them in parallel would buy
   * nothing and spend the budget. Every answer is fed through
   * `resolveDirection`, the very same gate the browser model passes through.
   */
  const runCloud = useCallback(async () => {
    const interesting = drafts.filter(
      (d) => d.direction.confidence < 0.8 && d.amountMinor.value !== null,
    );
    if (interesting.length === 0) {
      setResult({
        kind: "failed",
        message:
          "The rules were already confident about every line, so there was nothing for the cloud model to decide.",
      });
      return;
    }

    setModelBusy(true);
    setResult(null);
    try {
      const answers: Array<{ id: string; answer: Classification }> = [];
      for (const draft of interesting) {
        const res = await api.post<{ direction: Classification["direction"]; confidence: number }>(
          "/api/reader/direction",
          { text: draft.text },
        );
        if (!res.ok) throw new Error(errorText(res.error));
        answers.push({
          id: draft.id,
          answer: {
            text: draft.text,
            direction: res.data.direction,
            confidence: res.data.confidence,
            scores: { [res.data.direction]: res.data.confidence },
          },
        });
      }

      const byId = new Map(answers.map((a) => [a.id, a.answer]));
      setDrafts((prev) =>
        prev.map((d) => {
          const c = byId.get(d.id);
          if (!c) return d;
          const resolved = summariseRead({ ...d, direction: resolveDirection(d.direction, c) });
          return {
            ...resolved,
            id: d.id,
            selected: resolved.ready || d.selected,
            directionOverride: d.directionOverride,
            engineUsed: "cloud",
            modelDirection: c.direction,
            modelConfidence: c.confidence,
            modelScores: c.scores,
          };
        }),
      );
    } catch (err) {
      setResult({
        kind: "failed",
        message: `${err instanceof Error ? err.message : "The cloud model could not be reached."} The rules and the browser model are unaffected.`,
      });
    } finally {
      setModelBusy(false);
    }
  }, [drafts]);

  const patch = useCallback((id: string, changes: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...changes } : d)));
  }, []);

  const commit = useCallback(async () => {
    const ready = drafts.filter((d) => d.selected && d.direction.value !== "unclear" && d.amountMinor.value !== null);
    if (ready.length === 0) {
      setResult({ kind: "failed", message: "Tick at least one line that has both an amount and a direction." });
      return;
    }
    setSaving(true);
    setResult(null);

    const payload = ready.map((d) => {
      const direction = d.directionOverride ?? (d.direction.value === "inflow" ? "inflow" : "outflow");
      return {
        text: d.text,
        direction,
        amountMinor: d.amountMinor.value as number,
        currency: d.currency.value ?? household.baseCurrency,
        occurredOn: d.occurredOn.value ?? today,
        paidBy: d.paidBy.value,
        category: d.category.value,
        // Names are resolved to member ids here, at the edge, so the rest of the
        // system only ever deals in ids.
        participants: participantIds(d, household),
        parseEngine:
          d.engineUsed === "model"
            ? ("mobilebert-mnli" as const)
            : d.engineUsed === "cloud"
              ? ("gemini" as const)
              : ("deterministic" as const),
        parseConfidence: d.confidence,
        evidence: "paste" as const,
      };
    });

    const response = await api.post<{
      created: Array<{ id: string; amountBaseMinor: number; currency: string; parseEngine: string }>;
      failed: Array<{ text: string; reason: string }>;
    }>("/api/reader/commit", { candidates: payload });

    if (!response.ok) {
      setResult({ kind: "failed", message: errorText(response.error) });
      setSaving(false);
      return;
    }

    setResult({ kind: "written", created: response.data.created, failed: response.data.failed });
    setSaving(false);
  }, [drafts, household, today]);

  const selected = drafts.filter((d) => d.selected).length;

  return (
    <div className="space-y-8">
      {/* ---- Input ------------------------------------------------------- */}
      <section className="card p-5 sm:p-6" aria-labelledby="reader-input">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="reader-input" className="font-display text-2xl text-[color:var(--color-ink-900)]">
            Paste what actually arrived
          </h2>
          <p className="rubric">UPI SMS · WhatsApp forward · voice note transcript</p>
        </div>

        <label htmlFor="reader-text" className="sr-only">
          Payment messages to read
        </label>
        <textarea
          id="reader-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"I paid 2400 for the electricity bill\nMeera sent me back 600 for the cylinder"}
          className="field khata-rules mt-3 resize-y font-data text-sm"
          aria-describedby="reader-text-help"
        />
        <p id="reader-text-help" className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          One message per line works best. Commas and semicolons also split, so a run-on SMS still
          reads as separate payments. Nothing is sent anywhere until you press Write.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={read} disabled={text.trim().length === 0}>
            <Wand2 className="h-4 w-4" aria-hidden="true" />
            Read it
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setText(SAMPLE)}
            disabled={text.trim().length > 0}
          >
            Use the worked example
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => { setText(""); setDrafts([]); setResult(null); setReadError(null); }}>
            Clear
          </button>
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          The worked example is a fixture written for khata, not a capture of anyone&apos;s messages.
        </p>

        {readError ? (
          <div className="mt-3">
            <Failure message={readError} />
          </div>
        ) : null}
      </section>

      {/* ---- The open-weight model --------------------------------------- */}
      <section className="card khata-cloth on-cloth p-5 sm:p-6" aria-labelledby="reader-model">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="reader-model" className="font-display text-2xl text-[color:var(--color-rag-50)]">
            The open model
          </h2>
          <p className="rubric text-[color:var(--color-turmeric-300)]">runs here, not on our servers</p>
        </div>

        <p className="mt-2 max-w-prose text-sm leading-relaxed text-[color:var(--color-cloth-400)]">
          <span className="font-data">Xenova/mobilebert-uncased-mnli</span> is an NLI model in an
          open-weights release. It is downloaded once into your browser&apos;s cache and runs on your
          machine through onnxruntime-web. Nothing is billed, no key exists, and after the first
          load it works with the network switched off.
        </p>

        <p className="mt-3 max-w-prose text-sm leading-relaxed text-[color:var(--color-cloth-400)]">
          Rules handle amounts, dates, payers and categories. The model handles the one thing rules
          cannot: which way money moved. &ldquo;received refund 320&rdquo; and &ldquo;refund paid 320&rdquo;
          contain the same words and mean opposite things.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-quiet" onClick={loadModel} disabled={modelBusy || model.state === "ready"}>
            {modelBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {model.state === "ready" ? "Model ready" : `Download ${(MODEL_BYTES / 1_000_000).toFixed(0)} MB model`}
          </button>
          <button type="button" className="btn btn-quiet" onClick={runModel} disabled={modelBusy || model.state !== "ready" || drafts.length === 0}>
            <Cpu className="h-4 w-4" aria-hidden="true" />
            {modelBusy ? "Running…" : "Re-decide directions with the model"}
          </button>
          {cloud?.configured ? (
            <button type="button" className="btn btn-quiet" onClick={runCloud} disabled={modelBusy || drafts.length === 0}>
              <Cloud className="h-4 w-4" aria-hidden="true" />
              {modelBusy ? "Asking the cloud…" : "Re-decide directions with the cloud model"}
            </button>
          ) : null}
        </div>

        <div className="mt-4" aria-live="polite">
          {model.state === "idle" ? (
            <p className="font-data text-xs text-[color:var(--color-cloth-400)]">
              Not loaded. The rule engine above works without it.
            </p>
          ) : null}

          {model.state === "loading" ? (
            <div>
              <div className="h-2 w-full max-w-sm bg-[color:var(--color-cloth-900)]">
                <div
                  className="h-2 bg-[color:var(--color-madder-500)] transition-[width] duration-200"
                  style={{ width: `${Math.round(model.progress * 100)}%` }}
                />
              </div>
              <p className="mt-2 font-data text-xs text-[color:var(--color-cloth-400)]">
                {Math.round(model.progress * 100)}%{model.file ? ` · ${model.file}` : ""} · fetched from
                the Hugging Face CDN, then cached in this browser
              </p>
            </div>
          ) : null}

          {model.state === "ready" ? (
            <Notice tone="good">
              Loaded. It is cached in this browser now, so the next visit needs no network at all.
            </Notice>
          ) : null}

          {model.state === "error" && model.error ? (
            <Failure
              title="The model could not start"
              message={`${model.error} The rule engine is unaffected — khata still reads messages without it.`}
            />
          ) : null}
        </div>

        {/* Ollama: offered only when a daemon actually answers. */}
        {ollama ? (
          ollama.reachable ? (
            <p className="mt-4 border border-[color:var(--color-moss-600)] p-3 text-xs text-[color:var(--color-moss-300)]">
              A local Ollama daemon answered on 127.0.0.1:11434 with{" "}
              <span className="font-data">{ollama.models.length}</span> model
              {ollama.models.length === 1 ? "" : "s"}
              {ollama.models.length > 0 ? `: ${ollama.models.slice(0, 4).join(", ")}` : ""}.{" "}
              khata&apos;s documented default for local inference is{" "}
              <span className="font-data">gemma3:1b</span>.
            </p>
          ) : (
            <p className="mt-4 text-xs text-[color:var(--color-cloth-400)]">
              No local Ollama daemon reachable from this page ({ollama.error}).{" "}
              {ollama.hint} khata works without it.
            </p>
          )
        ) : (
          <p className="mt-4 text-xs text-[color:var(--color-cloth-400)]">Checking for a local Ollama…</p>
        )}

        {/* The hosted tier, offered only when this deployment actually has a key. */}
        {cloud?.configured ? (
          <p className="mt-4 border border-[color:var(--color-turmeric-500)] p-3 text-xs leading-relaxed text-[color:var(--color-turmeric-300)]">
            Optional third tier: this deployment has a server-side key, so the server can ask{" "}
            <span className="font-data">{cloud.model}</span> about a line the rules left unclear. The key lives in a
            server environment variable and never reaches this page, the answer is capped below a measured rule it
            would otherwise overrule, and every other step — rules, browser model, settlement, seal — works with no
            cloud model at all.
          </p>
        ) : null}
      </section>

      {/* ---- Candidates --------------------------------------------------- */}
      {drafts.length > 0 ? (
        <section aria-labelledby="reader-candidates">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="reader-candidates" className="font-display text-2xl text-[color:var(--color-ink-900)]">
              {drafts.length} line{drafts.length === 1 ? "" : "s"} read
            </h2>
            <p className="rubric">{selected} selected</p>
          </div>

          <ul className="mt-4 space-y-3">
            {drafts.map((draft) => (
              <CandidateCard
                key={draft.id}
                draft={draft}
                household={household}
                today={today}
                onPatch={patch}
              />
            ))}
          </ul>

          <div className="card khata-margin mt-6 p-5 pl-8">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-madder" onClick={commit} disabled={saving || selected === 0}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />}
                {saving ? "Writing…" : `Write ${selected} line${selected === 1 ? "" : "s"} to the ledger`}
              </button>
              <p className="text-xs text-[color:var(--color-ink-500)]">
                Each line is sealed the moment it is written.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <p ref={liveRef} tabIndex={-1} className="sr-only" aria-live="polite">
        {drafts.length > 0 ? `${drafts.length} lines read, ${selected} selected.` : ""}
      </p>

      {/* ---- Outcome ------------------------------------------------------ */}
      {result?.kind === "written" ? (
        <section aria-labelledby="reader-written">
          <Rubric id="reader-written">Written to the ledger</Rubric>
          <div className="mt-3 space-y-3">
            <Notice tone={result.failed.length > 0 ? "warn" : "good"}>
              {result.created.length} line{result.created.length === 1 ? "" : "s"} written
              {result.failed.length > 0 ? `, ${result.failed.length} refused.` : "."} Every one carries a seal
              and a record of which reader produced it.
            </Notice>
            <ul className="space-y-2">
              {result.created.map((e) => (
                <li key={e.id} className="card flex flex-wrap items-center justify-between gap-2 p-3">
                  <span className="font-data text-sm text-[color:var(--color-ink-900)]">
                    {money(e.amountBaseMinor, e.currency)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="rubric">{e.parseEngine}</span>
                    <Link href={`/ledger/${e.id}`} className="btn btn-quiet">
                      Inspect
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
            {result.failed.length > 0 ? (
              <Failure
                title={`${result.failed.length} line${result.failed.length === 1 ? "" : "s"} could not be written`}
                message="khata refused these rather than guessing. Fix them and write them again."
                fields={Object.fromEntries(result.failed.map((f) => [f.text.slice(0, 40), f.reason]))}
              />
            ) : null}
            <Link href="/settle" className="btn btn-primary">
              See who pays whom
            </Link>
          </div>
        </section>
      ) : null}

      {result?.kind === "failed" ? <Failure message={result.message} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CandidateCard({
  draft,
  household,
  today,
  onPatch,
}: {
  draft: Draft;
  household: Household;
  today: string;
  onPatch: (id: string, changes: Partial<Draft>) => void;
}) {
  const direction = draft.directionOverride ?? draft.direction.value;
  const amountEditable = draft.amountMinor.value !== null;

  const toggleParticipant = (memberId: string) => {
    const current = participantIds(draft, household);
    const next = current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId];
    // The reader's own detection is stored on participants; the participant ids
    // are resolved at write time from the member list, so a manual toggle just
    // rewrites the hidden participants field.
    onPatch(draft.id, {
      participantsResolved: next,
    } as Partial<Draft>);
  };

  const participants = participantIds(draft, household);

  return (
    <li
      className={`card p-4 ${draft.ready ? "border-l-4 border-l-[color:var(--color-moss-600)]" : "border-l-4 border-l-[color:var(--color-turmeric-500)]"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-[color:var(--color-madder-600)]"
            checked={draft.selected}
            onChange={(e) => onPatch(draft.id, { selected: e.target.checked })}
            disabled={!draft.ready}
          />
          <span className="min-w-0">
            <span className="block font-data text-sm leading-relaxed text-[color:var(--color-ink-900)]">
              &ldquo;{draft.text}&rdquo;
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rubric">
                {draft.engineUsed === "model" ? "model" : draft.engineUsed === "cloud" ? "cloud" : "rules"}
              </span>
              <span className="rubric">{Math.round(draft.confidence * 100)}% sure</span>
            </span>
          </span>
        </label>

        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className={`btn btn-quiet ${direction === "outflow" ? "bg-[color:var(--color-madder-600)] text-white" : ""}`}
            onClick={() => onPatch(draft.id, { directionOverride: "outflow" })}
            aria-pressed={direction === "outflow"}
          >
            Out
          </button>
          <button
            type="button"
            className={`btn btn-quiet ${direction === "inflow" ? "bg-[color:var(--color-moss-600)] text-white" : ""}`}
            onClick={() => onPatch(draft.id, { directionOverride: "inflow" })}
            aria-pressed={direction === "inflow"}
          >
            In
          </button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Field label="Amount" evidence={draft.amountMinor.evidence}>
          {amountEditable ? (
            <>
              <input
                type="number"
                step="0.01"
                className="field tabular"
                value={minorToInput(draft.amountMinor.value as number, draft.currency.value ?? household.baseCurrency)}
                onChange={(e) => {
                  const major = Number.parseFloat(e.target.value);
                  onPatch(draft.id, {
                    amountMinor: {
                      value: Number.isFinite(major) ? Math.round(major * 100) : null,
                      confidence: 1,
                      evidence: "typed by hand",
                    },
                  });
                }}
                aria-label="Amount"
              />
              <select
                className="field mt-1"
                value={draft.currency.value ?? household.baseCurrency}
                onChange={(e) => onPatch(draft.id, { currency: { value: e.target.value.toUpperCase(), confidence: 1, evidence: "chosen" } })}
                aria-label="Currency"
              >
                {[household.baseCurrency, "INR", "USD", "EUR", "GBP", "AED", "SGD"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-[color:var(--color-madder-600)]">no amount found</span>
          )}
        </Field>

        <Field label="Date" evidence={draft.occurredOn.evidence}>
          <input
            type="date"
            className="field tabular"
            value={draft.occurredOn.value ?? today}
            max={today}
            onChange={(e) =>
              onPatch(draft.id, { occurredOn: { value: e.target.value, confidence: 1, evidence: "chosen" } })
            }
            aria-label="Date"
          />
        </Field>

        <Field label="Paid by" evidence={draft.paidBy.evidence}>
          <select
            className="field"
            value={draft.paidBy.value ?? ""}
            onChange={(e) =>
              onPatch(draft.id, {
                paidBy: { value: e.target.value || null, confidence: 1, evidence: "chosen" },
              })
            }
            aria-label="Paid by"
          >
            <option value="">Nobody recorded</option>
            {household.members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Category" evidence={draft.category.evidence}>
          <select
            className="field"
            value={draft.category.value ?? "other"}
            onChange={(e) => onPatch(draft.id, { category: { value: e.target.value as Category, confidence: 1, evidence: "chosen" } })}
            aria-label="Category"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </Field>
      </dl>

      <div className="mt-3">
        <p className="rubric">Shared between</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {household.members.map((m) => {
            const on = participants.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className={`btn ${on ? "btn-primary" : "btn-quiet"}`}
                onClick={() => toggleParticipant(m.id)}
                aria-pressed={on}
              >
                {m.name}
              </button>
            );
          })}
        </div>
      </div>

      {draft.modelScores ? (
        <div className="mt-3 border-t border-[color:var(--color-rule)] pt-3">
          <p className="rubric">What the model said</p>
          <ul className="mt-1 space-y-1">
            {Object.entries(draft.modelScores)
              .sort((a, b) => b[1] - a[1])
              .map(([label, score]) => (
                <li key={label} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate text-[color:var(--color-ink-700)]">{label}</span>
                  <span className="h-1.5 flex-1 bg-[color:var(--color-rag-200)]">
                    <span
                      className="block h-1.5 bg-[color:var(--color-cloth-600)]"
                      style={{ width: `${Math.round(score * 100)}%` }}
                    />
                  </span>
                  <span className="tabular w-10 shrink-0 text-right font-data text-[color:var(--color-ink-500)]">
                    {(score * 100).toFixed(0)}%
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {draft.caveats.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {draft.caveats.map((c) => (
            <li key={c} className="text-xs text-[color:var(--color-turmeric-500)]">
              {c}
            </li>
          ))}
        </ul>
      ) : null}

      {!draft.ready ? (
        <p className="mt-2 text-xs text-[color:var(--color-ink-500)]">
          Not writeable yet — it needs an amount and a direction. Fix them above, or leave it out.
        </p>
      ) : null}
    </li>
  );
}

function Field({
  label,
  evidence,
  children,
}: {
  label: string;
  evidence: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="rubric flex items-center gap-1">
        {label}
        {evidence ? (
          <span className="font-data text-[10px] normal-case tracking-normal text-[color:var(--color-madder-600)]">
            from &ldquo;{evidence.slice(0, 22)}&rdquo;
          </span>
        ) : null}
      </dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/**
 * Which member ids this line charges.
 *
 * The reader works in names because that is what appears in a message. This is
 * the one place names become ids, and it happens at the edge so the rest of the
 * system only ever sees ids.
 */
function participantIds(draft: Draft, household: Household): string[] {
  const override = (draft as Draft & { participantsResolved?: string[] }).participantsResolved;
  if (override && override.length > 0) return override;
  const names = (draft.participants.value ?? []).map((n) => n.toLowerCase());
  const matched = household.members.filter((m) => names.includes(m.name.toLowerCase())).map((m) => m.id);
  if (matched.length > 0) return matched;
  return household.members.map((m) => m.id);
}

export function ReaderSkeleton() {
  return <Loading label="Opening the reader…" />;
}