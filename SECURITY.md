# Security policy

## Reporting a vulnerability

Please report privately through GitHub Security Advisories on
[aniruddhaadak80/khata](https://github.com/aniruddhaadak80/khata), or by email to the maintainer
rather than in a public issue. You should get an acknowledgement within a few days.

Please do not test against other people's data. khata's own data is yours alone: there are no
accounts, and every household is reachable only through the scope cookie in that one browser.

## What khata stores

Ledger lines and their amounts, the original text of messages you pasted, and sealed audit events.
Never a password, a card number, a bank credential or a document image. There is no third-party
script and no analytics.

## The security model, plainly

khata has **no accounts**. That is a deliberate trade: nothing to phish, nothing to leak in a
password database, nothing to sign up for. The cost is that the only access control is an
unguessable 24-byte scope in an HTTP-only, `SameSite=Lax` cookie.

That has two consequences worth stating plainly:

- **A statement link is a capability.** Anyone with the URL can read that statement. It is
  `noindex`, disallowed in `robots.txt`, expiring, and gated only by 192 bits of entropy. The
  interface warns you before minting one. Do not share one publicly.
- **There is no recovery.** Clearing cookies means losing the book. There is no email to reset
  because there is no account.

## Controls in place

- Every database read is scoped to the owning scope, including the audit log.
- The scope cookie's `secure` flag follows the request protocol rather than `NODE_ENV`.
- All input is validated with Zod at the boundary; all SQL is parameterised.
- The only identifier interpolated into SQL is the schema name, pattern-checked first.
- External fetches are restricted to two allowlisted origins, time-bounded, with a bounded retry.
- Writes are throttled by an in-memory token bucket. **This is best-effort**: on serverless it
  protects one warm instance. Put a hosted rate limiter in front for anything real.
- Error responses carry a code and a message, never a stack trace or an environment variable.
- Statements and the API are excluded from crawling.

## Supported versions

Only the latest commit on `main`. There are no released versions to track.