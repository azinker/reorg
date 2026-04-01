import { NextResponse, type NextRequest } from "next/server";
import {
  NETWORK_TRANSFER_REQUEST_METHOD_HEADER,
  NETWORK_TRANSFER_REQUEST_PATH_HEADER,
  NETWORK_TRANSFER_REQUEST_START_HEADER,
} from "@/lib/network-transfer-request";

export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_METHOD_HEADER, request.method.toUpperCase());
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_PATH_HEADER, request.nextUrl.pathname);
  requestHeaders.set(NETWORK_TRANSFER_REQUEST_START_HEADER, String(Date.now()));

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/api/:path*"],
};
