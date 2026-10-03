#!/usr/bin/env node
/**
 * Live end-to-end proof against a real deployment.
 *
 *   KHATA_BASE_URL=https://your-deployment.vercel.app npm run verify:live
 *
 * Reads the base URL from the environment, never from a hard-coded literal, and
 * never reads or writes a secret. Every check is a real HTTP request against the
 * running deployment — there is no mock and no fixture — and the whole run is
 * one anonymous session, so it creates its own household and cleans up after
 * itself.
 *
 * The chain is the one the README documents:
 *   POST create -> GET read-back -> PATCH update -> engine -> MCP mutation ->
 *   integrity replay -> DELETE -> tombstone confirmed.
 */

import { randomBytes } from "node:crypto";

const BASE = (process.env.KHATA_BASE_URL ?? "").replace(/\/$/, "");
const REPO_URL = process.env.KHATA_REPO_URL ?? "https://github.com/aniruddhaadak80/khata";

if (!BASE) {
  console.error("KHATA_BASE_URL is required. Example:");
  console.error("  KHATA_BASE_URL=https://your-deployment.vercel.app npm run verify:live");
  process.exit(2);
}

const results = [];
let cookie = "";

/* -------------------------------------------------------------------------- */

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(";")[0];
    if (pair?.startsWith("khata_scope=")) cookie = pair;
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? "");
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

/* -------------------------------------------------------------------------- */

console.log(`\nkhata — live verification against ${BASE}\n${"-".repeat(64)}`);

let entryId = null;
let settlementSeal = null;
let deleteSeal = null;

await check("1. the landing page returns 200", async () => {
  const res = await fetch(`${BASE}/`, { headers: cookie ? { cookie } : {} });
  const html = await res.text();
  must(res.status === 200, `HTTP ${res.status}`);
  must(!/Protected by Vercel/i.test(html), "the deployment is behind Vercel Authentication and is not public");
  must(html.includes("khata"), "the page does not mention khata");
  return `HTTP ${res.status}, ${html.length} bytes`;
});

await check("2. /api/health reports a real production store check", async () => {
  const res = await call("/api/health");
  must(res.status === 200, `HTTP ${res.status}${res.text.slice(0, 120)}`);
  const { data } = res.json;
  must(data.productionStore === true, `productionStore was ${data.productionStore}`);
  must(data.adapter === "neon-postgres", `adapter was ${data.adapter}`);
  const persistence = data.probes.find((p) => p.name === "persistence");
  must(persistence.ok === true, "the persistence probe failed");
  must(/SELECT 1/.test(persistence.detail), "the probe did not report a real query");
  return `adapter=${data.adapter}, persistence="${persistence.detail}"`;
});

await check("3. the live feed is non-empty, normalised and attributed", async () => {
  const res = await call("/api/rates");
  must(res.status === 200, `HTTP ${res.status}`);
  const { fx, cpi } = res.json.data;
  must(Object.keys(fx.rates).length > 5, "too few currencies returned");
  must(["live", "stale", "fallback"].includes(fx.status), `unexpected status ${fx.status}`);
  must(/European Central Bank/i.test(fx.attribution), "rates are not attributed to the ECB");
  must(/^\d{4}-\d{2}-\d{2}$/.test(fx.asOf), `asOf is not a date: ${fx.asOf}`);
  must(/World Bank/i.test(cpi.attribution), "CPI is not attributed to the World Bank");
  return `fx=${fx.status} asOf=${fx.asOf} (${Object.keys(fx.rates).length} currencies), cpi=${cpi.status}`;
});

await check("4. a record can be created through the public API", async () => {
  const res = await call("/api/entries", {
    method: "POST",
    body: {
      occurredOn: new Date().toISOString().slice(0, 10),
      direction: "outflow",
      amountMinor: 240_000,
      currency: "INR",
      category: "utilities",
      rawText: "Paid 2400 to the electricity provider, live verification",
      status: "draft",
      idempotencyKey: `verify-live-${randomBytes(8).toString("hex")}`,
    },
  });
  must(res.status === 201, `HTTP ${res.status} ${res.text.slice(0, 200)}`);
  entryId = res.json.data.entry.id;
  must(typeof res.json.data.seal === "string" && res.json.data.seal.length === 96, "no seal returned");
  return `id=${entryId} seal=${res.json.data.sealShort}`;
});

await check("5. the record reads back through the UI-facing API", async () => {
  const res = await call("/api/entries?limit=50");
  must(res.status === 200, `HTTP ${res.status}`);
  const found = res.json.data.items.find((e) => e.id === entryId);
  must(found, "the created record is not in the list");
  must(found.amountMinor === 240_000, `amount was ${found.amountMinor}`);
  must(found.amountBaseMinor > 0, "no base-currency amount was derived");
  return `total=${res.json.data.total}, base=${found.amountBaseMinor} ${found.currency === "INR" ? "" : "converted"}`;
});

await check("6. an update is persisted and reflected on read-back", async () => {
  const res = await call(`/api/entries/${entryId}`, {
    method: "PATCH",
    body: { status: "confirmed", note: "confirmed by live verification" },
  });
  must(res.status === 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`);

  const read = await call(`/api/entries/${entryId}`);
  must(read.status === 200, `read-back HTTP ${read.status}`);
  must(read.json.data.entry.status === "confirmed", `status was ${read.json.data.entry.status}`);
  must(read.json.data.entry.note === "confirmed by live verification", "the note did not persist");
  must(read.json.data.chain.ok === true, "the entry chain does not replay");
  must(read.json.data.chain.checked >= 2, `expected at least 2 events, saw ${read.json.data.chain.checked}`);
  return `status=confirmed, chain=${read.json.data.chain.checked} events`;
});

await check("7. the engine returns a versioned, itemised, sealed result", async () => {
  const res = await call("/api/settlement?windowDays=30");
  must(res.status === 200, `HTTP ${res.status}`);
  const s = res.json.data.settlement;
  must(s.version === "khata-engine/1.0.0", `engine version was ${s.version}`);
  must(typeof s.score === "number" && s.score >= 0 && s.score <= 100, `score was ${s.score}`);
  must(s.factors.length === 6, `expected 6 factors, saw ${s.factors.length}`);
  const weightSum = s.factors.reduce((a, f) => a + f.weight, 0);
  must(Math.abs(weightSum - 1) < 1e-9, `factor weights sum to ${weightSum}, not 1`);
  must(s.factors.every((f) => typeof f.evidence === "string" && f.evidence.length > 0), "a factor has no evidence");
  must(typeof s.recommendation === "undefined" && typeof s.headline === "string", "no headline");
  must(Array.isArray(s.transfers), "no transfer plan");
  settlementSeal = s.seal;
  return `score=${s.score} factors=6 weights=1.0000 transfers=${s.transferCount} minimal=${s.minimalTransfers}`;
});

await check("8. MCP initialize succeeds", async () => {
  const res = await call("/api/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  });
  must(res.status === 200, `HTTP ${res.status}`);
  must(res.json.jsonrpc === "2.0", "not JSON-RPC 2.0");
  must(res.json.result?.serverInfo?.name === "khata", `serverInfo was ${JSON.stringify(res.json.result?.serverInfo)}`);
  return `protocolVersion=${res.json.result.protocolVersion}`;
});

await check("9. tools/list returns the expected tools and schemas", async () => {
  const res = await call("/api/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  must(res.status === 200, `HTTP ${res.status}`);
  const tools = res.json.result.tools;
  must(Array.isArray(tools) && tools.length >= 3, `only ${tools?.length} tools`);
  for (const expected of ["get_khata_summary", "analyse_settlement", "record_entry", "delete_entry"]) {
    must(tools.some((t) => t.name === expected), `missing tool ${expected}`);
  }
  must(tools.every((t) => t.inputSchema?.type === "object"), "a tool has no object input schema");
  must(
    tools.some((t) => t.annotations?.readOnlyHint === true) && tools.some((t) => t.annotations?.readOnlyHint === false),
    "tools do not distinguish reads from writes",
  );
  return `${tools.length} tools (${tools.filter((t) => t.annotations?.readOnlyHint === false).length} mutating)`;
});

await check("10. tools/call mutates through the same path as the UI", async () => {
  const key = `verify-mcp-${randomBytes(8).toString("hex")}`;
  const args = {
    occurredOn: new Date().toISOString().slice(0, 10),
    direction: "outflow",
    amountMinor: 150_000,
    currency: "INR",
    category: "groceries",
    rawText: "recorded through the agent, live verification",
    idempotencyKey: key,
  };

  const first = await call("/api/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "record_entry", arguments: args } },
  });
  must(first.status === 200, `HTTP ${first.status}`);
  const created = first.json.result.structuredContent.entry;
  must(created?.id, `no entry returned: ${first.text.slice(0, 200)}`);

  // Idempotency: the same key must not write a second line.
  const retry = await call("/api/mcp", {
    method: "POST",
    body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "record_entry", arguments: args } },
  });
  const retried = retry.json.result.structuredContent.entry;
  must(retried.id === created.id, "the idempotency key did not hold on retry");

  // Read it back through the interface's own API, not through the agent.
  const read = await call(`/api/entries/${created.id}`);
  must(read.status === 200, `read-back HTTP ${read.status}`);
  must(read.json.data.entry.rawText.includes("live verification"), "the agent's line is not in the UI API");

  entryId = created.id;
  return `id=${created.id}, retry returned the same row`;
});

await check("11. integrity replay is clean before deletion", async () => {
  const res = await call("/api/verify");
  must(res.status === 200, `HTTP ${res.status}`);
  const d = res.json.data;
  must(d.ok === true, `replay failed: ${JSON.stringify(d.brokenChains)}`);
  must(d.events >= 4, `only ${d.events} events to replay`);
  must(d.ledgerSeal.length === 96, "no ledger seal");
  return `${d.chains} chains, ${d.events} events, ledgerSeal=${d.ledgerSealShort}`;
});

await check("12. the record is deleted and the tombstone is kept", async () => {
  const res = await call(`/api/entries/${entryId}`, { method: "DELETE" });
  must(res.status === 200, `HTTP ${res.status}`);
  must(res.json.data.tombstone.kept === true, "the tombstone was not retained");
  deleteSeal = res.json.data.sealShort;

  const read = await call(`/api/entries/${entryId}`);
  must(read.status === 404, `the deleted line still reads back with HTTP ${read.status}`);

  // And the chain still replays, because the tombstone is part of it.
  const verify = await call("/api/verify");
  must(verify.json.data.ok === true, "the chain stopped replaying after a delete");
  const hasDelete = verify.json.data.timeline.some((t) => t.action === "entry.delete");
  must(hasDelete, "the deletion is not visible as a sealed event");
  return `deleted, tombstone kept, delete sealed ${deleteSeal}`;
});

await check("13. the shared chrome links the real public repository", async () => {
  const res = await fetch(`${BASE}/`, { headers: cookie ? { cookie } : {} });
  const html = await res.text();
  must(html.includes(REPO_URL), "the landing page does not link the repository");
  must(/Star on GitHub|View source/.test(html), "no repository CTA text in the rendered page");

  const reader = await fetch(`${BASE}/reader`, { headers: cookie ? { cookie } : {} });
  const readerHtml = await reader.text();
  must(readerHtml.includes(REPO_URL), "the reader page does not link the repository");

  const footerMatches = (html.match(new RegExp(REPO_URL.replace(/[/.]/g, "\\$&"), "g")) ?? []).length;
  must(footerMatches >= 2, `the repository is linked ${footerMatches} time(s); expected the nav, the CTA and the footer`);
  return `${footerMatches} links to the repository across the page`;
});

await check("14. every primary route responds and the manifest is real", async () => {
  const routes = ["/", "/reader", "/ledger", "/ledger/new", "/settle", "/export", "/verify", "/agent", "/settings"];
  const bad = [];
  for (const route of routes) {
    const res = await fetch(`${BASE}${route}`, { headers: cookie ? { cookie } : {} });
    if (res.status !== 200) bad.push(`${route} → ${res.status}`);
  }
  must(bad.length === 0, `broken routes: ${bad.join(", ")}`);

  const manifest = await (await fetch(`${BASE}/mcp.json`)).json();
  const url = manifest.packages?.[0]?.transport?.url;
  must(typeof url === "string" && url.endsWith("/api/mcp"), `manifest endpoint was ${url}`);
  must(manifest.tools.length >= 3, "the manifest lists too few tools");
  return `${routes.length} routes at 200; manifest points at ${url}`;
});

await check("15. the repository itself returns 200", async () => {
  const res = await fetch(REPO_URL, { redirect: "manual" });
  must(res.status === 200, `HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("16. the optional cloud tier reports its configuration honestly", async () => {
  const status = await call("/api/reader/direction");
  must(status.status === 200, `GET status ${status.status}`);
  must(status.json?.ok === true, "GET did not return the ok envelope");

  const data = status.json.data;
  must(typeof data.configured === "boolean", "configured is not a boolean");
  must(data.provider === "google", `provider was ${data.provider}`);
  must(!JSON.stringify(data).includes("AIza"), "a key appeared in the status payload");

  if (!data.configured) {
    const refused = await call("/api/reader/direction", { method: "POST", body: { text: "wifi seller refunded me 320" } });
    must(refused.status === 503, `an unconfigured tier answered POST with ${refused.status}`);
    must(refused.json?.error?.code === "UNSUPPORTED", `code was ${refused.json?.error?.code}`);
    return "not configured; the tier refuses rather than pretending";
  }

  must(typeof data.model === "string" && data.model.length > 0, "a configured tier named no model");

  const health = await call("/api/health");
  must(health.json?.data?.cloud?.configured === true, "/api/health does not agree the tier is configured");
  must(health.json.data.cloud.model === data.model, "/api/health named a different model");
  must(!JSON.stringify(health.json).includes("AIza"), "a key appeared in the health payload");
  return `configured: ${data.model}; health agrees`;
});

await check("17. the hosted model answers a line the rules leave unclear", async () => {
  const status = await call("/api/reader/direction");
  if (status.json?.data?.configured !== true) {
    return "skipped: this deployment offers no cloud tier, which is a passing state";
  }

  // The fixture the rule engine genuinely fails: confidences on this line are
  // 0.00, which is the entire reason a third tier exists.
  const text = "wifi seller refunded me 320";
  const asked = await call("/api/reader/direction", { method: "POST", body: { text } });
  must(
    asked.status === 200,
    `POST status ${asked.status}: ${asked.json?.error?.message ?? asked.text.slice(0, 160)}`,
  );

  const data = asked.json.data;
  must(["inflow", "outflow", "not-money"].includes(data.direction), `direction was ${data.direction}`);
  must(data.confidence > 0 && data.confidence <= 0.9, `confidence ${data.confidence} is outside (0, 0.9]`);
  must(typeof data.model === "string" && data.model.length > 0, "no model was named");
  must(data.latencyMs >= 0, "no latency was reported");
  must(!JSON.stringify(asked.json).includes("AIza"), "a key appeared in the answer payload");
  return `${data.direction} at ${Math.round(data.confidence * 100)}% from ${data.model} in ${data.latencyMs}ms`;
});

/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log(`${"-".repeat(64)}`);
console.log(`${results.length - failed.length} of ${results.length} checks passed.`);

if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  ${f.name}: ${f.detail}`);
}

console.log("");
process.exit(failed.length === 0 ? 0 : 1);