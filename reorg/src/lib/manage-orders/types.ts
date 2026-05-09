import type { Platform } from "@prisma/client";

export type EbayStore = "TPP_EBAY" | "TT_EBAY";
export type ManageOrdersStoreFilter = "ALL" | EbayStore;
export type ManageOrdersStatusFilter =
  | "all_orders"
  | "awaiting_shipment"
  | "shipped"
  | "ship_within_24h"
  | "awaiting_expedited";
export type ManageOrdersPeriodFilter = "last_90_days" | "last_week" | "last_month";
export type ManageOrdersSearchBy =
  | "order_number"
  | "buyer_username"
  | "buyer_name"
  | "item_id"
  | "item_title"
  | "sku"
  | "tracking_number";

export type ManageOrderActionType =
  | "add_tracking"
  | "mark_shipped"
  | "cancel_order"
  | "message_buyer";

export type ManageOrderLineItem = {
  itemId: string;
  orderLineItemId: string | null;
  transactionId: string | null;
  title: string;
  variationSelections: Array<{ name: string; value: string }>;
  sku: string | null;
  quantity: number;
  availableQuantity: number | null;
  unitPriceCents: number | null;
  imageUrl: string | null;
  listingUrl: string | null;
  supplierCostCents: number | null;
  supplierShippingCents: number | null;
  outboundShippingCents: number | null;
  adRate: number | null;
};

export type ManageOrderFinance = {
  transactionFeesCents: number | null;
  adFeeCents: number | null;
  otherFeesCents: number | null;
  shippingLabelCents: number | null;
  orderEarningsCents: number | null;
  fundsStatus: string | null;
  fundsStatusDetail: string | null;
  feesKnown: boolean;
  source: "ebay_finances" | "ebay_order_earnings" | "unavailable";
};

export type ManageOrderInternalProfit = {
  itemCostCents: number | null;
  supplierShippingCents: number | null;
  outboundShippingCents: number | null;
  totalCogsCents: number | null;
  estimatedProfitCents: number | null;
  dataComplete: boolean;
};

export type ManageOrderFeedbackItem = {
  id: string;
  externalId: string;
  kind: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  starRating: number | null;
  comment: string | null;
  sellerResponse: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  buyerUserId: string | null;
  leftAt: string;
  source: "mirror" | "live";
  isAutomated: boolean;
};

export type ManageOrderFeedbackSummary = {
  state: "LEFT" | "NOT_LEFT" | "UNKNOWN";
  items: ManageOrderFeedbackItem[];
  checkedLive: boolean;
  leaveBy: string | null;
  reason?: string;
};

export type ManageOrderCaseItem = {
  id: string;
  externalId: string;
  kind: "RETURN" | "ITEM_NOT_RECEIVED" | "NOT_AS_DESCRIBED" | "CHARGEBACK" | "OTHER";
  label: string;
  status: string;
  statusLabel: string;
  reason: string | null;
  openedAt: string;
  closedAt: string | null;
  manageUrl: string | null;
  isOpen: boolean;
};

export type ManageOrderCaseSummary = {
  hasCases: boolean;
  openCount: number;
  items: ManageOrderCaseItem[];
};

export type ManageOrder = {
  orderId: string;
  apiOrderId: string;
  store: EbayStore;
  platform: Platform;
  buyerName: string | null;
  buyerUsername: string | null;
  shippingPostalCode: string | null;
  shippingAddress: {
    name: string | null;
    street1: string | null;
    street2: string | null;
    cityName: string | null;
    stateOrProvince: string | null;
    postalCode: string | null;
    countryName: string | null;
    phone: string | null;
  } | null;
  createdTime: string | null;
  paidTime: string | null;
  shipBy: string | null;
  estimatedDeliveryMin: string | null;
  estimatedDeliveryMax: string | null;
  shippedTime: string | null;
  shippingService: string | null;
  trackingNumbers: Array<{ number: string | null; carrier: string | null; shippedTime: string | null }>;
  subtotalCents: number | null;
  shippingCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  currency: string | null;
  salesRecordNumber: string | null;
  finance: ManageOrderFinance;
  internalProfit: ManageOrderInternalProfit;
  feedback: ManageOrderFeedbackSummary;
  cases: ManageOrderCaseSummary;
  lines: ManageOrderLineItem[];
};

export type ManageOrdersSearchResult = {
  orders: ManageOrder[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalCents: number | null;
};

export type HumanActionTokenPayload = {
  userId: string;
  orderId: string;
  store: EbayStore;
  actionType: ManageOrderActionType;
  expiresAt: number;
  nonce: string;
};
