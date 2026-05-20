import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { buildLabelFormatterWorkbook, LABELCROW_HEADERS } from "@/lib/label-formatter/excel";
import { buildLabelFormatterPackingSlipPdf } from "@/lib/label-formatter/packing-slip-pdf";
import { selectRowsForLabelFormatterExport } from "@/lib/label-formatter/selection";
import type { LabelFormatterRow } from "@/lib/label-formatter/types";

const baseRow: LabelFormatterRow = {
  id: "row-1",
  note: "INR Case",
  orderNumber: "18-14603-25927",
  sourceStore: "EBAY_TPP",
  buyerName: "Michael Daniels",
  addressLine1: "87 Wolf Creek Rd",
  addressLine2: "",
  city: "Troy",
  state: "MO",
  zipCode: "63379-3708",
  lineItems: [{ sku: "DB226_3.5_USB_RCVR", quantity: 1 }],
};

test("LabelCrow workbook uses exact A-Q headers and row mapping", async () => {
  const buffer = await buildLabelFormatterWorkbook([baseRow]);
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);
  const sheet = workbook.getWorksheet("Sheet1");
  assert.ok(sheet);

  const header = sheet.getRow(1).values as unknown[];
  assert.deepEqual(header.slice(1, 18), [...LABELCROW_HEADERS]);
  assert.equal(sheet.getCell("Q1").value, "orderNumber ");

  assert.equal(sheet.getCell("A2").value, "Resolv PK RTRN");
  assert.equal(sheet.getCell("B2").value, "2877 NW 10th Ave");
  assert.equal(sheet.getCell("C2").text, "");
  assert.equal(sheet.getCell("D2").value, "MIAMI");
  assert.equal(sheet.getCell("E2").value, "FL");
  assert.equal(sheet.getCell("F2").value, "33198");
  assert.equal(sheet.getCell("M2").value, "2");
  assert.equal(sheet.getCell("N2").value, "6");
  assert.equal(sheet.getCell("O2").value, "1");
  assert.equal(sheet.getCell("P2").value, "10");

  assert.equal(sheet.getCell("G2").value, "Michael Daniels");
  assert.equal(sheet.getCell("H2").value, "87 Wolf Creek Rd");
  assert.equal(sheet.getCell("I2").text, "");
  assert.equal(sheet.getCell("J2").value, "Troy");
  assert.equal(sheet.getCell("K2").value, "MO");
  assert.equal(sheet.getCell("L2").value, "63379-3708");
  assert.equal(sheet.getCell("Q2").value, "18-14603-25927");
  assert.equal(sheet.rowCount, 2);
});

test("packing slip PDF creates one 4x6 portrait page per order", async () => {
  const bytes = await buildLabelFormatterPackingSlipPdf([
    baseRow,
    { ...baseRow, id: "row-2", orderNumber: "19-14603-25928", sourceStore: "EBAY_TT" },
  ]);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  const first = pdf.getPage(0).getSize();
  assert.equal(first.width, 288);
  assert.equal(first.height, 432);
});

test("packing slip PDF does not leak notes or buyer address in plain output", async () => {
  const bytes = await buildLabelFormatterPackingSlipPdf([baseRow]);
  const raw = Buffer.from(bytes).toString("latin1");
  assert.equal(raw.includes("INR Case"), false);
  assert.equal(raw.includes("87 Wolf Creek Rd"), false);
  assert.equal(raw.includes("Michael Daniels"), false);
});

test("selection helper exports only selected rows when requested", () => {
  const rows = [
    { id: "one", orderNumber: "1" },
    { id: "two", orderNumber: "2" },
    { id: "three", orderNumber: "3" },
  ];
  assert.deepEqual(selectRowsForLabelFormatterExport(rows, new Set(["two"]), "selected"), [rows[1]]);
  assert.deepEqual(selectRowsForLabelFormatterExport(rows, new Set(["two"]), "all"), rows);
});
