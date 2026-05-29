import { z } from "zod";

export const LABEL_FORMATTER_EXCEL_FILENAME = "ADAM_RESENDS.xlsx";
export const LABEL_FORMATTER_PDF_FILENAME = "PACKINGSLIP_ADAM_RESENDS.pdf";
export const LABEL_FORMATTER_ZIP_FILENAME = "LABEL_FORMATTER_EXPORT.zip";

export const labelFormatterSourceStoreSchema = z.enum([
  "EBAY_TPP",
  "EBAY_TT",
  "BIGCOMMERCE",
  "SHOPIFY",
  "MANUAL",
]);
export type LabelFormatterSourceStore = z.infer<typeof labelFormatterSourceStoreSchema>;

export type LabelFormatterLineItem = {
  sku: string;
  quantity: number;
};

export type LabelFormatterRow = {
  id?: string;
  note?: string;
  orderNumber: string;
  sourceStore: LabelFormatterSourceStore;
  buyerName: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zipCode: string;
  lineItems: LabelFormatterLineItem[];
};

const trimmedString = (max: number) =>
  z.string().trim().max(max);

export const labelFormatterLineItemSchema = z.object({
  sku: trimmedString(120).min(1, "SKU is required"),
  quantity: z.coerce.number().int().positive().max(9999),
});

export const labelFormatterRowSchema = z.object({
  id: trimmedString(80).optional(),
  note: trimmedString(500).optional().default(""),
  orderNumber: trimmedString(80).min(1, "Order number is required"),
  sourceStore: labelFormatterSourceStoreSchema,
  buyerName: trimmedString(160).min(1, "Buyer name is required"),
  addressLine1: trimmedString(200).min(1, "Address line 1 is required"),
  addressLine2: trimmedString(200).optional().default(""),
  city: trimmedString(100).min(1, "City is required"),
  state: trimmedString(40).min(1, "State is required"),
  zipCode: trimmedString(40).min(1, "Zip code is required"),
  lineItems: z.array(labelFormatterLineItemSchema).min(1, "At least one SKU line is required"),
});

export const labelFormatterExportSchema = z.object({
  mode: z.enum(["all", "selected"]),
  rows: z.array(labelFormatterRowSchema).min(1).max(500),
});

export type LabelFormatterExportInput = z.infer<typeof labelFormatterExportSchema>;

const draftString = (max: number) => z.string().trim().max(max);

export const labelFormatterWorkingLineItemSchema = z.object({
  sku: draftString(120),
  quantity: z.coerce.number().int().positive().max(9999),
});

export const labelFormatterWorkingRowSchema = z.object({
  id: draftString(80).optional(),
  note: draftString(500).optional().default(""),
  orderNumber: draftString(80),
  sourceStore: labelFormatterSourceStoreSchema,
  buyerName: draftString(160),
  addressLine1: draftString(200),
  addressLine2: draftString(200).optional().default(""),
  city: draftString(100),
  state: draftString(40),
  zipCode: draftString(40),
  lineItems: z.array(labelFormatterWorkingLineItemSchema).min(1).max(100),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export const labelFormatterWorkingRowsSaveSchema = z.object({
  rows: z.array(labelFormatterWorkingRowSchema).max(500),
  clientLoadedAt: z.string().datetime().optional(),
});

export type LabelFormatterWorkingRowInput = z.infer<typeof labelFormatterWorkingRowSchema>;
export type LabelFormatterWorkingRowsSaveInput = z.infer<typeof labelFormatterWorkingRowsSaveSchema>;

export function sourceStoreLabel(sourceStore: LabelFormatterSourceStore): string {
  switch (sourceStore) {
    case "EBAY_TPP":
      return "eBay TPP";
    case "EBAY_TT":
      return "eBay TT";
    case "BIGCOMMERCE":
      return "BigCommerce";
    case "SHOPIFY":
      return "Shopify";
    case "MANUAL":
      return "Manual";
  }
}
