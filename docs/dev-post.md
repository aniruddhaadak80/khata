# khata — the household ledger that reads your messages

**I built this for my sister, Arunima Adak.** She shares a flat. Every month the electricity bill arrives as a screenshot, somebody pays it, and three weeks later nobody can remember who covered what. So it turned into an argument, and the argument was the real bug.

khata reads the messages a shared home actually produces — a UPI SMS, a WhatsApp forward, the note on the back of a receipt — turns them into a real ledger, keeps the original text as evidence, works out the shortest way to settle up, and seals every change so the number can be **checked** instead of believed.

**Live app:** https://khata-ai.vercel.app
**Source:** https://github.com/aniruddhaadak80/khata
**Run it yourself in 60 seconds, no keys:** `git clone` → `npm install` → `npm run dev`

---

## The problem, precisely

A shared home produces one specific, boring, weekly problem. Three properties make it worth building software for:

1. **The evidence already exists.** The bill screenshot, the payment SMS, the forward. It is just scattered across a chat nobody can search.
2. **The arithmetic is contested, not hard.** Anyone can work out who owes whom. Nobody can agree on the inputs, so they argue about the output.
3. **The failure mode is a relationship.** Two people who live together cannot open an invoice app.

That third point is why this has no accounts, no login, and no API key.

## Why open mattered — the actual answer

The challenge asks whether open beat closed here. For me it did, for a structural reason rather than a cost one.

The data is **the whole product**. A household ledger is a record of who spent money on what, between two real people, in a specific month. Sending that to a hosted classifier is not a minor architectural choice; it is handing over the only thing the product exists to protect.

So the reader runs **in your browser**:

- [`Xenova/mobilebert-uncased-mnli`](https://huggingface.co/Xenova/mobilebert-uncased-mnli) — a 28 MB int8 natural-language-inference model — loaded once into your browser's cache and executed through `onnxruntime-web`. Apache-2.0.
- **No key exists in this project.** Not a missing one, not a documented one — the variable is absent from the code.
- After the first download it runs **with the network switched off**. A laptop on a train, in a flat whose broadband is one of the things being argued about.
- It is swappable. The model is one string in `src/lib/local-model.ts`; point it at any open-weights checkpoint, or at a local Ollama daemon running `gemma3:1b`, and nothing else changes.

Where open was *worse*, honestly: an NLI model at 28 MB is a big thing to ask a phone to download before it will read one message. So the app never depends on it. A deterministic rule engine reads every message instantly, with no download and no network, and reports its confidence per field. The model is a one-click upgrade that re-decides only the directions the rules were unsure about. Open won on privacy; closed would have won on first-load latency, and I did not pretend otherwise.

### What the model is actually for

Rules handle amounts, dates, payers and categories. For direction they score keywords, plus one special case I wrote by hand: a message containing "refund" is an inflow unless it also matches "paid".

That special case is exactly where a keyword list runs out of road. These are the measured confidences, not the ones I expected:

```
received refund 320 from the wifi seller   inflow   0.90   correct
refund paid 320 to the wifi seller         outflow  0.90   correct
wifi seller refunded me 320                unclear  0.00   no answer
320 refunded to my account                 unclear  0.00   no answer
reimbursed 320 to the shop                 inflow   0.90   wrong
```

The first two I originally used as the example, because they are the pair that reads like it *must* need a model. The rules get them right anyway, at 0.90, so the model never runs on them at all. The line that genuinely needs it has no first-person marker and no payment verb — `wifi seller refunded me 320` — so the rules can only answer `unclear`, which leaves the row unwritable.

A zero-shot NLI model reads the whole sentence and scores each direction hypothesis against it, which is the job it was trained for. On that line it answers **inflow at 84%**, against outflow 16%, and the row becomes writable.

So the rule I settled on is deliberately narrow: the model decides only where the rules score below 0.80, and it may overrule a confident rule only when it is at least as confident itself. That keeps the cost honest — the 28 MB gets spent on the minority of lines that need it, not on every line that arrives.

The proof is a real browser test, not a unit test with the model mocked. It downloads the weights, runs onnxruntime-web, and asserts the model answered `inflow`, that the row became writable, that its "could not tell which way the money moved" caveat disappeared, and that a line the rules already read at 0.90 came back still badged `rules` rather than being silently re-decided. It is skipped by default because a test run should not depend on a third-party CDN, and it is in `e2e/model.spec.ts` if you want to watch it happen.
---

## The four things it does

**Reads, and admits what it doesn't know.** Paste a conversation. Every segment becomes a candidate line with per-field confidence *and the exact substring each field came from*. Lines it cannot read are shown and explained, never dropped — a reader that silently discards half your input is not a reader.

```bash
curl -s localhost:3000/api/parse -H 'content-type: application/json' -d '{
  "text": "Paid 2400 to BESCOM, Arunima paid half\nreceived refund 320 from the wifi seller"
}' | jq '.data.candidates[] | {text, dir: .direction.value, amount: .amountMinor.value}'
```

**Settles in the fewest transfers.** One pure function, `analyseSettlement`, behind the page, the REST route and the agent tool. Splits use the **largest-remainder method**, so three ways always sums to the whole exactly — no stray paise to argue about. The transfer plan is greedy debtor/creditor pairing, which reaches the theoretical minimum: every transfer clears at least one outstanding balance and the last clears two, so from *n* non-zero balances no plan can beat *n − 1*.

**Shows its working.** A beam whose tilt is the book's real imbalance, and six weighted trust factors that sum to exactly 1 — each printing the quantity it measured, in its own units, and one sentence explaining why it reads that way. The score measures how well the book is written down, not anything about the people.

**Seals everything.** Per line, a chain of `SHA-384( UTF-8(prevSeal) || canonicalJson(event) )`. Canonical JSON sorts object keys recursively, because otherwise a harmless refactor that reordered two fields would look exactly like tampering. Ordering breaks ties on the event id, because a timestamp is not a total order and an irreproducible replay is worthless. Delete a line and the row is kept as a tombstone, so "it existed and was removed" stays provable.

---

## The agent uses the same door

Eleven typed tools over MCP-style JSON-RPC 2.0 at `POST /api/mcp`. Four read, two analyse, five write.

Every mutating tool calls the **same service-layer functions the interface calls**. There is no agent-only write path. That is the only way "the agent and the app agree" survives both of them changing, and the agent console in `/agent` shows the raw request and response so you can see the wire rather than trust a summary.

```bash
curl -s -X POST localhost:3000/api/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/list"
}' | jq '[.result.tools[] | {name, kind}]'
```

Mutations accept an `idempotencyKey`, so an agent that retries after a timeout does not double-charge anybody. The console demonstrates this by pressing record twice.

---

## Live data, honestly dated

| Source | What | Key |
| --- | --- | --- |
| [Frankfurter](https://api.frankfurter.app) | European Central Bank reference rates, 29 currencies | none |
| [World Bank Open Data](https://data.worldbank.org/indicator/FP.CPI.TOTL) | Consumer price index | none |

Every figure carries `live`, `stale` or `fallback` and a real as-of date. A sealed offline sample means a cold start or an upstream outage never leaves the page empty — and it is **never** dressed up as current. A foreign line stores the rate that was true on the day it was written, so it does not silently re-price itself. A currency the ECB does not publish — AED, say — is **refused** rather than converted at 1:1; supply your own rate and the line records that you did.

---

## What I got wrong, because the bugs are the interesting part

Six defects, and the last two only a real browser with the model actually running could find. None were visible in the tests I wrote first.

**Six of nine pages returned 500 in production.** `cookies().set()` is illegal during render, so a Server Component that minted the anonymous scope took the page down. Fixed in the request proxy — and it writes the scope onto the *request* as a header as well as onto the *response*, or the first render and the browser disagree about which household you are in.

**Reads came back empty while writes appeared to succeed.** With `NODE_ENV=production` the scope cookie was marked `Secure`, and a `Secure` cookie sent over plain HTTP is silently dropped — so every request minted a new scope and created a new household. The flag now follows the request's protocol, not the environment variable. Chrome hides this, because it treats `localhost` as a secure context. Curl found it immediately.

**The audit log was not owner-scoped.** `listAudit` took an optional chain id and nothing else, so an unscoped call returned the sealed history of *every household on the database*, with their members' names and amounts inside each event's payload. There are no accounts, so ownership is the only access control there is. The parameter is now required, and there is a regression test.

**The schema ran on every request.** Fourteen idempotent `CREATE ... IF NOT EXISTS` statements meant fourteen round trips to Neon on every call. I found it by measuring, not by reading: a commit of six lines took 9s and now takes 2.9s.

**The model could not do the one job it was in the app to do.** `runModel` overwrote a direction only when the rules had already produced a *definite* answer and disagreed. When the rules said `unclear` — which is the entire reason to reach for a model — the branch kept `unclear`, so a line the model had just answered stayed unanswered. The fix is a pure `resolveDirection(rule, model)`: the model decides outright when the rules gave up, and may only overrule a confident rule when it is at least as confident itself. Five unit tests, including one that fails if the rules ever learn those phrases, because then the copy on the page would be lying about what the model is for.

**And when the model did answer, the row did not believe it.** A candidate's confidence, its "writable" flag and its caveat list were all computed once when the rules read the line and never recomputed, so after inference the row still showed `unclear`, still carried "could not tell which way the money moved", and left the checkbox disabled — the model had answered and the user still could not record the line. Those three figures are now derived in one place, `summariseRead`, and recomputed whenever a field changes.

I also shipped a hydration mismatch for a while — `typeof window === "undefined"` is the first item on React's own list of causes, and my agent console had exactly that. It is now `useSyncExternalStore`, whose server snapshot makes the first client render agree by construction.

---

## Honest status of the live app

The deployment is **READY** and I verified it end to end through the authenticated CLI: `neon-postgres`, `SELECT 1 succeeded`, live ECB rates, `khata-engine/1.0.0`.

Public access is currently blocked by two account-level conditions that are not properties of the code:

1. The Vercel project had `ssoProtection` set to gate every deployment. I have disabled it, but the setting applies to new deployments and the existing ones were created while it was on.
2. Creating a replacement deployment hit the free tier's 100-deployments-per-day limit, which resets in 24 hours.

So I am not going to tell you the live link works, because right now it does not. `npm run verify:live` deliberately treats a Vercel Authentication page as a **failure** rather than a 200, so a protected deployment cannot be quietly mistaken for a live one — that is the check failing honestly in my own repo right now.

**The guaranteed path is the clone.** No keys, no database, no network:

```bash
git clone https://github.com/aniruddhaadak80/khata
cd khata && npm install && npm run dev
```

I will update the live link once the limit resets.

---

## Verification

```
typecheck   pass (strict, noUncheckedIndexedAccess)
lint        pass
tests       151 unit + integration, 5 files
build       pass
browser     9/9 desktop (1440×900) and 9/9 mobile (Pixel 7), real Postgres, zero console errors
model       real 28 MB download + onnxruntime-web inference in Chromium (opt-in spec)
seal chain  replays clean; digests pinned to hand-computed vectors
```

The browser suite walks the whole journey through visible controls — paste, read, correct, write, inspect, decide, stamp, agent mutation, read-back in the UI, idempotent retry, export, share, delete, replay — and **fails the run on any console error or server 5xx**. It caught the first four bugs above; the model spec caught the last two.

## Licence

MIT. If you have a shared kitchen, a group chat, or a flatmate you would rather not argue with: `npm install` and paste your last three messages.

#hf26challenge