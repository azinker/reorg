import { z } from "zod";
import {
  labelFormatterLineItemSchema,
  labelFormatterReshipSchema,
  labelFormatterRowSchema,
} from "@/lib/label-formatter/types";

export const marketplaceStoreSchema = z.enum(["NEWEGG", "ETSY"]);
export type MarketplaceStore = z.infer<typeof marketplaceStoreSchema>;

export type MarketplaceOrderRow = {
  id: string;
  store: MarketplaceStore;
  orderNumber: string;
  orderStatus: string;
  orderStatusCode: number;
  orderDate: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  orderTotal: number | null;
  shipService: string | null;
  trackingNumbers: string[];
  lineItems: Array<{
    sku: string;
    quantity: number;
    sellerPartNumber?: string;
    neweggItemNumber?: string | null;
    description?: string | null;
  }>;
  canShip: boolean;
};

export const marketplaceOrderRowSchema = labelFormatterRowSchema.extend({
  sourceStore: z.enum(["NEWEGG", "ETSY"]),
  shipService: z.string().trim().max(200).optional(),
  lineItems: z.array(labelFormatterLineItemSchema.extend({
    sellerPartNumber: z.string().trim().max(120).optional(),
    neweggItemNumber: z.string().trim().max(120).nullable().optional(),
  })).min(1),
});

export const marketplaceShipSchema = labelFormatterReshipSchema.extend({
  rows: z.array(marketplaceOrderRowSchema).min(1).max(100),
  confirmMarketplaceTracking: z.boolean().default(false),
});

export type MarketplaceShipInput = z.infer<typeof marketplaceShipSchema>;

export function marketplaceStoreLabel(store: MarketplaceStore): string {
  return store === "NEWEGG" ? "Newegg" : "Etsy";
}
