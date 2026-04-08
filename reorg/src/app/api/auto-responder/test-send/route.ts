import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueAutoResponderJob, processAutoResponderJobs } from "@/lib/services/auto-responder";
import { buildEbayConfig, fetchEbayOrderDetails } from "@/lib/services/auto-responder-ebay";

export const dynamic = "force-dynamic";

const testSendSchema = z.object({
  orderNumber: z.string().min(1),
  responderId: z.string().min(1),
  confirmDuplicate: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Verify no active responders on either channel
  const activeCount = await db.autoResponder.count({ where: { status: "ACTIVE" } });
  if (activeCount > 0) {
    return NextResponse.json({ error: "Testing Area is only available when all responders are disabled" }, { status: 400 });
  }

  const body = await request.json();
  const parsed = testSendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { orderNumber, responderId, confirmDuplicate } = parsed.data;

  const responder = await db.autoResponder.findUnique({
    where: { id: responderId },
    include: { integration: true },
  });
  if (!responder) return NextResponse.json({ error: "Responder not found" }, { status: 404 });
  if (responder.status === "ARCHIVED") return NextResponse.json({ error: "Cannot use archived responder" }, { status: 400 });

  // Check for existing send log (duplicate warning)
  const existingLog = await db.autoResponderSendLog.findUnique({
    where: { auto_responder_dedupe: { orderNumber, channel: responder.channel } },
  });

  if (existingLog && !confirmDuplicate) {
    return NextResponse.json({
      error: "duplicate_warning",
      message: "This order already received an auto-response. Confirm with SEND_DUPLICATE to proceed.",
    }, { status: 409 });
  }

  // If duplicate confirmed, delete existing log so enqueue can succeed
  if (existingLog && confirmDuplicate) {
    await db.autoResponderSendLog.delete({ where: { id: existingLog.id } });
  }

  // Fetch order details for enrichment
  const config = buildEbayConfig(responder.integration);
  const details = await fetchEbayOrderDetails(responder.integrationId, config, [orderNumber]);
  const orderDetails = details.get(orderNumber);

  if (!orderDetails) {
    return NextResponse.json({ error: `Order ${orderNumber} not found on ${responder.channel}` }, { status: 404 });
  }

  const latestVersion = await db.autoResponderVersion.findFirst({
    where: { responderId },
    orderBy: { versionNumber: "desc" },
  });

  const result = await enqueueAutoResponderJob({
    channel: responder.channel,
    orderNumber,
    ebayItemId: orderDetails.itemId,
    ebayBuyerUserId: orderDetails.buyerUserId,
    buyerName: orderDetails.buyerName,
    itemTitle: orderDetails.itemTitle,
    source: "TESTING_AREA",
    responderId,
    responderVersionId: latestVersion?.id,
  });

  if (!result.queued) {
    return NextResponse.json({ error: result.reason ?? "Failed to queue" }, { status: 400 });
  }

  // Process immediately
  const processResult = await processAutoResponderJobs();

  return NextResponse.json({
    data: {
      queued: true,
      processed: processResult,
      orderNumber,
      channel: responder.channel,
    },
  });
}
