import { createHash } from "crypto";

export interface ResendLookupErrorLike {
  name?: string | null;
  message?: string | null;
  statusCode?: number | null;
}

export interface ResendEmailLookupLike {
  id?: string | null;
  from?: string | null;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  created_at?: string | null;
  last_event?: string | null;
}

export interface ResendProviderAuditSnapshot {
  lookupOk: boolean;
  id: string | null;
  lastEvent: string | null;
  createdAt: string | null;
  from: string | null;
  toCount: number;
  ccCount: number;
  bccCount: number;
  error: string | null;
  statusCode: number | null;
}

export function fingerprintSecretForAudit(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

export function summarizeResendLookup(
  data: ResendEmailLookupLike | null | undefined,
  error?: ResendLookupErrorLike | null,
): ResendProviderAuditSnapshot {
  if (error) {
    return {
      lookupOk: false,
      id: data?.id ?? null,
      lastEvent: data?.last_event ?? null,
      createdAt: data?.created_at ?? null,
      from: data?.from ?? null,
      toCount: countStringArray(data?.to),
      ccCount: countStringArray(data?.cc),
      bccCount: countStringArray(data?.bcc),
      error: formatLookupError(error),
      statusCode: error.statusCode ?? null,
    };
  }

  return {
    lookupOk: Boolean(data?.id),
    id: data?.id ?? null,
    lastEvent: data?.last_event ?? null,
    createdAt: data?.created_at ?? null,
    from: data?.from ?? null,
    toCount: countStringArray(data?.to),
    ccCount: countStringArray(data?.cc),
    bccCount: countStringArray(data?.bcc),
    error: null,
    statusCode: null,
  };
}

function countStringArray(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").length
    : 0;
}

function formatLookupError(error: ResendLookupErrorLike): string {
  const name = error.name?.trim();
  const message = error.message?.trim();
  if (name && message) return `${name}: ${message}`.slice(0, 500);
  return (message ?? name ?? "resend_lookup_failed").slice(0, 500);
}
