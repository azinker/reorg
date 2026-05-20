import ExcelJS from "exceljs";
import type { LabelFormatterRow } from "@/lib/label-formatter/types";

export const LABELCROW_HEADERS = [
  "fromName",
  "fromStreet",
  "fromStreet2",
  "fromCity",
  "fromState",
  "fromZip",
  "toName",
  "toStreet",
  "toStreet2",
  "toCity",
  "toState",
  "toZip",
  "weight",
  "length",
  "width",
  "height",
  "orderNumber ",
] as const;

const FROM_CONSTANTS = {
  fromName: "Resolv PK RTRN",
  fromStreet: "2877 NW 10th Ave",
  fromStreet2: "",
  fromCity: "MIAMI",
  fromState: "FL",
  fromZip: "33198",
  weight: "2",
  length: "6",
  width: "1",
  height: "10",
} as const;

export async function buildLabelFormatterWorkbook(rows: LabelFormatterRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "reorG";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow([...LABELCROW_HEADERS]);

  for (const row of rows) {
    sheet.addRow([
      FROM_CONSTANTS.fromName,
      FROM_CONSTANTS.fromStreet,
      FROM_CONSTANTS.fromStreet2,
      FROM_CONSTANTS.fromCity,
      FROM_CONSTANTS.fromState,
      FROM_CONSTANTS.fromZip,
      row.buyerName,
      row.addressLine1,
      row.addressLine2 ?? "",
      row.city,
      row.state,
      row.zipCode,
      FROM_CONSTANTS.weight,
      FROM_CONSTANTS.length,
      FROM_CONSTANTS.width,
      FROM_CONSTANTS.height,
      row.orderNumber,
    ]);
  }

  sheet.columns = [
    { width: 18 }, { width: 22 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 12 },
    { width: 24 }, { width: 28 }, { width: 24 }, { width: 18 }, { width: 10 }, { width: 14 },
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 20 },
  ];
  sheet.eachRow((sheetRow) => {
    sheetRow.eachCell((cell) => {
      cell.numFmt = "@";
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
