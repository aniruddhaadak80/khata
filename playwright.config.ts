import { defineConfig, devices } from "@playwright/test";

/**
 * Local browser verification against the zero-config adapter.
 *
 * No DATABASE_URL is set, so the app runs on the embedded PGlite database and
 * the whole journey is reproducible on a clean checkout with no environment at
 * all. The live-deployment proof is a separate script: `npm run verify:live`.
 */
export default defineConfig({
  testDir: "./e2e",
  /*
   * Generous on purpose. Every assertion here waits on a hosted Postgres in
   * another region plus a live exchange-rate fetch, measured from this machine
   * at roughly 200-500ms per round trip. A timeout tight enough to trip on that
   * would be testing the network, not the product.
   */
  timeout: 300_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.KHATA_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  /**
 * The real production bundle, not `next dev`.
 *
 * Two reasons. It is the artefact that actually ships, so the journey is
 * verified against it. And `next/font/google` resolves its import map lazily
 * in dev, which fails without a round trip to Google's CDN at request time —
 * a dev-only failure that has nothing to do with the app.
 *
 * Run `npm run build` first; this only serves what is already built, so the
 * job's timeout is spent starting a server rather than compiling one.
 */
webServer: {
  command: "npm run start -- --port 3100 --hostname 127.0.0.1",
  url: "http://127.0.0.1:3100/api/health",
  reuseExistingServer: true,
  timeout: 120_000,
  stdout: "ignore",
  stderr: "pipe",
},
});