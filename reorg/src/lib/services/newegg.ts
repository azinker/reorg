const NEWEGG_API_BASE = "https://api.newegg.com/marketplace";
const NEWEGG_ORDER_API_VERSION = process.env.NEWEGG_API_VERSION?.trim() || "313";
/** Ship-order endpoint rejects v313 — Newegg requires v304 for orderstatus updates. */
const NEWEGG_SHIP_API_VERSION = process.env.NEWEGG_SHIP_API_VERSION?.trim() || "304";
const REQUEST_TIMEOUT_MS = 45_000;

export type NeweggOrderStatusCode = 0 | 1 | 2 | 3 | 4 | 5;

export type NeweggItemInfo = {
  sellerPartNumber: string;
  neweggItemNumber: string | null;
  description: string | null;
  orderedQty: number;
  shippedQty: number;
  status: number;
  statusDescription: string | null;
};

export type NeweggPackageInfo = {
  trackingNumber: string | null;
  shipCarrier: string | null;
  shipService: string | null;
  shipDate: string | null;
};

export type NeweggOrder = {
  orderNumber: string;
  orderStatus: number;
  orderStatusDescription: string;
  orderDate: string;
  shipService: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  shipToAddress1: string;
  shipToAddress2: string;
  shipToCity: string;
  shipToState: string;
  shipToZip: string;
  shipToCountry: string;
  orderTotalAmount: number | null;
  trackingNumbers: string[];
  items: NeweggItemInfo[];
  packages: NeweggPackageInfo[];
};

export type NeweggShipLineItem = {
  sellerPartNumber: string;
  neweggItemNumber?: string | null;
  shippedQty: number;
};

function getCredentials() {
  const sellerId = process.env.NEWEGG_SELLER_ID?.trim();
  const apiKey = process.env.NEWEGG_API_KEY?.trim();
  const secretKey = process.env.NEWEGG_SECRET_KEY?.trim();
  if (!sellerId || !apiKey || !secretKey) {
    throw new Error("Newegg is not configured. Set NEWEGG_SELLER_ID, NEWEGG_API_KEY, and NEWEGG_SECRET_KEY.");
  }
  return { sellerId, apiKey, secretKey };
}

export function isNeweggConfigured(): boolean {
  return Boolean(
    process.env.NEWEGG_SELLER_ID?.trim()
    && process.env.NEWEGG_API_KEY?.trim()
    && process.env.NEWEGG_SECRET_KEY?.trim(),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value == null) return [];
  return [value as T];
}

/** Newegg may return a list as a bare array or wrapped as { Item: [...] } / { OrderInfo: [...] }. */
function unwrapNamedList(value: unknown, itemKey: string): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  return asArray(record[itemKey]);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function neweggFetch(path: string, init: RequestInit): Promise<Response> {
  const { apiKey, secretKey } = getCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${NEWEGG_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: apiKey,
        SecretKey: secretKey,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseItemInfo(value: unknown): NeweggItemInfo | null {
  const row = asRecord(value);
  if (!row) return null;
  const sellerPartNumber = stringField(row, "SellerPartNumber");
  if (!sellerPartNumber) return null;
  return {
    sellerPartNumber,
    neweggItemNumber: stringField(row, "NeweggItemNumber") || null,
    description: stringField(row, "Description") || null,
    orderedQty: numberField(row, "OrderedQty") ?? 0,
    shippedQty: numberField(row, "ShippedQty") ?? 0,
    status: numberField(row, "Status") ?? 0,
    statusDescription: stringField(row, "StatusDescription") || null,
  };
}

function parsePackageInfo(value: unknown): NeweggPackageInfo {
  const row = asRecord(value) ?? {};
  return {
    trackingNumber: stringField(row, "TrackingNumber") || null,
    shipCarrier: stringField(row, "ShipCarrier") || null,
    shipService: stringField(row, "ShipService") || null,
    shipDate: stringField(row, "ShipDate") || null,
  };
}

function parseOrderInfo(value: unknown): NeweggOrder | null {
  const row = asRecord(value);
  if (!row) return null;
  const orderNumber = stringField(row, "OrderNumber");
  if (!orderNumber) return null;

  const items = unwrapNamedList(row.ItemInfoList, "Item")
    .map(parseItemInfo)
    .filter(Boolean) as NeweggItemInfo[];
  const packages = unwrapNamedList(row.PackageInfoList, "Package").map(parsePackageInfo);
  const trackingNumbers = packages
    .map((pkg) => pkg.trackingNumber)
    .filter((tracking): tracking is string => Boolean(tracking));

  return {
    orderNumber,
    orderStatus: numberField(row, "OrderStatus") ?? -1,
    orderStatusDescription: stringField(row, "OrderStatusDescription") || "Unknown",
    orderDate: stringField(row, "OrderDate"),
    shipService: stringField(row, "ShipService") || null,
    customerName: stringField(row, "CustomerName"),
    customerEmail: stringField(row, "CustomerEmailAddress") || null,
    customerPhone: stringField(row, "CustomerPhoneNumber") || null,
    shipToAddress1: stringField(row, "ShipToAddress1"),
    shipToAddress2: stringField(row, "ShipToAddress2"),
    shipToCity: stringField(row, "ShipToCityName"),
    shipToState: stringField(row, "ShipToStateCode"),
    shipToZip: stringField(row, "ShipToZipCode"),
    shipToCountry: stringField(row, "ShipToCountryCode"),
    orderTotalAmount: numberField(row, "OrderTotalAmount"),
    trackingNumbers,
    items,
    packages,
  };
}

function neweggError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body) as
      | { Memo?: string; Message?: string; Code?: string }
      | Array<{ Code?: string; Message?: string }>;
    if (Array.isArray(parsed)) {
      const message = parsed.map((entry) => entry.Message).filter(Boolean).join("; ");
      if (message) return new Error(`Newegg ${status}: ${message}`);
    } else {
      const message = parsed.Memo || parsed.Message;
      if (message) return new Error(`Newegg ${status}: ${message}`);
    }
  } catch {
    // fall through
  }
  return new Error(`Newegg request failed with HTTP ${status}.`);
}

export async function fetchNeweggOrdersPage(args: {
  pageIndex?: number;
  pageSize?: number;
  status?: NeweggOrderStatusCode | null;
  orderDateFrom?: string;
  orderDateTo?: string;
}): Promise<{ orders: NeweggOrder[]; totalCount: number; totalPageCount: number; pageIndex: number }> {
  const { sellerId } = getCredentials();
  const pageIndex = args.pageIndex ?? 1;
  const pageSize = Math.min(Math.max(args.pageSize ?? 100, 1), 100);

  const requestCriteria: Record<string, unknown> = {
    Type: "2",
  };
  if (args.status != null) requestCriteria.Status = String(args.status);
  if (args.orderDateFrom) requestCriteria.OrderDateFrom = args.orderDateFrom;
  if (args.orderDateTo) requestCriteria.OrderDateTo = args.orderDateTo;

  const url = `/ordermgmt/order/orderinfo?sellerid=${encodeURIComponent(sellerId)}&version=${NEWEGG_ORDER_API_VERSION}`;
  const response = await neweggFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      OperationType: "GetOrderInfoRequest",
      RequestBody: {
        PageIndex: String(pageIndex),
        PageSize: String(pageSize),
        RequestCriteria: requestCriteria,
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) throw neweggError(response.status, body);

  const parsed = JSON.parse(body) as {
    IsSuccess?: boolean;
    ResponseBody?: {
      PageInfo?: {
        TotalCount?: number;
        TotalPageCount?: number;
        PageIndex?: number;
      };
      OrderInfoList?: { OrderInfo?: unknown | unknown[] };
    };
  };

  if (!parsed.IsSuccess) {
    throw new Error("Newegg GetOrderInfo returned IsSuccess=false.");
  }

  const pageInfo = parsed.ResponseBody?.PageInfo ?? {};
  const orders = unwrapNamedList(parsed.ResponseBody?.OrderInfoList, "OrderInfo")
    .map(parseOrderInfo)
    .filter(Boolean) as NeweggOrder[];

  return {
    orders,
    totalCount: pageInfo.TotalCount ?? orders.length,
    totalPageCount: pageInfo.TotalPageCount ?? 1,
    pageIndex: pageInfo.PageIndex ?? pageIndex,
  };
}

export async function fetchAllNeweggOrders(args: {
  status?: NeweggOrderStatusCode | null;
  orderDateFrom?: string;
  orderDateTo?: string;
  maxPages?: number;
} = {}): Promise<NeweggOrder[]> {
  const maxPages = args.maxPages ?? 60;
  const first = await fetchNeweggOrdersPage({
    pageIndex: 1,
    pageSize: 100,
    status: args.status,
    orderDateFrom: args.orderDateFrom,
    orderDateTo: args.orderDateTo,
  });

  const all = [...first.orders];
  const pagesToFetch = Math.min(first.totalPageCount, maxPages);
  for (let page = 2; page <= pagesToFetch; page += 1) {
    const next = await fetchNeweggOrdersPage({
      pageIndex: page,
      pageSize: 100,
      status: args.status,
      orderDateFrom: args.orderDateFrom,
      orderDateTo: args.orderDateTo,
    });
    all.push(...next.orders);
  }
  return all;
}

export async function shipNeweggOrder(args: {
  orderNumber: string;
  trackingNumber: string;
  shipCarrier?: string;
  shipService?: string | null;
  items: NeweggShipLineItem[];
}): Promise<void> {
  const { sellerId } = getCredentials();
  const url = `/ordermgmt/orderstatus/orders/${encodeURIComponent(args.orderNumber)}?sellerid=${encodeURIComponent(sellerId)}&version=${NEWEGG_SHIP_API_VERSION}`;

  const shipService = args.shipService?.trim() || "Standard Shipping (5-7 business days)";

  const response = await neweggFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Action: "2",
      Value: {
        Shipment: {
          Header: {
            SellerID: sellerId,
            SONumber: args.orderNumber,
          },
          PackageList: {
            Package: [{
              TrackingNumber: args.trackingNumber,
              ShipCarrier: args.shipCarrier ?? "USPS",
              ShipService: shipService,
              ItemList: {
                Item: args.items.map((item) => ({
                  SellerPartNumber: item.sellerPartNumber,
                  ...(item.neweggItemNumber ? { NeweggItemNumber: item.neweggItemNumber } : {}),
                  ShippedQty: String(item.shippedQty),
                })),
              },
            }],
          },
        },
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) throw neweggError(response.status, body);

  const parsed = JSON.parse(body) as {
    IsSuccess?: boolean;
    Memo?: string;
    PackageProcessingSummary?: { FailCount?: number };
    Result?: { OrderStatus?: string };
  };
  if (parsed.IsSuccess === false) {
    throw new Error(parsed.Memo?.trim() || "Newegg ship order failed.");
  }
  if ((parsed.PackageProcessingSummary?.FailCount ?? 0) > 0) {
    throw new Error("Newegg ship order reported package failures.");
  }
}
