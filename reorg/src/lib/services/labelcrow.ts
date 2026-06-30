import type { Prisma } from "@prisma/client";

const DEFAULT_BASE_URL = "https://labelcrow.com";
const REQUEST_TIMEOUT_MS = 30_000;

export interface LabelCrowAddress {
  name: string;
  address: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface LabelCrowCreateInput {
  from: LabelCrowAddress;
  to: LabelCrowAddress;
  orderNumber: string;
  carrier?: "usps";
  serviceClass?: "ground" | "priority" | string;
  providerKey?: string;
  seriesId?: string;
  seriesCode?: string;
  weightLbs?: number;
}

export interface LabelCrowCreatedLabel {
  labelCrowId: string | null;
  trackingNumber: string;
  downloadUrl: string | null;
  carrier: string;
  serviceClass: string;
  weight: string | null;
  orderNumber: string | null;
  createdAt: string | null;
  pdfBytes: Buffer | null;
  rawResponse: Prisma.JsonValue;
}

export interface LabelCrowDownloadedLabel {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export interface LabelCrowAccountSeries {
  id: number;
  series_code: string;
  display_name: string | null;
  carrier: string;
  service_class: string;
  provider_key: string;
}

export interface LabelCrowAccountProvider {
  carrier: string;
  service_class: string;
  provider_key: string;
}

interface LabelCrowLabelRow {
  id: string | null;
  tracking: string | null;
  downloadUrl: string | null;
  carrier: string | null;
  serviceClass: string | null;
  weight: string | null;
  orderNumber: string | null;
  createdAt: string | null;
}

function getBaseUrl(): string {
  return (process.env.LABELCROW_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getApiKey(): string {
  const key = process.env.LABELCROW_API_KEY?.trim();
  if (!key) throw new Error("LABELCROW_API_KEY is not configured.");
  return key;
}

function getDefaultSeriesId(): string {
  return process.env.LABELCROW_USPS_GROUND_SERIES_ID?.trim() || "13";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function jsonForStorage(value: unknown): Prisma.JsonValue {
  if (value == null) return {};
  return JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
}

function parseJsonBuffer(buffer: Buffer): unknown {
  const text = buffer.toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function labelRowFromUnknown(value: unknown): LabelCrowLabelRow | null {
  const root = asRecord(value);
  if (!root) return null;
  const rawData = root.data;
  const data = Array.isArray(rawData) ? rawData[0] : rawData;
  const row = asRecord(data) ?? root;
  const id = stringField(row, "id");
  const tracking = stringField(row, "tracking") ?? stringField(row, "tracking_number");
  const downloadUrl =
    stringField(row, "download_url") ??
    stringField(row, "downloadUrl") ??
    stringField(row, "pdf_url") ??
    stringField(row, "url");
  return {
    id,
    tracking,
    downloadUrl,
    carrier: stringField(row, "carrier"),
    serviceClass: stringField(row, "service_class") ?? stringField(row, "serviceClass"),
    weight: stringField(row, "weight"),
    orderNumber: stringField(row, "order_number") ?? stringField(row, "orderNumber"),
    createdAt: stringField(row, "created_at") ?? stringField(row, "createdAt"),
  };
}

function extractTrackingFromText(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  const usps = compact.match(/\b9[0-9]{21,33}\b/);
  return usps?.[0] ?? null;
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) return decodeURIComponent(utf8).trim();
  const plain = value.match(/filename="([^"]+)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1];
  return plain?.trim() ?? null;
}

function filenameForTracking(trackingNumber: string): string {
  return `return-label-${trackingNumber}.pdf`;
}

function labelCrowError(status: number, buffer: Buffer): Error {
  try {
    const parsed = parseJsonBuffer(buffer);
    const root = asRecord(parsed);
    const rawError = asRecord(root?.error);
    const message =
      stringField(rawError ?? {}, "message") ??
      stringField(root ?? {}, "message") ??
      stringField(root ?? {}, "error");
    if (message) return new Error(`LabelCrow ${status}: ${message}`);
  } catch {
    // Fall through to a terse status-only error.
  }
  return new Error(`LabelCrow request failed with HTTP ${status}.`);
}

let cachedAccountSeries: { fetchedAt: number; rows: LabelCrowAccountSeries[] } | null = null;
let cachedAccountProviders: { fetchedAt: number; rows: LabelCrowAccountProvider[] } | null = null;
const SERIES_CACHE_MS = 5 * 60 * 1000;

function parseAccountSeries(value: unknown): LabelCrowAccountSeries[] {
  const root = asRecord(value);
  const raw = root?.data;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row) return [];
    const id = row.id;
    const seriesCode = stringField(row, "series_code");
    if (typeof id !== "number" || !seriesCode) return [];
    return [{
      id,
      series_code: seriesCode,
      display_name: stringField(row, "display_name"),
      carrier: stringField(row, "carrier") ?? "usps",
      service_class: stringField(row, "service_class") ?? "ground",
      provider_key: stringField(row, "provider_key") ?? "",
    }];
  });
}

function parseAccountProviders(value: unknown): LabelCrowAccountProvider[] {
  const root = asRecord(value);
  const raw = root?.data;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row) return [];
    const carrier = stringField(row, "carrier");
    const serviceClass = stringField(row, "service_class");
    const providerKey = stringField(row, "provider_key");
    if (!carrier || !serviceClass || !providerKey) return [];
    return [{
      carrier,
      service_class: serviceClass,
      provider_key: providerKey,
    }];
  });
}

/** LabelCrow account series (cached ~5 min). Required to map UI series codes → numeric series_id. */
export async function fetchLabelCrowAccountSeries(): Promise<LabelCrowAccountSeries[]> {
  if (cachedAccountSeries && Date.now() - cachedAccountSeries.fetchedAt < SERIES_CACHE_MS) {
    return cachedAccountSeries.rows;
  }

  const response = await labelCrowFetch("/api/v1/account/series", { method: "GET" });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw labelCrowError(response.status, buffer);

  const rows = parseAccountSeries(parseJsonBuffer(buffer));
  cachedAccountSeries = { fetchedAt: Date.now(), rows };
  return rows;
}

/** LabelCrow carrier/service/provider templates (cached ~5 min). */
export async function fetchLabelCrowAccountProviders(): Promise<LabelCrowAccountProvider[]> {
  if (cachedAccountProviders && Date.now() - cachedAccountProviders.fetchedAt < SERIES_CACHE_MS) {
    return cachedAccountProviders.rows;
  }

  const response = await labelCrowFetch("/api/v1/account/providers", { method: "GET" });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw labelCrowError(response.status, buffer);

  const rows = parseAccountProviders(parseJsonBuffer(buffer));
  cachedAccountProviders = { fetchedAt: Date.now(), rows };
  return rows;
}

async function labelCrowFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getApiKey()}`);
  try {
    return await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function createLabelCrowLabel(input: LabelCrowCreateInput): Promise<LabelCrowCreatedLabel> {
  const payload = {
    from: {
      name: input.from.name,
      address: input.from.address,
      address2: input.from.address2 ?? "",
      city: input.from.city,
      state: input.from.state,
      zip: input.from.zip,
    },
    to: {
      name: input.to.name,
      address: input.to.address,
      address2: input.to.address2 ?? "",
      city: input.to.city,
      state: input.to.state,
      zip: input.to.zip,
    },
    carrier: input.carrier ?? "usps",
    service_class: input.serviceClass ?? "ground",
    provider_key: input.providerKey ?? "api",
    series_id: input.seriesId ?? getDefaultSeriesId(),
    series_code: input.seriesCode ?? "9302",
    weight: input.weightLbs ?? 2,
    order_number: input.orderNumber,
  };

  const response = await labelCrowFetch("/api/v1/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw labelCrowError(response.status, buffer);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = parseJsonBuffer(buffer);
    const row = labelRowFromUnknown(parsed);
    const tracking =
      row?.tracking ??
      extractTrackingFromText(row?.downloadUrl) ??
      extractTrackingFromText(JSON.stringify(parsed));
    if (!tracking) {
      throw new Error("LabelCrow created a label but did not return a tracking number.");
    }
    return {
      labelCrowId: row?.id ?? null,
      trackingNumber: tracking,
      downloadUrl: row?.downloadUrl ?? null,
      carrier: row?.carrier ?? "usps",
      serviceClass: row?.serviceClass ?? "ground",
      weight: row?.weight ?? null,
      orderNumber: row?.orderNumber ?? input.orderNumber,
      createdAt: row?.createdAt ?? null,
      pdfBytes: null,
      rawResponse: jsonForStorage(parsed),
    };
  }

  const disposition = response.headers.get("content-disposition");
  const filename = filenameFromDisposition(disposition);
  const tracking =
    extractTrackingFromText(filename) ??
    extractTrackingFromText(buffer.toString("latin1"));
  if (!tracking) {
    throw new Error("LabelCrow returned a PDF but no tracking number could be read.");
  }
  return {
    labelCrowId: null,
    trackingNumber: tracking,
    downloadUrl: null,
    carrier: "usps",
    serviceClass: "ground",
    weight: `${input.weightLbs ?? 2} LB`,
    orderNumber: input.orderNumber,
    createdAt: null,
    pdfBytes: buffer,
    rawResponse: {
      contentType,
      filename: filename ?? filenameForTracking(tracking),
    },
  };
}

function normalizeDownloadPath(input: {
  labelCrowId?: string | null;
  downloadUrl?: string | null;
}): string {
  const downloadUrl = input.downloadUrl?.trim();
  if (downloadUrl?.startsWith("/api/v1/labels/") && downloadUrl.endsWith("/download")) {
    return downloadUrl;
  }
  if (input.labelCrowId?.trim()) {
    return `/api/v1/labels/${encodeURIComponent(input.labelCrowId.trim())}/download`;
  }
  throw new Error("This return label does not have a LabelCrow download id.");
}

export async function downloadLabelCrowLabel(input: {
  labelCrowId?: string | null;
  downloadUrl?: string | null;
  trackingNumber: string;
}): Promise<LabelCrowDownloadedLabel> {
  const response = await labelCrowFetch(normalizeDownloadPath(input), {
    method: "GET",
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw labelCrowError(response.status, buffer);

  const disposition = response.headers.get("content-disposition");
  return {
    bytes: buffer,
    contentType: response.headers.get("content-type") ?? "application/pdf",
    filename:
      filenameFromDisposition(disposition) ??
      filenameForTracking(input.trackingNumber),
  };
}
