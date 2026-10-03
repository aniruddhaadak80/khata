# Contributing to khata

Thanks for looking. khata is a small, deliberately boring project about a real problem, and the
most useful contributions are usually the ones that find a case the reader gets wrong.

## Getting set up

Requires Node 20.9 or newer. There is nothing else to configure.

`ash
git clone https://github.com/aniruddhaadak80/khata.git
cd khata
npm install
npm run dev
`

With no `DATABASE_URL` the app uses an embedded PGlite database, so a clean checkout runs with
zero environment variables.

## Before you open a pull request

`ash
npm run check     # typecheck, lint, tests, build
npm run build && npm run start
npm run test:e2e  # the primary journey in a real browser
`

All four must pass. CI runs the same commands on Node 22.

## Where the interesting work is

- **`src/lib/reader.ts`** — the deterministic reader. The interesting bugs live in the seams
  between two halves of a sentence: run-on SMS, currency symbols glued to numbers, dates that look
  like prices, and the direction of a refund.
- **`src/lib/engine.ts`** — the settlement engine. Weights, the largest-remainder split, and the
  minimum-transfer planner. If you change a weight or a rule, bump `ENGINE_VERSION`.
- **`src/lib/integrity.ts`** — the SHA-384 seal chain. The digests are pinned to hand-computed
  vectors, so changing the canonical form breaks a test on purpose.
- **`src/lib/repository.ts`** — the Neon and PGlite adapters behind one interface.

## Rules we do not bend

1. **No control without a consequence.** Every button calls real logic against real state. A
   feature that cannot work without an unavailable key does not ship.
2. **One service layer.** The browser, the REST routes and the MCP tools call the same functions. A
   second write path is a bug, not a convenience.
3. **Every read is owner-scoped.** khata has no accounts, so the scope cookie is the only access
   control there is. Audit reads included.
4. **Derived values are never accepted from a client.** Base-currency amounts, splits and
   timestamps are computed server-side.
5. **Honest states.** Loading, empty, success and failure each say what is actually happening.
   Fallback data is labelled `fallback` with its real date, never presented as current.
6. **Do not update a test to match new behaviour unless the behaviour change is the point.**
   A test edited to go green is worth less than one that caught something.

## Reporting a bug

Please include the exact text you pasted into the Reader and what khata made of it. The reader
reports the substring it used for every field, so that usually pinpoints it immediately.

## Security

Please do not open a public issue for a vulnerability. See `SECURITY.md`.