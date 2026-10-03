/**
 * Anonymous session ownership, on the server.
 *
 * khata has no accounts. Every visitor owns exactly one household through an
 * HTTP-only, SameSite=Lax cookie holding an unguessable scope id. That cookie is
 * the only thing that decides row ownership: the server never trusts an owner
 * id, household id or member id supplied in a request body.
 *
 * The cookie itself is minted by `src/middleware.ts`, because a Server Component
 * is not allowed to set one during render. By the time anything here runs, the
 * scope is already attached.
 */

import { cookies, headers } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { OWNER_COOKIE, OWNER_PATTERN, SCOPE_HEADER, isValidOwner, newOwnerId } from "./scope";

export { OWNER_COOKIE, OWNER_PATTERN, isValidOwner, newOwnerId };
export { ownerCookieOptions } from "./scope";

export interface SessionOwner {
  ownerId: string;
  isNew: boolean;
}

/**
 * Read the scope for the current request.
 *
 * Prefers the cookie, then the header middleware stamped onto the request, and
 * only as a last resort mints an ephemeral id. That last branch should not be
 * reachable through the app — every route passes through middleware — and it
 * deliberately does *not* persist, because a scope that cannot be written to a
 * cookie is a scope the visitor cannot return to.
 */
export async function resolveSession(): Promise<SessionOwner> {
  const jar = await cookies();
  const existing = jar.get(OWNER_COOKIE)?.value;
  if (isValidOwner(existing)) return { ownerId: existing, isNew: false };

  const stamped = (await headers()).get(SCOPE_HEADER);
  if (isValidOwner(stamped)) return { ownerId: stamped, isNew: true };

  return { ownerId: newOwnerId(), isNew: true };
}

/**
 * Constant-time comparison of an optional client-supplied scope against the real
 * one. Used by the MCP endpoint, where a client may echo its scope.
 */
export function scopeMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}