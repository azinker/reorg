import type { NetworkTransferChannel } from "@prisma/client";

export const NETWORK_TRANSFER_REQUEST_METHOD_HEADER = "x-reorg-network-method";
export const NETWORK_TRANSFER_REQUEST_PATH_HEADER = "x-reorg-network-path";
export const NETWORK_TRANSFER_REQUEST_START_HEADER = "x-reorg-network-start";

const DYNAMIC_SEGMENT_PATTERNS = [
  /^\d+$/,
  /^c[a-z0-9]{16,}$/i,
  /^[0-9a-f]{8,}$/i,
];

export function normalizeApiPathForNetworkTransfer(pathname: string): string {
  if (!pathname) return "/api/unknown";
  const normalized = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (DYNAMIC_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))) {
        return ":id";
      }
      return segment;
    });

  return `/${normalized.join("/")}`;
}

export function buildNetworkTransferRouteLabel(method: string, pathname: string): string {
  const normalizedMethod = method.trim().toUpperCase() || "GET";
  return `${normalizedMethod} ${normalizeApiPathForNetworkTransfer(pathname)}`;
}

export function getNetworkTransferChannelForApiPath(pathname: string): NetworkTransferChannel {
  if (pathname.startsWith("/api/inventory-forecaster")) {
    return "FORECAST";
  }

  return "CLIENT_API_RESPONSE";
}
