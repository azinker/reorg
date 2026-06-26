import ExcelJS from "exceljs";
import { sourceStoreLabel, type LabelFormatterRow } from "@/lib/label-formatter/types";

export type ReshipDataSheetRow = LabelFormatterRow & {
  trackingNumber?: string | null;
  labelStatus: "created" | "failed";
  errorMessage?: string | null;
  carrier: string;
  serviceClass: string;
  providerKey: string;
  seriesCode: string;
};

function lineItemsSummary(row: LabelFormatterRow): string {
  return row.lineItems.map((line) => `${line.sku} x ${line.quantity}`).join("; ");
}

export async function buildReshipDataSheet(rows: ReshipDataSheetRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "reorG";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Reship Data");
  sheet.columns = [
    { header: "Note", key: "note", width: 24 },
    { header: "Order Number", key: "orderNumber", width: 20 },
    { header: "Store", key: "sourceStore", width: 14 },
    { header: "Buyer Name", key: "buyerName", width: 24 },
    { header: "Address Line 1", key: "addressLine1", width: 28 },
    { header: "Address Line 2", key: "addressLine2", width: 20 },
    { header: "City", key: "city", width: 16 },
    { header: "State", key: "state", width: 10 },
    { header: "Zip Code", key: "zipCode", width: 12 },
    { header: "SKU / Quantity", key: "lineItems", width: 36 },
    { header: "Tracking Number", key: "trackingNumber", width: 28 },
    { header: "Label Status", key: "labelStatus", width: 12 },
    { header: "Error", key: "errorMessage", width: 32 },
    { header: "Carrier", key: "carrier", width: 10 },
    { header: "Service Class", key: "serviceClass", width: 14 },
    { header: "Provider", key: "providerKey", width: 14 },
    { header: "Series", key: "seriesCode", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      note: row.note ?? "",
      orderNumber: row.orderNumber,
      sourceStore: sourceStoreLabel(row.sourceStore),
      buyerName: row.buyerName,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2 ?? "",
      city: row.city,
      state: row.state,
      zipCode: row.zipCode,
      lineItems: lineItemsSummary(row),
      trackingNumber: row.trackingNumber ?? "",
      labelStatus: row.labelStatus,
      errorMessage: row.errorMessage ?? "",
      carrier: row.carrier.toUpperCase(),
      serviceClass: row.serviceClass,
      providerKey: row.providerKey,
      seriesCode: row.seriesCode,
    });
  }

  sheet.eachRow((sheetRow) => {
    sheetRow.eachCell((cell) => {
      cell.numFmt = "@";
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
