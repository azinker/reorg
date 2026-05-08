import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { auth } from "@/lib/auth";
import { getManageOrderDetail } from "@/lib/manage-orders/ebay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ store: string; orderId: string }> },
) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { store, orderId } = await params;
  if (store !== "TPP_EBAY" && store !== "TT_EBAY") {
    return NextResponse.json({ error: "Invalid store" }, { status: 400 });
  }
  const order = await getManageOrderDetail(store, decodeURIComponent(orderId));
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([288, 432]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);

  const orderText = order.orderId;
  const orderSize = 24;
  page.drawText(orderText, {
    x: (288 - bold.widthOfTextAtSize(orderText, orderSize)) / 2,
    y: 370,
    size: orderSize,
    font: bold,
    color: black,
  });

  page.drawText("SKU", { x: 36, y: 310, size: 12, font: bold, color: black });
  page.drawText("Quantity", { x: 210, y: 310, size: 12, font: bold, color: black });
  let y = 286;
  for (const line of order.lines) {
    const sku = line.sku ?? "UNKNOWN_SKU";
    page.drawText(sku.slice(0, 30), { x: 36, y, size: 11, font: regular, color: black });
    page.drawText(String(line.quantity), { x: 226, y, size: 11, font: regular, color: black });
    y -= 22;
  }

  const bytes = await pdf.save();
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="packing-slip-${order.orderId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
