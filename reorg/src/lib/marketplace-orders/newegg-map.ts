import type { NeweggOrder } from "@/lib/services/newegg";
import type { MarketplaceOrderRow } from "@/lib/marketplace-orders/types";

const UNSHIPPED_STATUSES = new Set([0, 1, 5]);

export function mapNeweggOrder(order: NeweggOrder): MarketplaceOrderRow {
  const lineItems = order.items.map((item) => ({
    sku: item.sellerPartNumber,
    quantity: Math.max(item.orderedQty - item.shippedQty, item.orderedQty, 1),
    sellerPartNumber: item.sellerPartNumber,
    neweggItemNumber: item.neweggItemNumber,
    description: item.description,
  }));

  return {
    id: `newegg:${order.orderNumber}`,
    store: "NEWEGG",
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatusDescription,
    orderStatusCode: order.orderStatus,
    orderDate: order.orderDate,
    buyerName: order.customerName,
    buyerEmail: order.customerEmail,
    buyerPhone: order.customerPhone,
    addressLine1: order.shipToAddress1,
    addressLine2: order.shipToAddress2,
    city: order.shipToCity,
    state: order.shipToState,
    zipCode: order.shipToZip,
    country: order.shipToCountry,
    orderTotal: order.orderTotalAmount,
    shipService: order.shipService,
    trackingNumbers: order.trackingNumbers,
    lineItems: lineItems.length > 0 ? lineItems : [{ sku: "UNKNOWN", quantity: 1 }],
    canShip: UNSHIPPED_STATUSES.has(order.orderStatus) && lineItems.length > 0,
  };
}

export function neweggShipItemsFromRow(row: Pick<MarketplaceOrderRow, "lineItems">) {
  return row.lineItems.map((item) => ({
    sellerPartNumber: item.sellerPartNumber || item.sku,
    neweggItemNumber: item.neweggItemNumber,
    shippedQty: item.quantity,
  }));
}
