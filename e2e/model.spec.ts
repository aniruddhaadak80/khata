import { expect, test } from "@playwright/test";

/**
 * Proves the claim the whole "open beat closed" argument rests on: the
 * open-weights model really does download and run inside the browser, and it
 * really does decide the directions the rule engine cannot.
 *
 * Two fixtures, chosen because the rules genuinely fail on them in the two
 * different ways that matter — and both fail *quietly*, which is why they are
 * worth a real browser to prove:
 *
 *   "wifi seller refunded me 320"  rules: unclear, confidence 0.00 — gives up
 *   "reimbursed 320 to the shop"    rules: inflow,  confidence 0.90 — sure, and wrong
 *
 * The first is the whole reason the model is in the product: the rules refuse
 * to call it, so something has to. The second is the reason it does not run on
 * everything — a line the rules are already 0.90 sure about is not worth 28 MB
 * of inference, and must come back still badged "rules".
 *
 * Both are also a fair sample of the real input: a refund is the one message
 * where the direction words and the money words point in opposite directions.
 *
 * Opt-in: `KHATA_MODEL_E2E=1 npx playwright test e2e/model.spec.ts`
 * Skipped by default because it fetches ~28 MB from the Hugging Face CDN, and
 * a test run must not depend on a third-party CDN being reachable.
 */
const run = process.env.KHATA_MODEL_E2E === "1";

test.skip(!run, "set KHATA_MODEL_E2E=1 to download the model and prove inference");

const GAVE_UP = "wifi seller refunded me 320";
const CONFIDENTLY_WRONG = "reimbursed 320 to the shop";

test("the open-weight model loads in the browser and decides a direction the rules refused", async ({ page }) => {
  // A cold 28 MB download plus real onnxruntime-web inference on a headless CPU
  // is minutes, not seconds. Playwright's 300s default kills it mid-run.
  test.setTimeout(900_000);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The Ollama probe asks 127.0.0.1:11434 whether a daemon is there. On any
    // machine without one the browser logs a refused connection, and the app
    // handles it in plain language on the page. That is the optional path
    // working, not a defect, so it is the one error allowed through.
    if (m.text().includes("ERR_CONNECTION_REFUSED")) return;
    consoleErrors.push(m.text());
  });

  await page.goto("/reader");

  // The rule engine reads first, so there are drafts for the model to re-decide.
  await page.getByLabel("Payment messages to read").fill(`${GAVE_UP}\n${CONFIDENTLY_WRONG}`);
  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByRole("list").locator("li", { hasText: GAVE_UP })).toBeVisible();

  // Download it. Generous: cold cache, real network, ~28 MB.
  const download = page.getByRole("button", { name: /Download 28 MB model/ });
  await expect(download).toBeVisible();
  await download.click();

  // Either it loads or it reports precisely why it did not. Both are honest
  // outcomes; a silent hang is not.
  const loaded = page.getByText("Loaded. It is cached in this browser now");
  const failed = page.getByText("The model could not start");
  await expect(loaded.or(failed)).toBeVisible({ timeout: 600_000 });

  if (await failed.isVisible()) {
    throw new Error(
      `the model did not start in-browser: ${await page.locator("[role=alert]").first().innerText()}`,
    );
  }

  // Now let it decide, rather than the rules.
  const rerun = page.getByRole("button", { name: "Re-decide directions with the model" });
  await expect(rerun).toBeEnabled();
  await rerun.click();

  // The app declines to run inference when the rules were already confident
  // about every line. Our fixture is deliberately low-confidence, so this must
  // not appear — and saying so explicitly beats a silent timeout.
  await expect(
    page.getByText("The rules were already confident about every line"),
  ).toHaveCount(0, { timeout: 20_000 });

  // The badge on each candidate switches from "rules" to "model" only for the
  // lines inference actually touched.
  const rescued = page.getByRole("list").locator("li", { hasText: GAVE_UP });
  await expect(rescued.getByText("model", { exact: true })).toBeVisible({ timeout: 600_000 });
  await expect(rescued.getByText("rules", { exact: true })).toHaveCount(0);

  // The decision: money came in, which the rules refused to call.
  await expect(rescued.getByRole("button", { name: "In", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rescued.getByRole("button", { name: "Out", exact: true })).toHaveAttribute("aria-pressed", "false");

  // The regression that mattered. The model resolving the direction is not
  // enough on its own: the row also has to become writable and lose its
  // "could not tell" caveat, or the user still cannot record the line. Both
  // used to be frozen at read time and stayed wrong after inference.
  await expect(rescued.getByRole("checkbox")).toBeEnabled();
  await expect(rescued.getByRole("checkbox")).toBeChecked();
  await expect(rescued.getByText("Could not tell which way the money moved.")).toHaveCount(0);

  // And the app must not burn inference on lines it is already sure about:
  // "reimbursed 320 to the shop" reads at 0.90, so it keeps its rules answer
  // and costs nothing. Cost discipline is part of why this is usable.
  const untouched = page.getByRole("list").locator("li", { hasText: CONFIDENTLY_WRONG });
  await expect(untouched.getByText("rules", { exact: true })).toBeVisible();
  await expect(untouched.getByText("model", { exact: true })).toHaveCount(0);

  // The model reports a real probability spread, not a bare verdict, so the
  // margin is inspectable. NLI is a comparison, and showing only the winner
  // would hide the whole reason to trust it.
  await expect(rescued.getByText(/inflow|money came into/i)).toBeVisible();

  // Proof for the README, taken from the run that just passed.
  await page.screenshot({ path: "docs/images/reader-model.png", fullPage: true });

  expect(consoleErrors, `console errors during inference:\n${consoleErrors.join("\n")}`).toHaveLength(0);
});