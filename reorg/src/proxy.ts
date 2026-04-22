import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import {
  NETWORK_TRANSFER_REQUEST_METHOD_HEADER,
  NETWORK_TRANSFER_REQUEST_PATH_HEADER,
  NETWORK_TRANSFER_REQUEST_START_HEADER,
} from "@/lib/network-transfer-request";
import {
  NAV_PAGES,
  resolveAllowedPageKeys,
  type PageKey,
} from "@/lib/nav-pages";

const PAGE_PREFIXES: Array<{ prefix: string; key: PageKey }> = NAV_PAGES.map(
  (p) => ({ prefix: p.href, key: p.key }),
).sort((a, b) => b.prefix.length - a.prefix.length);

function resolvePageKeyForPath(pathname: string): PageKey | null {
  for (const { prefix, key } of PAGE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return key;
    }
  }
  return null;
}

function isPublicPath(pathname: string) {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname.startsWith("/logos") ||
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/scheduler/tick") ||
    pathname.startsWith("/api/sync/") && pathname.endsWith("/execute") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/ebay/callback") ||
    pathname.startsWith("/api/shopify/callback") ||
    pathname === "/api/auto-responder/process" ||
    pathname === "/api/auto-responder/reconcile" ||
    // All Vercel cron endpoints. Vercel hits these without a session
    // cookie, so the middleware has to let them through; each cron
    // handler enforces `Authorization: Bearer ${CRON_SECRET}` (or
    // `x-cron-secret`) on its own. Without this allowlist entry, the
    // middleware short-circuits with a 401 before the handler ever
    // runs — that's what silently killed the every-5-minute Help Desk
    // poll, queued-reply delivery, and daily housekeeping for ~28h.
    pathname.startsWith("/api/cron/")
  );
}

function buildNextResponse(req: NextRequest, extraHeaders?: Record<string, string>) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_METHOD_HEADER, req.method.toUpperCase());
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_PATH_HEADER, req.nextUrl.pathname);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_START_HEADER, String(Date.now()));
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      requestHeaders.set(k, v);
    }
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export default auth(function proxy(req: NextRequest & { auth?: unknown }) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return buildNextResponse(req);
  }

  if (isAuthBypassEnabled() && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (isAuthBypassEnabled()) {
    return buildNextResponse(req);
  }

  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Page-access gating for non-API routes. We never gate API routes here —
  // those have their own admin/role checks at the route handler level.
  // When an admin is impersonating, we skip middleware-level gating and let
  // (app)/layout.tsx perform it using the impersonated user's permissions.
  if (!pathname.startsWith("/api/")) {
    const pageKey = resolvePageKeyForPath(pathname);
    if (pageKey) {
      const impersonating = req.cookies.get("reorg_impersonate");
      if (!impersonating) {
        const sessionUser = (req.auth as {
          user?: { role?: string; pagePermissions?: string[] | null };
        } | null)?.user;
        const allowed = resolveAllowedPageKeys({
          role: sessionUser?.role ?? "OPERATOR",
          pagePermissions: sessionUser?.pagePermissions ?? null,
        });
        if (!allowed.has(pageKey)) {
          const url = req.nextUrl.clone();
          url.pathname = "/dashboard";
          url.search = `?denied=${encodeURIComponent(pageKey)}`;
          return NextResponse.redirect(url);
        }
      }
      return buildNextResponse(req, {
        "x-reorg-page-key": pageKey,
        "x-reorg-pathname": pathname,
      });
    }
  }

  return buildNextResponse(req);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
