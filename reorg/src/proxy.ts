import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import {
  NETWORK_TRANSFER_REQUEST_METHOD_HEADER,
  NETWORK_TRANSFER_REQUEST_PATH_HEADER,
  NETWORK_TRANSFER_REQUEST_START_HEADER,
} from "@/lib/network-transfer-request";

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
    pathname.startsWith("/api/shopify/callback")
  );
}

function buildNextResponse(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_METHOD_HEADER, req.method.toUpperCase());
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_PATH_HEADER, req.nextUrl.pathname);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_START_HEADER, String(Date.now()));

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

  return buildNextResponse(req);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
