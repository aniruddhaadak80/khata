/**
 * Anonymous scope, in the smallest form possible.
 *
 * This module is imported by `src/middleware.ts`, which runs on the edge, so it
 * may not touch `node:crypto` or anything else that is not in the edge runtime.
 * The node-only constant-time comparison lives in `session.ts` instead.
 *
 * Why a cookie at all, and why it has to be set here:
 *
 * `cookies().set()` is only legal inside a Route Handler or a Server Action. A
 * Server *Component* that tried to mint a scope during render threw
 * "Cookies can only be modified in a Server Action or Route Handler" and took
 * six of the nine pages down in production. Middleware runs before rendering, so
 * it is the one place that can guarantee every page and every API route arrives
 * with a scope already attached.
 */

/** Cookie name. */
export const OWNER_COOKIE = "khata_scope";

const OWNER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * 24 random bytes, base64url encoded. 32 characters of entropy, so the value is
 * not guessable and is a safe cookie value without encoding.
 */
export const OWNER_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;

export function isValidOwner(value: unknown): value is string {
  return typeof value === "string" && OWNER_PATTERN.test(value);
}

/** Edge-safe CSPRNG. `crypto` is a global in both the edge and Node runtimes. */
export function newOwnerId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Cookie attributes for the scope cookie.
 *
 * `secure` follows the **request's** protocol rather than `NODE_ENV`.
 *
 * Hard-coding `secure: NODE_ENV === "production"` looks right and is a trap: a
 * `Secure` cookie sent over plain HTTP is *silently dropped by the client*, so
 * every single request would mint a brand new scope, create a brand new
 * household, and leave the previous one orphaned. Reads would return an empty
 * book while writes appeared to succeed, and the table would fill with one
 * household per request. Chrome and Firefox make an exception for
 * `localhost`/`127.0.0.1`, so a browser hides the bug — but any HTTP client
 * does not, and neither does a plain-HTTP deployment.
 */
export function ownerCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: OWNER_TTL_SECONDS,
  } as const;
}

/**
 * Header used to hand the freshly minted scope to the request that is being
 * rendered.
 *
 * Setting the cookie on the response is not enough: the render for *this*
 * request would still see no cookie and would mint a different scope, so the
 * first write of a first visit would land under a throwaway id that the browser
 * never learns. Copying the value onto the request headers as well closes that
 * gap.
 */
export const SCOPE_HEADER = "x-khata-scope";