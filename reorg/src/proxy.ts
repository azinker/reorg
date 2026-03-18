import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthBypassEnabled } from "@/lib/app-env";

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname.startsWith("/logos");

  if (isPublicAsset) {
    return NextResponse.next();
  }

  if (isAuthBypassEnabled() && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
