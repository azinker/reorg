import type {
  ManageOrder,
  ManageOrdersPeriodFilter,
  ManageOrdersSearchBy,
  ManageOrdersStatusFilter,
} from "@/lib/manage-orders/types";

const EXPEDITED_MARKERS = [
  "priority",
  "express",
  "overnight",
  "nextday",
  "next day",
  "2day",
  "2 day",
  "two day",
  "expedited",
  "fedex2day",
  "fedexstandardovernight",
  "fedexpriorityovernight",
  "ups2nddayair",
  "upsnextdayair",
  "uspspriority",
  "uspsprioritymail",
  "uspsprioritymailexpress",
];

export function periodToDateRange(period: ManageOrdersPeriodFilter, now = new Date()) {
  const to = new Date(now);
  const from = new Date(now);
  if (period === "last_week") {
    from.setDate(from.getDate() - 7);
  } else if (period === "last_month") {
    from.setMonth(from.getMonth() - 1);
  } else {
    from.setDate(from.getDate() - 90);
  }
  return { from, to };
}

export function isExpeditedShippingService(service: string | null | undefined) {
  if (!service) return false;
  const normalized = service.toLowerCase().replace(/[_-]+/g, " ");
  return EXPEDITED_MARKERS.some((marker) => normalized.includes(marker));
}

export function shipByWithin24Hours(order: Pick<ManageOrder, "shipBy">, now = new Date()) {
  if (!order.shipBy) return false;
  const shipBy = new Date(order.shipBy);
  if (Number.isNaN(shipBy.getTime())) return false;
  const diff = shipBy.getTime() - now.getTime();
  return diff >= 0 && diff <= 24 * 60 * 60 * 1000;
}

export function matchesStatusFilter(
  order: Pick<ManageOrder, "shippedTime" | "shipBy" | "shippingService" | "trackingNumbers">,
  status: ManageOrdersStatusFilter,
  now = new Date(),
) {
  const isShipped = Boolean(order.shippedTime || order.trackingNumbers.length);
  if (status === "all_orders") return true;
  if (status === "shipped") return isShipped;
  if (isShipped) return false;
  if (status === "ship_within_24h") return shipByWithin24Hours(order, now);
  if (status === "awaiting_expedited") return isExpeditedShippingService(order.shippingService);
  return true;
}

function haystackForSearch(order: ManageOrder, searchBy: ManageOrdersSearchBy) {
  if (searchBy === "order_number") return [order.orderId, order.apiOrderId];
  if (searchBy === "buyer_username") return [order.buyerUsername ?? ""];
  if (searchBy === "buyer_name") return [order.buyerName ?? ""];
  if (searchBy === "item_id") return order.lines.map((line) => line.itemId);
  if (searchBy === "item_title") return order.lines.map((line) => line.title);
  if (searchBy === "tracking_number") return order.trackingNumbers.map((tracking) => tracking.number ?? "");
  return order.lines.map((line) => line.sku ?? "");
}

function normalizeTrackingSearchValue(value: string) {
  return value.replace(/[\s-]+/g, "").toLowerCase();
}

export function matchesSearch(order: ManageOrder, searchBy: ManageOrdersSearchBy, searchTerm: string) {
  const term =
    searchBy === "tracking_number"
      ? normalizeTrackingSearchValue(searchTerm.trim())
      : searchTerm.trim().toLowerCase();
  if (!term) return true;
  const values = haystackForSearch(order, searchBy).map((value) =>
    searchBy === "tracking_number" ? normalizeTrackingSearchValue(value) : value.toLowerCase(),
  );
  return values.some((value) => value === term) || values.some((value) => value.includes(term));
}
