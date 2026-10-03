import { NextResponse, type NextRequest } from "next/server";
import { OWNER_COOKIE, SCOPE_HEADER, isValidOwner, newOwnerId, ownerCookieOptions } from "@/lib/scope";

/**
 * Mints the anonymous scope, once.
 *
 * Every page and every API route passes through here before anything else runs,
 * which is the only way to guarantee a Server Component arrives with a scope
 * already attached: `cookies().set()` is illegal during render, so a page that
 * tried to mint its own would throw on the very first visit.
 *
 * The value is written twice on purpose — once onto the outgoing response as the
 * cookie the browser keeps, and once onto the incoming request as a header the
 * render can read. Without the header, the first render of a first visit would
 * mint a *different* scope than the one the browser is given, and the first write
 * would disappear into a session nobody can return to.
 *
 * Named `proxy`, not `middleware`: Next 16 renamed the file convention and
 * warns on the old one.
 */
export function proxy(request: NextRequest) {
  const existing = request.cookies.get(OWNER_COOKIE)?.value;
  if (isValidOwner(existing)) return NextResponse.next();

  const ownerId = newOwnerId();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(SCOPE_HEADER, ownerId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(
    OWNER_COOKIE,
    ownerId,
    ownerCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own output, the generated metadata routes and any
     * file with an extension. A request for a static asset must not mint a
     * cookie, and neither should the crawler-friendly robots and sitemap.
     */
    "/((?!_next/static|_next/image|favicon\\.ico|opengraph-image|robots\\.txt|sitemap\\.xml|mcp\\.json|.*\\.[\\w]+$).*)",
  ],
};

export default proxy;