import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { listLabelFormatterReshipHistory } from "@/lib/label-formatter/reship";
import { sourceStoreLabel, type LabelFormatterLineItem, type LabelFormatterSourceStore } from "@/lib/label-formatter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) return true;
  return isAuthBypassEnabled() ? Boolean(await getSystemUser()) : false;
}

function parseLineItems(value: unknown): LabelFormatterLineItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const sku = typeof record.sku === "string" ? record.sku : "";
    const quantity = Number(record.quantity);
    return [{ sku, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1 }];
  });
}

function parseDateParam(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: NextRequest) {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 25);
    const createdFromParam = request.nextUrl.searchParams.get("createdFrom");
    const createdToParam = request.nextUrl.searchParams.get("createdTo");
    const createdFrom = parseDateParam(createdFromParam);
    const createdTo = parseDateParam(createdToParam);
    if ((createdFromParam && !createdFrom) || (createdToParam && !createdTo)) {
      return NextResponse.json({ error: "Invalid reship date range." }, { status: 400 });
    }

    const rows = await listLabelFormatterReshipHistory({
      limit,
      createdFrom,
      createdTo,
    });
    return NextResponse.json({
      data: rows.map((batch) => ({
        id: batch.id,
        createdAt: batch.createdAt.toISOString(),
        createdBy: batch.createdBy
          ? { name: batch.createdBy.name, email: batch.createdBy.email }
          : null,
        rowCount: batch.rowCount,
        successCount: batch.successCount,
        failedCount: batch.failedCount,
        carrier: batch.carrier,
        serviceClass: batch.serviceClass,
        providerKey: batch.providerKey,
        seriesCode: batch.seriesCode,
        fromAddress: {
          name: batch.fromName,
          street: batch.fromStreet,
          aptSuite: batch.fromStreet2 ?? "",
          city: batch.fromCity,
          state: batch.fromState,
          zip: batch.fromZip,
        },
        zipFileName: batch.zipFileName,
        rows: batch.rows.map((row) => ({
          id: row.id,
          note: row.note ?? "",
          orderNumber: row.orderNumber,
          sourceStore: row.sourceStore as LabelFormatterSourceStore,
          sourceStoreLabel: sourceStoreLabel(row.sourceStore as LabelFormatterSourceStore),
          buyerName: row.buyerName,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2 ?? "",
          city: row.city,
          state: row.state,
          zipCode: row.zipCode,
          lineItems: parseLineItems(row.lineItems),
          trackingNumber: row.trackingNumber,
          status: row.status,
          errorMessage: row.errorMessage,
          serviceClass: row.serviceClass,
          providerKey: row.providerKey,
          seriesCode: row.seriesCode,
          createdAt: row.createdAt.toISOString(),
        })),
      })),
    });
  } catch (error) {
    console.error("[label-formatter/reship-history] failed", error);
    return NextResponse.json({ error: "Failed to load reship history." }, { status: 500 });
  }
}
