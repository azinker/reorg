import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLabelFormatterReshipBody,
  summarizeInvalidLabelFormatterRows,
} from "@/lib/label-formatter/request-validation";
import { labelFormatterReshipSchema } from "@/lib/label-formatter/types";

const baseRow = {
  orderNumber: "20-14808-76476",
  sourceStore: "EBAY_TPP",
  buyerName: "James Lawson",
  addressLine1: "123 Main",
  addressLine2: null,
  city: "Troy",
  state: "SC",
  zipCode: "29609-7635",
  lineItems: [{ sku: "LB252_FSHN_BOXES", quantity: 1 }],
  note: null,
};

test("normalizeLabelFormatterReshipBody coerces nullable optional strings", () => {
  const normalized = normalizeLabelFormatterReshipBody({
    rows: [baseRow],
    serviceClass: "ground",
    providerKey: "API",
    seriesCode: "92121",
    fromAddress: {
      name: "REORG PK RTRN",
      street: "4250 NW 76TH AVE",
      aptSuite: null,
      city: "MIAMI",
      state: "FL",
      zip: "33166",
    },
  });

  const parsed = labelFormatterReshipSchema.safeParse(normalized);
  assert.equal(parsed.success, true);
});

test("reship schema rejects empty SKU with readable issue path", () => {
  const normalized = normalizeLabelFormatterReshipBody({
    rows: [{ ...baseRow, lineItems: [{ sku: "", quantity: 1 }] }],
    serviceClass: "ground",
    providerKey: "API",
    seriesCode: "92121",
    fromAddress: {
      name: "REORG PK RTRN",
      street: "4250 NW 76TH AVE",
      city: "MIAMI",
      state: "FL",
      zip: "33166",
    },
  });

  const parsed = labelFormatterReshipSchema.safeParse(normalized);
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const invalidRows = summarizeInvalidLabelFormatterRows(normalized, parsed.error.issues);
  assert.equal(invalidRows[0]?.field, "SKU lineItems 0 sku");
  assert.match(invalidRows[0]?.message ?? "", /SKU is required/i);
});

test("reship schema allows up to 500 rows", () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    ...baseRow,
    orderNumber: `20-14800-${String(index).padStart(5, "0")}`,
    addressLine2: "",
    note: "",
  }));

  const parsed = labelFormatterReshipSchema.safeParse({
    rows,
    serviceClass: "ground",
    providerKey: "API",
    seriesCode: "92121",
    fromAddress: {
      name: "REORG PK RTRN",
      street: "4250 NW 76TH AVE",
      city: "MIAMI",
      state: "FL",
      zip: "33166",
    },
  });

  assert.equal(parsed.success, true);
});
