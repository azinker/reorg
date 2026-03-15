import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt";

  if (isPublicAsset) {
    return NextResponse.next();
  }

  // Local dev: skip auth when SKIP_AUTH=true so UI can be previewed without a DB
  if (process.env.SKIP_AUTH === "true") {
    if (pathname === "/login") {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  // Auth routes always pass through
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // TODO: Re-enable auth() wrapper when DATABASE_URL is configured:
  //   import { auth } from "@/lib/auth";
  //   export default auth((req) => { ... });
  // For now, allow all traffic through in local dev
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
