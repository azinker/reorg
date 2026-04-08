import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { getAutoResponderLogs } from "@/lib/services/auto-responder";
import type { Platform, AutoResponderEventType } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date();
  const channel = sp.get("channel") as Platform | null;
  const responderId = sp.get("responderId") ?? undefined;
  const eventType = sp.get("eventType") as AutoResponderEventType | null;
  const orderNumber = sp.get("orderNumber") ?? undefined;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const format = sp.get("format");

  const { logs, total } = await getAutoResponderLogs({
    from,
    to,
    channel: channel ?? undefined,
    responderId,
    eventType: eventType ?? undefined,
    orderNumber,
    page,
    limit: 50,
  });

  if (format === "csv") {
    const csvHeader = "Timestamp,Order Number,Channel,Responder,Event Type,Source,Status,Reason\n";
    const csvRows = logs.map((log) => {
      const responderName = (log as unknown as { responder?: { messageName?: string } }).responder?.messageName ?? "";
      return [
        log.createdAt.toISOString(),
        log.orderNumber,
        log.channel,
        responderName,
        log.eventType,
        log.source,
        log.status ?? "",
        (log.reason ?? "").replace(/,/g, ";"),
      ].join(",");
    }).join("\n");

    return new NextResponse(csvHeader + csvRows, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="auto-responder-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({ data: { logs, total, page, totalPages: Math.ceil(total / 50) } });
}
