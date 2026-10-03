import { expect, test, type Page } from "@playwright/test";

/**
 * The primary journey, exercised through visible controls only.
 *
 *   paste messages → write → inspect → decide → run the engine → stamp →
 *   agent mutation → read it back in the UI → export → share → delete →
 *   replay the chain
 *
 * It runs as **one** test in **one** browser context on purpose. khata has no
 * accounts: a household belongs to an anonymous HTTP-only cookie, so a fresh
 * Playwright context is a brand new household with an empty book. Splitting the
 * loop across tests would therefore be testing four different empty ledgers.
 *
 * Every assertion is about something a person can see. No test reaches into
 * internals, and the run fails on any console error or server 5xx, because a
 * page that throws after render looks identical to one that works right up
 * until you use it.
 */

const CONSOLE_ERRORS: string[] = [];
const FAILED_REQUESTS: string[] = [];

/**
 * The one console error the run is allowed to contain.
 *
 * The Reader deliberately probes for a local Ollama daemon on 127.0.0.1:11434
 * so it can tell you whether local inference is available. On a machine with no
 * Ollama running, that fetch fails, and Chrome logs every failed fetch as a
 * console error whatever the application does about it. The application handles
 * it — the UI says plainly that no daemon was found and why — so the allowlist
 * is this exact string, not a pattern.
 */
const EXPECTED_CONSOLE_NOISE = "Failed to load resource: net::ERR_CONNECTION_REFUSED";

function watch(page: Page) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text() === EXPECTED_CONSOLE_NOISE) return;
    CONSOLE_ERRORS.push(message.text());
  });
  page.on("pageerror", (error) => CONSOLE_ERRORS.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    // Aborted navigations are normal. The Ollama probe is expected to fail when
    // no local daemon is running, and it is identified by its URL rather than
    // by a message that could belong to anything.
    if (/aborted|canceled/i.test(failure)) return;
    if (request.url().includes(":11434/")) return;
    FAILED_REQUESTS.push(`${request.url()} ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) FAILED_REQUESTS.push(`${response.url()} ${response.status()}`);
  });
}

test.describe.configure({ mode: "serial" });

/* -------------------------------------------------------------------------- */

test("health reports a real persistence check", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data.engine).toBe("khata-engine/1.0.0");

  const persistence = body.data.probes.find((p: { name: string }) => p.name === "persistence");
  expect(persistence.ok).toBe(true);
  // A health route that only returns a literal would not say this.
  expect(persistence.detail).toMatch(/SELECT 1/);

  const fx = body.data.probes.find((p: { name: string }) => p.name === "fx-feed");
  expect(fx.ok).toBe(true);
  expect(["live", "stale", "fallback"]).toContain(fx.status);
  expect(fx.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("live feed is normalised, attributed and dated", async ({ request }) => {
  const response = await request.get("/api/rates");
  expect(response.status()).toBe(200);
  const { data } = await response.json();
  expect(Object.keys(data.fx.rates).length).toBeGreaterThan(5);
  expect(data.fx.attribution).toMatch(/European Central Bank/i);
  expect(data.fx.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(data.fx.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(data.cpi.attribution).toMatch(/World Bank/i);
  expect(data.cpi.series.length).toBeGreaterThan(0);
});

test("the deterministic reader is honest about every field", async ({ request }) => {
  const response = await request.post("/api/parse", {
    data: {
      text: "Paid 2400 to BESCOM, Arunima paid half\nreceived refund 320 from the wifi seller\njust saying hello",
      today: "2026-10-03",
    },
  });
  expect(response.status()).toBe(200);
  const { data } = await response.json();
  // Four, not three: the comma in "BESCOM, Arunima paid half" splits the run-on
  // line in two, and the fragment with no amount of its own is reported rather
  // than dropped.
  expect(data.candidates).toHaveLength(4);

  // Money moved out, and money moved in.
  const directions = data.candidates.map((c: { direction: { value: string } }) => c.direction.value);
  expect(directions.filter((d: string) => d === "outflow").length).toBeGreaterThanOrEqual(1);
  expect(directions.filter((d: string) => d === "inflow").length).toBeGreaterThanOrEqual(1);

  // The unreadable line is reported, not dropped.
  const unreadable = data.candidates.filter((c: { ready: boolean }) => !c.ready);
  expect(unreadable.length).toBeGreaterThanOrEqual(1);
  expect(unreadable[0].caveats.length).toBeGreaterThan(0);

  // Every field carries the substring it came from.
  const withAmount = data.candidates.find((c: { amountMinor: { value: number | null } }) => c.amountMinor.value !== null);
  expect(withAmount.amountMinor.evidence).toBeTruthy();
});

test("a validation failure is a 422 with field detail, not a 500", async ({ request }) => {
  const bad = await request.post("/api/entries", { data: { direction: "outflow" } });
  expect(bad.status()).toBe(422);
  const body = await bad.json();
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(Object.keys(body.error.fields).length).toBeGreaterThan(0);

  const notFound = await request.get("/api/entries/00000000-0000-0000-0000-000000000000");
  expect(notFound.status()).toBe(404);
  expect((await notFound.json()).error.code).toBe("NOT_FOUND");
});

test("the cloud tier tells the truth about itself, either way", async ({ request }) => {
  // The invariant is the same on a keyed deployment and a keyless one: the
  // status must be honest, no key may ever appear in a response, and the
  // answer to a real line must match what the status promised. Read the
  // status first, then hold the POST to it.
  const status = await request.get("/api/reader/direction");
  expect(status.status()).toBe(200);
  const { data } = await status.json();
  expect(typeof data.configured).toBe("boolean");
  expect(data.provider).toBe("google");
  expect(JSON.stringify(data)).not.toContain("AIza");

  const asked = await request.post("/api/reader/direction", {
    data: { text: "wifi seller refunded me 320" },
  });

  if (data.configured) {
    expect(asked.status()).toBe(200);
    const body = await asked.json();
    expect(["inflow", "outflow", "not-money"]).toContain(body.data.direction);
    expect(body.data.confidence).toBeGreaterThan(0);
    // Capped: a hosted model's self-assessment may not claim to outrank a
    // rule the engine measured.
    expect(body.data.confidence).toBeLessThanOrEqual(0.9);
    expect(body.data.model).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("AIza");
  } else {
    expect(asked.status()).toBe(503);
    const body = await asked.json();
    expect(body.error.code).toBe("UNSUPPORTED");
    expect(body.error.message).toMatch(/not configured/i);
  }
});

test("the reader offers a cloud control only when the server says there is one", async ({ page }) => {
  // Ask the server first, then hold the interface to the answer: a keyed
  // deployment must offer the control, a keyless one must not render it at all.
  const status = await page.request.get("/api/reader/direction");
  const { data } = await status.json();

  await page.goto("/reader");
  const control = page.getByRole("button", { name: /Re-decide directions with the cloud model/ });

  if (data.configured) {
    await expect(control).toBeVisible();
    const escaped = String(data.model).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(page.getByText(new RegExp(escaped))).toBeVisible();
  } else {
    await expect(control).toHaveCount(0);
    // Absent does not mean degraded: the in-browser tier is still offered.
    await expect(page.getByRole("button", { name: /Download 28 MB model/ })).toBeVisible();
  }
});

/* -------------------------------------------------------------------------- */
/* The journey. One context, one household, start to finish.                     */
/* -------------------------------------------------------------------------- */

test("the primary journey works end to end", async ({ page }) => {
  // Generous, because every step here is a real write against a real hosted
  // Postgres and a real exchange-rate fetch. It is not a mock, and pretending
  // otherwise by shrinking the timeout would only hide it.
  test.setTimeout(240_000);
  watch(page);

  /* --- 1. Create and import, through the reader ---------------------------- */

  await page.goto("/reader");
  await page.getByRole("button", { name: "Use the worked example" }).click();
  await expect(page.locator("#reader-text")).toHaveValue(/BESCOM/);

  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByRole("heading", { name: /lines read/ })).toBeVisible();

  // Every segment is listed, including the ones that could not be read.
  const unreadable = page.getByText(/Not writeable yet/);
  await expect(unreadable.first()).toBeVisible();

  // Per-field evidence is on screen, not hidden behind one average.
  await expect(page.getByText(/from “/).first()).toBeVisible();

  // The open-weight model is offered, and says it is not loaded rather than
  // pretending to be ready.
  await expect(page.getByText("Not loaded. The rule engine above works without it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download 28 MB model/ })).toBeVisible();

  await page.getByRole("button", { name: /Write \d+ lines? to the ledger/ }).click();
  await expect(page.getByRole("heading", { name: "Written to the ledger" })).toBeVisible();

  const written = await page.getByRole("link", { name: "Inspect" }).count();
  expect(written).toBeGreaterThanOrEqual(3);

  /* --- 2. The lines really persisted -------------------------------------- */

  await page.goto("/ledger");
  await expect(page.getByRole("link", { name: /Meera sent me back/ })).toBeVisible();

  // Filters live in the address bar, so the view survives a refresh.
  await page.getByLabel("Status").selectOption("draft");
  await expect(page).toHaveURL(/status=draft/);
  await page.reload();
  await expect(page.getByLabel("Status")).toHaveValue("draft");
  await page.getByLabel("Status").selectOption("all");
  await expect(page).not.toHaveURL(/status=draft/);

  /* --- 3. Inspect and decide --------------------------------------------- */

  await page.locator("main ul > li a").first().click();
  await expect(page.getByRole("heading", { name: "The evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Its chain" })).toBeVisible();
  const chainBefore = await page.getByRole("heading", { name: "Its chain" }).locator("xpath=../p[@class]").first().innerText();

  await page.getByRole("button", { name: "Mark agreed" }).click();
  await page.getByRole("button", { name: "Save and seal" }).click();
  await expect(page.getByText(/Saved and sealed/)).toBeVisible();
  await expect(page.getByText("entry.confirm").first()).toBeVisible();

  await page.getByRole("button", { name: "Mark disputed" }).click();
  await page.getByRole("button", { name: "Save and seal" }).click();
  await expect(page.getByText("entry.dispute").first()).toBeVisible();

  const entryPath = new URL(page.url()).pathname;
  expect(chainBefore).toBeTruthy();

  /* --- 4. Run the engine -------------------------------------------------- */

  await page.goto("/settle");
  await expect(page.getByText(/trust score \/ 100/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What the score is made of" })).toBeVisible();
  await expect(page.getByText(/weight 0\.22/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "The beam" })).toBeVisible();

  // The signature is never the only way to read the numbers.
  await expect(page.getByRole("table")).toBeVisible();

  await page.getByRole("button", { name: "Press the stamp" }).click();
  await expect(page.getByText(/Settlement sealed/)).toBeVisible();

  /* --- 5. The agent mutates through the same service layer ---------------- */

  await page.goto("/agent");
  await expect(page.getByText("initialised")).toBeVisible();
  // Tool names render as code, which is what an MCP client reads too.
  await expect(page.locator("main code").filter({ hasText: /^record_entry$/ })).toBeVisible();
  await expect(page.locator("main code").filter({ hasText: /^analyse_settlement$/ })).toBeVisible();
  await expect(page.locator("main code").filter({ hasText: /^delete_entry$/ })).toBeVisible();

  await page.getByRole("button", { name: "analyse_settlement" }).click();
  await expect(page.getByText("tools/call analyse_settlement").first()).toBeVisible();

  await page.getByRole("button", { name: "record_entry", exact: true }).click();
  await expect(page.getByText(/The agent wrote/)).toBeVisible();

  const agentHref = await page.getByRole("link", { name: "open it" }).getAttribute("href");
  expect(agentHref).toMatch(/^\/ledger\/[0-9a-f-]{36}$/);

  // Read it back through the interface, not through the agent.
  await page.goto(agentHref as string);
  await expect(page.getByRole("heading", { name: /Its chain/ })).toBeVisible();
  await expect(page.getByText("Written by")).toBeVisible();

  /* --- 6. Idempotency: the same key writes one line, not two -------------- */

  await page.goto("/ledger");
  const beforeRetry = await page.locator("main ul > li").count();
  await page.goto("/agent");
  await page.getByRole("button", { name: "record_entry", exact: true }).click();
  await expect(page.getByText(/The agent wrote/)).toBeVisible();
  await page.goto("/ledger");
  await expect(page.locator("main ul > li")).toHaveCount(beforeRetry);

  /* --- 7. Export and share ------------------------------------------------ */

  await page.goto("/export");
  await expect(page.getByRole("link", { name: /Markdown statement/ })).toHaveAttribute(
    "href",
    "/api/export?format=md",
  );

  const csv = await page.request.get("/api/export?format=csv");
  expect(csv.status()).toBe(200);
  const csvBody = await csv.text();
  expect(csvBody).toContain("occurred_on");
  expect(csvBody.split("\r\n").length).toBeGreaterThan(3);

  const md = await page.request.get("/api/export?format=md");
  expect(md.status()).toBe(200);
  expect(await md.text()).toMatch(/Who pays whom/);

  await page.getByRole("button", { name: "Create a statement link" }).click();
  await expect(page.getByText(/Anyone with this link can read this statement/)).toBeVisible();

  const statementUrl = (await page.locator("code").first().textContent()) ?? "";
  expect(statementUrl).toMatch(/^https?:\/\/[^/]+\/statement\/[A-Za-z0-9_-]{22,}$/);

  // The link opens in a new tab, because a statement is meant to be sent to
  // someone else rather than navigated to in place.
  const [statement] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("link", { name: "Open it" }).click(),
  ]);
  await statement.waitForLoadState("domcontentloaded");
  await expect(statement.getByRole("heading", { name: "Who pays whom" })).toBeVisible();
  await expect(statement.getByRole("heading", { name: "Provenance" })).toBeVisible();

  // A statement holds real names and amounts, so it must never be indexed.
  const robots = await statement.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toMatch(/noindex/i);

  // And it must not be crawlable at all.
  const robotsTxt = await page.request.get("/robots.txt");
  expect(await robotsTxt.text()).toMatch(/Disallow: \/statement\//);
  await statement.close();

  /* --- 8. Integrity replay ------------------------------------------------ */

  await page.goto("/verify");
  await expect(page.getByText("Every chain replays clean")).toBeVisible();
  await expect(page.getByText("settlement.stamp").first()).toBeVisible();
  await expect(page.getByText(/SHA-384\( UTF-8\(prevSeal\)/)).toBeVisible();

  /* --- 9. Delete through the interface ------------------------------------ */

  // Count the book, remove one line, and prove the count fell. Matching on the
  // amount text instead would be a trap: "1250.00 INR" contains "250.00 INR",
  // and getByText matches on substrings.
  await page.goto("/ledger");
  // Wait for the book to actually load before counting it, or the count is the
  // empty state rather than the rows.
  await expect(page.locator("main ul > li").first()).toBeVisible();
  const beforeDelete = await page.locator("main ul > li").count();
  expect(beforeDelete).toBeGreaterThan(0);

  await page.goto(entryPath);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page).toHaveURL(/\/ledger(\?.*)?$/);
  await expect(page.locator("main ul > li")).toHaveCount(beforeDelete - 1);

  // Gone from the book, but still provable.
  await page.goto("/verify");
  await expect(page.getByText("Every chain replays clean")).toBeVisible();
  await expect(page.getByText("entry.delete").first()).toBeVisible();

  /* --- 10. The repository is reachable from the shared chrome -------------- */

  const repoUrl = "https://github.com/aniruddhaadak80/khata";
  const nav = page.locator(`header a[href="${repoUrl}"]`).first();
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute("rel", /noopener/);
  await expect(nav).toHaveAttribute("target", "_blank");
  await expect(page.locator(`footer a[href="${repoUrl}"]`).first()).toBeAttached();

  const response = await page.request.get(repoUrl);
  expect(response.status()).toBe(200);
});

/* -------------------------------------------------------------------------- */

test("every page loads with the repository link in the chrome", async ({ page }) => {
  watch(page);
  const repoUrl = "https://github.com/aniruddhaadak80/khata";
  const routes = ["/", "/reader", "/ledger", "/ledger/new", "/settle", "/export", "/verify", "/agent", "/settings"];

  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} should be 200`).toBe(200);
    const link = page.locator(`header a[href="${repoUrl}"]`).first();
    await expect(link, `${route} header should link the repository`).toBeVisible();
    await expect(page.locator(`footer a[href="${repoUrl}"]`).first()).toBeAttached();
  }

  // The mobile menu carries the same link.
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator(`#khata-mobile-nav a[href="${repoUrl}"]`)).toBeVisible();
  }

  await page.goto("/mcp.json");
  const manifest = JSON.parse((await page.locator("body").textContent()) ?? "{}");
  expect(manifest.packages[0].transport.url).toMatch(/\/api\/mcp$/);
  expect(manifest.tools.length).toBeGreaterThanOrEqual(3);
});

test("the agent endpoint speaks JSON-RPC 2.0 and refuses nonsense properly", async ({ request }) => {
  const init = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  });
  expect(init.status()).toBe(200);
  const initBody = await init.json();
  expect(initBody.jsonrpc).toBe("2.0");
  expect(initBody.result.serverInfo.name).toBe("khata");

  const list = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  const tools = (await list.json()).result.tools;
  expect(tools.length).toBeGreaterThanOrEqual(3);
  expect(tools.some((t: { name: string }) => t.name === "record_entry")).toBe(true);

  const unknown = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 3, method: "nope" } });
  expect((await unknown.json()).error.code).toBe(-32601);

  const badVersion = await request.post("/api/mcp", { data: { jsonrpc: "1.0", id: 4, method: "initialize" } });
  expect((await badVersion.json()).error.code).toBe(-32600);

  const unknownTool = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delete_everything" } },
  });
  expect((await unknownTool.json()).error.code).toBe(-32602);
});

test("keyboard navigation reaches the content and focus is visible", async ({ page }) => {
  watch(page);
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();

  const outline = await skip.evaluate((node) => {
    const style = window.getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe("none");
  expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);

  await expect(page.locator("main#main")).toHaveCount(1);
  await expect(page.locator("footer")).toHaveCount(1);
  await expect(page.locator('nav[aria-label="Primary"]')).toBeAttached();

  // Tabbing reaches real controls rather than trapping.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  const tag = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]).toContain(tag);
});

test("the hand-entry form writes a line using the default household", async ({ page }) => {
  // A real write against real Postgres, so it gets the same slack as the
  // primary journey rather than a shrunken timeout that would hide a stall.
  test.setTimeout(180_000);
  watch(page);

  await page.goto("/ledger/new");

  // The defaults this test is about sit behind the collapsed "Everything
  // else" panel, so open it rather than reading hidden inputs.
  await page.getByRole("button", { name: "The rest of the fields" }).click();
  await expect(page.locator("#advanced-body")).toBeVisible();

  // Defaults are the point: paid-by is `me` and participants are every
  // member, and both ids are shorter than the 3-character minimum the input
  // schema used to demand, so this form could not save its own default.
  await expect(page.locator("#n-payer")).toHaveValue("me");
  await expect(page.getByRole("button", { name: "You", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Flatmate", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.locator("#n-amount").fill("350");
  await page.getByRole("button", { name: "Write and seal" }).click();

  // Refusal would render the failure card, not this heading.
  await expect(page.getByRole("heading", { name: "Written and sealed" })).toBeVisible();
  await expect(page.getByText(/khata refused that/)).toHaveCount(0);

  // And it is a real, sealed line rather than a success message.
  await page.getByRole("link", { name: "Inspect the line" }).click();
  await expect(page).toHaveURL(/\/ledger\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "The evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Its chain" })).toBeVisible();

  // The engine can settle a book that includes it.
  await page.goto("/settle");
  await expect(page.getByText(/trust score \/ 100/)).toBeVisible();
});

test("nothing logged a console error or a server failure", async () => {
  expect(CONSOLE_ERRORS, `console errors:\n${CONSOLE_ERRORS.join("\n")}`).toEqual([]);
  expect(FAILED_REQUESTS, `failed requests:\n${FAILED_REQUESTS.join("\n")}`).toEqual([]);
});