import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { isOutage, PAUSED_PATH } from "@/lib/outage.js";

/**
 * Refreshes the Supabase session cookie, and redirects where it is useful to.
 *
 * Named `proxy` because `middleware` is deprecated in Next 16 -- same
 * behaviour, different filename and export. One consequence worth knowing:
 * `proxy` runs on the nodejs runtime, not edge, and that is not configurable.
 *
 * This is NOT the security boundary. It is a session refresher and a friendly
 * redirect. Next.js has had a middleware-bypass vulnerability before
 * (CVE-2025-29927, a spoofable x-middleware-subrequest header); 16.3.3 is
 * patched, but a gate with a single layer is the wrong shape regardless.
 *
 * Every protected surface re-checks for itself:
 *   src/app/page.js                              getViewer()  <- may be nobody
 *   src/app/d/[slug]/page.js                     getViewer() + requireDiary()
 *   src/app/api/scan/[diaryId]/[pageId]/route.js canSee()     <- serves the images
 *   src/app/search/page.js                       requireUser()
 *   src/app/admin/page.js                        requireAdmin()
 *   src/app/admin/actions.js                     requireAdmin()
 */

/*
 * Paths a signed-out visitor is still bounced from.
 *
 * This used to be the inverse -- an allowlist of public paths, with everything
 * else redirected to /login. It had to flip, because a volume marked `public`
 * must be readable with no session at all: the shelf, the reader and the image
 * route now serve a viewer who may be nobody, and canSee() decides what such a
 * viewer gets.
 *
 * Flipping an allowlist into a denylist is normally how things end up
 * accidentally open, and it is tolerable here for one specific reason: this was
 * never the gate. Every surface listed in the comment above re-checks for
 * itself, so a new route that forgets to appear here is still protected by its
 * own requireAdmin() or requireUser() -- which is the pattern every route in
 * this app already follows. Adding a route without its own check would be the
 * bug, and it would be a bug with or without this list.
 */
const NEEDS_SESSION = ["/admin", "/api/admin", "/search"];

/*
 * Paths that must not be redirected during an outage, or they would redirect to
 * themselves. /paused is the destination; /login and /auth are how someone gets
 * back in once the project returns.
 */
const OUTAGE_SAFE_PATHS = ["/login", "/auth", PAUSED_PATH];

export async function proxy(request) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // Refreshes an expiring token as a side effect; do not remove.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const matches = (paths) =>
    paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  /*
   * An unreachable Supabase answers in exactly the shape of a signed-out
   * visitor: no user, plus an error. This `error` used to be discarded, so a
   * paused project sent everyone -- valid session included -- to the login
   * page, which then reported their password as wrong.
   *
   * Nothing can leak by letting these requests continue. Every byte of diary
   * content comes from the project that is down, so pages cannot read rows and
   * the scan route cannot mint a signed Storage URL. There is nothing to serve.
   */
  if (error && isOutage(error)) {
    if (pathname.startsWith("/api/")) return unavailable();
    if (matches(OUTAGE_SAFE_PATHS)) return response;

    const url = request.nextUrl.clone();
    url.pathname = PAUSED_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (!user && matches(NEEDS_SESSION)) {
    // /api is fetched by <img> and fetch(), never navigated to. Redirecting
    // those to the HTML login page hands an <img> a document to decode, so it
    // fails as a broken image with no clue why -- and it silently overrode the
    // 401 the scan route deliberately returns for exactly this case. Answer
    // them the way the routes themselves do.
    if (pathname.startsWith("/api/")) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

/**
 * 503 rather than the 401 a signed-out caller gets.
 *
 * An <img> breaks either way, but the status is the only place the reason
 * survives: "Unauthorized" sends you looking at your session, and Retry-After
 * says the honest thing, which is that waiting is the fix.
 */
function unavailable() {
  return new NextResponse("The diary is temporarily unavailable", {
    status: 503,
    headers: { "Retry-After": "300", "Cache-Control": "no-store" },
  });
}

/*
 * The upload routes are excluded, and that exclusion is load-bearing.
 *
 * Next buffers the body of every matched request in memory so it can be read
 * both here and in the route, capped by `proxyClientMaxBodySize` -- 10 MB by
 * default. Past that it does not fail the request; it carries on with a partial
 * body. So an upload over 10 MB arrived truncated and surfaced as "VipsJpeg:
 * premature end of JPEG image", which sends you looking at the file rather than
 * at the limit. Bisected: 9.32 MB decoded, 10.58 MB did not, and raising the
 * cap made the identical 10.58 MB file decode.
 *
 * Raising the cap would have worked too, but it buffers the whole upload twice
 * -- once here for a proxy that has nothing to say about these paths, once in
 * the route that actually wants it. Not matching them at all is the honest fix.
 *
 * Safe because this file is a convenience redirect and not the security
 * boundary, as the comment on NEEDS_SESSION says: both routes check
 * getAuthState() themselves, answer 401 and 403 of their own accord, and now
 * answer the 503 this file used to give them during an outage.
 */
export const config = {
  matcher: [
    "/((?!api/admin/upload|_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
