import { getManageOrderDetail } from "@/lib/manage-orders/ebay";
import type { EbayStore, ManageOrder } from "@/lib/manage-orders/types";
import type { LabelFormatterRow, LabelFormatterSourceStore } from "@/lib/label-formatter/types";

export type LabelFormatterLookupResult =
  | { status: "found"; order: LabelFormatterRow }
  | { status: "conflict"; matches: LabelFormatterRow[] }
  | { status: "not_found"; errors: Array<{ store: EbayStore; message: string }> };

const STORE_LOOKUP = [
  { ebayStore: "TPP_EBAY", sourceStore: "EBAY_TPP" },
  { ebayStore: "TT_EBAY", sourceStore: "EBAY_TT" },
] as const satisfies ReadonlyArray<{ ebayStore: EbayStore; sourceStore: LabelFormatterSourceStore }>;

function normalizeOrder(order: ManageOrder, sourceStore: LabelFormatterSourceStore): LabelFormatterRow {
  const address = order.shippingAddress;
  return {
    note: "",
    orderNumber: order.orderId,
    sourceStore,
    buyerName: address?.name ?? order.buyerName ?? order.buyerUsername ?? "",
    addressLine1: address?.street1 ?? "",
    addressLine2: address?.street2 ?? "",
    city: address?.cityName ?? "",
    state: address?.stateOrProvince ?? "",
    zipCode: address?.postalCode ?? order.shippingPostalCode ?? "",
    lineItems: order.lines.map((line) => ({
      sku: line.sku?.trim() || "UNKNOWN_SKU",
      quantity: Math.max(1, Number(line.quantity) || 1),
    })),
  };
}

export async function lookupLabelFormatterOrder(orderNumber: string): Promise<LabelFormatterLookupResult> {
  const trimmed = orderNumber.trim();
  const settled = await Promise.allSettled(
    STORE_LOOKUP.map(async ({ ebayStore, sourceStore }) => {
      const order = await getManageOrderDetail(ebayStore, trimmed);
      return order ? normalizeOrder(order, sourceStore) : null;
    }),
  );

  const matches: LabelFormatterRow[] = [];
  const errors: Array<{ store: EbayStore; message: string }> = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) matches.push(result.value);
      return;
    }
    const store = STORE_LOOKUP[index]?.ebayStore ?? "TPP_EBAY";
    errors.push({
      store,
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    console.warn("[label-formatter/lookup] store lookup failed", { store, error: errors.at(-1)?.message });
  });

  if (matches.length === 1) return { status: "found", order: matches[0]! };
  if (matches.length > 1) return { status: "conflict", matches };
  return { status: "not_found", errors };
}
