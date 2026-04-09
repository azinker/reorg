import { db } from "@/lib/db";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import {
  buildEbayConfig,
  fetchEbayOrderDetails,
  fetchRecentlyShippedOrders,
  renderTemplate,
  sendEbayMessage,
  validateTemplates,
  type RenderContext,
  type EbayOrderDetails,
} from "@/lib/services/auto-responder-ebay";
import type {
  Platform,
  AutoResponder,
  AutoResponderVersion,
  AutoResponderSendLog,
  AutoResponderJob,
  Prisma,
} from "@prisma/client";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT = 5;
const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const JOBS_PER_BATCH = 50;
const SEND_CONCURRENCY = 5;
const SEND_LOG_RETENTION_DAYS = 30;
const EBAY_CHANNELS: Platform[] = ["TPP_EBAY", "TT_EBAY"];

// ─── Kill switch ─────────────────────────────────────────────────────────────

export async function isAutoResponderPaused(): Promise<boolean> {
  const setting = await db.appSetting.findUnique({ where: { key: "auto_responder_kill_switch" } });
  return setting?.value === true;
}

export async function setAutoResponderPaused(paused: boolean, userId?: string): Promise<void> {
  await db.appSetting.upsert({
    where: { key: "auto_responder_kill_switch" },
    update: { value: paused, updatedBy: userId },
    create: { key: "auto_responder_kill_switch", value: paused, updatedBy: userId },
  });

  if (paused) {
    await db.autoResponderJob.updateMany({
      where: { status: "PENDING" },
      data: { status: "PAUSED" },
    });
  } else {
    await db.autoResponderJob.updateMany({
      where: { status: "PAUSED" },
      data: { status: "PENDING" },
    });
  }

  await db.auditLog.create({
    data: {
      userId,
      action: paused ? "auto_responder_paused" : "auto_responder_resumed",
      entityType: "auto_responder",
      entityId: "kill_switch",
    },
  });
}

// ─── Active responder lookup ─────────────────────────────────────────────────

export async function getActiveResponderForChannel(
  channel: Platform,
): Promise<(AutoResponder & { latestVersion: AutoResponderVersion | null }) | null> {
  const responder = await db.autoResponder.findFirst({
    where: { channel, status: "ACTIVE" },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1 },
    },
  });
  if (!responder) return null;
  return { ...responder, latestVersion: responder.versions[0] ?? null };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createResponder(data: {
  messageName: string;
  channel: Platform;
  subjectTemplate: string;
  bodyTemplate: string;
}, userId: string): Promise<AutoResponder> {
  if (!EBAY_CHANNELS.includes(data.channel)) {
    throw new Error("Auto Responder only supports eBay channels (TPP_EBAY, TT_EBAY)");
  }

  const integration = await db.integration.findUnique({ where: { platform: data.channel } });
  if (!integration) throw new Error(`No integration found for ${data.channel}`);

  const validationErrors = validateTemplates(data.subjectTemplate, data.bodyTemplate);

  const responder = await db.autoResponder.create({
    data: {
      messageName: data.messageName,
      channel: data.channel,
      integrationId: integration.id,
      subjectTemplate: data.subjectTemplate,
      bodyTemplate: data.bodyTemplate,
      status: validationErrors.length > 0 ? "INVALID" : "INACTIVE",
      createdById: userId,
      updatedById: userId,
    },
  });

  await db.autoResponderVersion.create({
    data: {
      responderId: responder.id,
      versionNumber: 1,
      subjectTemplate: data.subjectTemplate,
      bodyTemplate: data.bodyTemplate,
      validationStatus: validationErrors.length > 0 ? "invalid" : "valid",
      createdById: userId,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "auto_responder_created",
      entityType: "auto_responder",
      entityId: responder.id,
      details: { messageName: data.messageName, channel: data.channel },
    },
  });

  return responder;
}

export async function updateResponder(
  id: string,
  data: {
    messageName?: string;
    channel?: Platform;
    subjectTemplate?: string;
    bodyTemplate?: string;
  },
  userId: string,
): Promise<AutoResponder> {
  const existing = await db.autoResponder.findUniqueOrThrow({ where: { id } });
  if (existing.status === "ARCHIVED") throw new Error("Cannot edit archived responder");
  if (existing.status === "ACTIVE" && data.channel && data.channel !== existing.channel) {
    throw new Error("Cannot change channel while responder is active. Deactivate it first.");
  }

  // If channel is changing, look up the new integration
  let integrationId = existing.integrationId;
  if (data.channel && data.channel !== existing.channel) {
    if (!EBAY_CHANNELS.includes(data.channel)) {
      throw new Error("Auto Responder only supports eBay channels (TPP_EBAY, TT_EBAY)");
    }
    const integration = await db.integration.findUnique({ where: { platform: data.channel } });
    if (!integration) throw new Error(`No integration found for ${data.channel}`);
    integrationId = integration.id;
  }

  const subject = data.subjectTemplate ?? existing.subjectTemplate;
  const body = data.bodyTemplate ?? existing.bodyTemplate;
  const validationErrors = validateTemplates(subject, body);
  const isValid = validationErrors.length === 0;

  const newStatus = !isValid ? "INVALID" as const :
    existing.status === "INVALID" ? "INACTIVE" as const : existing.status;

  const responder = await db.autoResponder.update({
    where: { id },
    data: {
      messageName: data.messageName ?? existing.messageName,
      channel: data.channel ?? existing.channel,
      integrationId,
      subjectTemplate: subject,
      bodyTemplate: body,
      status: newStatus,
      updatedById: userId,
    },
  });

  const lastVersion = await db.autoResponderVersion.findFirst({
    where: { responderId: id },
    orderBy: { versionNumber: "desc" },
  });

  await db.autoResponderVersion.create({
    data: {
      responderId: id,
      versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
      subjectTemplate: subject,
      bodyTemplate: body,
      validationStatus: isValid ? "valid" : "invalid",
      createdById: userId,
    },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "auto_responder_updated",
      entityType: "auto_responder",
      entityId: id,
      details: { messageName: responder.messageName, wasActive: existing.status === "ACTIVE" },
    },
  });

  return responder;
}

export async function activateResponder(id: string, userId: string): Promise<AutoResponder> {
  const existing = await db.autoResponder.findUniqueOrThrow({ where: { id } });

  if (existing.status === "ARCHIVED") throw new Error("Cannot activate archived responder");
  if (existing.status === "INVALID") throw new Error("Fix validation errors before activating");

  const validationErrors = validateTemplates(existing.subjectTemplate, existing.bodyTemplate);
  if (validationErrors.length > 0) throw new Error(`Template validation failed: ${validationErrors[0].message}`);

  const existingActive = await db.autoResponder.findFirst({
    where: { channel: existing.channel, status: "ACTIVE", id: { not: id } },
  });
  if (existingActive) {
    throw new Error(`Channel ${existing.channel} already has an active responder: "${existingActive.messageName}". Deactivate it first.`);
  }

  const integration = await db.integration.findUnique({ where: { id: existing.integrationId } });
  if (!integration?.enabled) throw new Error("Integration is not enabled");

  const responder = await db.autoResponder.update({
    where: { id },
    data: { status: "ACTIVE", activatedAt: new Date(), deactivatedAt: null },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "auto_responder_activated",
      entityType: "auto_responder",
      entityId: id,
      details: { messageName: responder.messageName, channel: responder.channel },
    },
  });

  return responder;
}

export async function deactivateResponder(id: string, userId: string): Promise<AutoResponder> {
  const responder = await db.autoResponder.update({
    where: { id },
    data: { status: "INACTIVE", deactivatedAt: new Date() },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "auto_responder_deactivated",
      entityType: "auto_responder",
      entityId: id,
      details: { messageName: responder.messageName, channel: responder.channel },
    },
  });

  return responder;
}

export async function archiveResponder(id: string, userId: string): Promise<AutoResponder> {
  const existing = await db.autoResponder.findUniqueOrThrow({ where: { id } });
  if (existing.status === "ACTIVE") {
    await deactivateResponder(id, userId);
  }

  const responder = await db.autoResponder.update({
    where: { id },
    data: { status: "ARCHIVED", archivedAt: new Date(), updatedById: userId },
  });

  await db.auditLog.create({
    data: {
      userId,
      action: "auto_responder_archived",
      entityType: "auto_responder",
      entityId: id,
    },
  });

  return responder;
}

export async function duplicateResponder(id: string, userId: string): Promise<AutoResponder> {
  const existing = await db.autoResponder.findUniqueOrThrow({ where: { id } });
  return createResponder({
    messageName: `${existing.messageName} (Copy)`,
    channel: existing.channel,
    subjectTemplate: existing.subjectTemplate,
    bodyTemplate: existing.bodyTemplate,
  }, userId);
}

// ─── Job enqueue ─────────────────────────────────────────────────────────────

export async function enqueueAutoResponderJob(params: {
  channel: Platform;
  orderNumber: string;
  trackingNumber?: string;
  carrier?: string;
  ebayItemId?: string;
  ebayBuyerUserId?: string;
  buyerName?: string;
  itemTitle?: string;
  source: "SHIP_ORDERS" | "RECONCILIATION" | "TESTING_AREA";
  responderId?: string;
  responderVersionId?: string;
}): Promise<{ queued: boolean; reason?: string }> {
  console.log(`[auto-responder] enqueueAutoResponderJob called: order=${params.orderNumber} channel=${params.channel} source=${params.source}`);

  const paused = await isAutoResponderPaused();
  if (paused) {
    console.log("[auto-responder] kill switch is active, skipping enqueue");
    return { queued: false, reason: "kill_switch_active" };
  }

  let responderId = params.responderId;
  let responderVersionId = params.responderVersionId;
  let integrationId: string | undefined;

  if (!responderId) {
    const active = await getActiveResponderForChannel(params.channel);
    if (!active) {
      console.log(`[auto-responder] no active responder for ${params.channel}`);
      return { queued: false, reason: "no_active_responder" };
    }
    if (!active.latestVersion) {
      console.log(`[auto-responder] responder ${active.id} has no version`);
      return { queued: false, reason: "no_version" };
    }
    responderId = active.id;
    responderVersionId = active.latestVersion.id;
    integrationId = active.integrationId;
    console.log(`[auto-responder] found active responder: ${responderId} v${active.latestVersion.versionNumber}`);
  } else {
    const responder = await db.autoResponder.findUnique({ where: { id: responderId } });
    if (!responder) return { queued: false, reason: "responder_not_found" };
    integrationId = responder.integrationId;
    if (!responderVersionId) {
      const latestVersion = await db.autoResponderVersion.findFirst({
        where: { responderId },
        orderBy: { versionNumber: "desc" },
      });
      responderVersionId = latestVersion?.id;
    }
  }

  if (!responderVersionId || !integrationId) {
    console.log("[auto-responder] missing version or integration, cannot enqueue");
    return { queued: false, reason: "missing_version_or_integration" };
  }

  const existingLog = await db.autoResponderSendLog.findUnique({
    where: { auto_responder_dedupe: { orderNumber: params.orderNumber, channel: params.channel } },
  });

  if (existingLog && params.source !== "TESTING_AREA") {
    console.log(`[auto-responder] duplicate prevented for ${params.orderNumber}/${params.channel}`);
    return { queued: false, reason: "duplicate_prevented" };
  }

  await db.autoResponderJob.create({
    data: {
      responderId,
      responderVersionId,
      integrationId,
      channel: params.channel,
      orderNumber: params.orderNumber,
      trackingNumber: params.trackingNumber,
      carrier: params.carrier,
      ebayItemId: params.ebayItemId,
      ebayBuyerUserId: params.ebayBuyerUserId,
      buyerName: params.buyerName,
      itemTitle: params.itemTitle,
      source: params.source,
      status: "PENDING",
    },
  });

  console.log(`[auto-responder] job created for ${params.orderNumber}/${params.channel}`);
  return { queued: true };
}

// ─── Bulk enqueue (optimized for Ship Orders batches of 800-1500) ────────────

export async function bulkEnqueueAutoResponderJobs(
  orders: Array<{
    channel: Platform;
    orderNumber: string;
    trackingNumber?: string;
    carrier?: string;
  }>,
): Promise<{ queued: number; skipped: number; reasons: Record<string, number> }> {
  if (orders.length === 0) return { queued: 0, skipped: 0, reasons: {} };

  const reasons: Record<string, number> = {};
  const incReason = (r: string, n = 1) => { reasons[r] = (reasons[r] ?? 0) + n; };

  const paused = await isAutoResponderPaused();
  if (paused) {
    console.log(`[auto-responder] bulk: kill switch active, skipping ${orders.length} orders`);
    return { queued: 0, skipped: orders.length, reasons: { kill_switch_active: orders.length } };
  }

  // Group orders by channel so we look up each responder only once
  const byChannel = new Map<Platform, typeof orders>();
  for (const o of orders) {
    let arr = byChannel.get(o.channel);
    if (!arr) { arr = []; byChannel.set(o.channel, arr); }
    arr.push(o);
  }

  const jobsToCreate: Prisma.AutoResponderJobCreateManyInput[] = [];

  for (const [channel, channelOrders] of byChannel) {
    const active = await getActiveResponderForChannel(channel);
    if (!active) {
      incReason("no_active_responder", channelOrders.length);
      continue;
    }
    if (!active.latestVersion) {
      incReason("no_version", channelOrders.length);
      continue;
    }

    // Bulk dedupe: one query per channel instead of one per order
    const orderNumbers = channelOrders.map((o) => o.orderNumber);
    const existingLogs = await db.autoResponderSendLog.findMany({
      where: { orderNumber: { in: orderNumbers }, channel },
      select: { orderNumber: true },
    });
    const alreadySent = new Set(existingLogs.map((l) => l.orderNumber));

    for (const o of channelOrders) {
      if (alreadySent.has(o.orderNumber)) {
        incReason("duplicate_prevented");
        continue;
      }

      jobsToCreate.push({
        responderId: active.id,
        responderVersionId: active.latestVersion.id,
        integrationId: active.integrationId,
        channel,
        orderNumber: o.orderNumber,
        trackingNumber: o.trackingNumber,
        carrier: o.carrier,
        source: "SHIP_ORDERS",
        status: "PENDING",
      });
    }
  }

  if (jobsToCreate.length > 0) {
    // Prisma createMany is a single INSERT ... VALUES (...), (...), ...
    await db.autoResponderJob.createMany({ data: jobsToCreate });
  }

  const skipped = orders.length - jobsToCreate.length;
  console.log(
    `[auto-responder] bulk enqueue: ${jobsToCreate.length} queued, ${skipped} skipped` +
    (Object.keys(reasons).length > 0 ? ` (${JSON.stringify(reasons)})` : ""),
  );

  return { queued: jobsToCreate.length, skipped, reasons };
}

// ─── Job processing ──────────────────────────────────────────────────────────

export async function processAutoResponderJobs(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}> {
  const paused = await isAutoResponderPaused();
  if (paused) {
    console.log("[auto-responder] processJobs: kill switch active, skipping");
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }

  // Recover stuck jobs: any job PROCESSING for > 5 minutes is likely orphaned
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const { count: unstuck } = await db.autoResponderJob.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: stuckCutoff } },
    data: { status: "PENDING" },
  });
  if (unstuck > 0) console.log(`[auto-responder] recovered ${unstuck} stuck PROCESSING jobs`);

  const jobs = await db.autoResponderJob.findMany({
    where: {
      status: "PENDING",
      processAfter: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: JOBS_PER_BATCH,
    include: {
      responder: true,
      responderVersion: true,
      integration: true,
    },
  });

  if (jobs.length === 0) return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  console.log(`[auto-responder] processJobs: found ${jobs.length} pending jobs`);

  // Mark all as PROCESSING in bulk
  await db.autoResponderJob.updateMany({
    where: { id: { in: jobs.map((j) => j.id) } },
    data: { status: "PROCESSING" },
  });

  // ── Phase 1: Bulk enrichment (1 eBay API call per integration) ──
  const byIntegration = new Map<string, JobWithRelations[]>();
  for (const job of jobs) {
    const group = byIntegration.get(job.integrationId) ?? [];
    group.push(job);
    byIntegration.set(job.integrationId, group);
  }

  const enrichmentMap = new Map<string, EbayOrderDetails>();
  for (const [integrationId, groupJobs] of byIntegration) {
    const needsEnrichment = groupJobs.filter((j) => !j.ebayBuyerUserId || !j.ebayItemId);
    if (needsEnrichment.length === 0) continue;
    try {
      const config = buildEbayConfig(groupJobs[0].integration);
      const details = await fetchEbayOrderDetails(
        integrationId,
        config,
        needsEnrichment.map((j) => j.orderNumber),
      );
      for (const [orderNum, det] of details) {
        enrichmentMap.set(orderNum, det);
      }
      console.log(`[auto-responder] bulk-enriched ${details.size}/${needsEnrichment.length} orders for integration ${integrationId}`);
    } catch (err) {
      console.error(`[auto-responder] bulk enrichment failed for integration ${integrationId}:`, err);
    }
  }

  // ── Phase 2: Send messages with controlled concurrency ──
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < jobs.length; i += SEND_CONCURRENCY) {
    const chunk = jobs.slice(i, i + SEND_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((job) => sendOneJob(job, enrichmentMap)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "sent") sent++;
        else if (r.value === "failed") failed++;
        else skipped++;
      } else {
        failed++;
      }
    }
  }

  console.log(`[auto-responder] processJobs done: ${sent} sent, ${failed} failed, ${skipped} skipped`);
  return { processed: jobs.length, sent, failed, skipped };
}

type JobWithRelations = AutoResponderJob & {
  responder: AutoResponder;
  responderVersion: AutoResponderVersion;
  integration: { id: string; config: unknown; label: string; enabled: boolean };
};

async function sendOneJob(
  job: JobWithRelations,
  enrichmentMap: Map<string, EbayOrderDetails>,
): Promise<"sent" | "failed" | "skipped"> {
  try {
    if (!job.integration.enabled) {
      await autoDisableResponder(job.responderId, "integration_disabled");
      await logSendEvent(job, "INTEGRATION_DISABLED", "SHIP_ORDERS", null, "Integration disabled");
      await db.autoResponderJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: "Integration disabled" } });
      return "skipped";
    }

    let buyerUserId = job.ebayBuyerUserId;
    let itemId = job.ebayItemId;
    let buyerName = job.buyerName;
    let itemTitle = job.itemTitle;

    // Use pre-fetched enrichment data
    if (!buyerUserId || !itemId) {
      const cached = enrichmentMap.get(job.orderNumber);
      if (cached) {
        buyerUserId = buyerUserId || cached.buyerUserId;
        itemId = itemId || cached.itemId;
        buyerName = buyerName || cached.buyerName;
        itemTitle = itemTitle || cached.itemTitle;
      }
    }

    // Fallback: individual fetch if bulk enrichment missed this order
    if (!buyerUserId || !itemId) {
      const config = buildEbayConfig(job.integration);
      const details = await fetchEbayOrderDetails(job.integrationId, config, [job.orderNumber]);
      const orderDetails = details.get(job.orderNumber);
      if (orderDetails) {
        buyerUserId = buyerUserId || orderDetails.buyerUserId;
        itemId = itemId || orderDetails.itemId;
        buyerName = buyerName || orderDetails.buyerName;
        itemTitle = itemTitle || orderDetails.itemTitle;
      }
    }

    if (!buyerUserId || !itemId) {
      await logSendEvent(job, "SKIPPED", job.source, null, "Missing buyer or item data");
      await db.autoResponderJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: "Missing buyer or item data" } });
      return "skipped";
    }

    const ctx: RenderContext = {
      buyerName,
      orderId: job.orderNumber,
      itemName: itemTitle,
      trackingNumber: job.trackingNumber,
      carrier: job.carrier ?? "USPS",
      storeName: job.integration.label,
    };

    const renderedSubject = renderTemplate(job.responderVersion.subjectTemplate, ctx);
    const renderedBody = renderTemplate(job.responderVersion.bodyTemplate, ctx);

    const config = buildEbayConfig(job.integration);
    const sendResult = await sendEbayMessage(
      job.integrationId,
      config,
      itemId,
      buyerUserId,
      renderedSubject,
      renderedBody,
    );

    if (sendResult.success) {
      try {
        await db.autoResponderSendLog.create({
          data: {
            responderId: job.responderId,
            responderVersionId: job.responderVersionId,
            integrationId: job.integrationId,
            channel: job.channel,
            orderNumber: job.orderNumber,
            eventType: "SENT",
            source: job.source,
            renderedSubject,
            renderedBody,
            status: "sent",
            ebayItemId: itemId,
            ebayBuyerUserId: buyerUserId,
            queuedAt: job.createdAt,
            attemptedAt: new Date(),
            sentAt: new Date(),
          },
        });
      } catch (err) {
        const isDupe = err instanceof Error && err.message.includes("Unique constraint");
        if (isDupe) {
          await db.autoResponderJob.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
          return "skipped";
        }
        throw err;
      }
      await db.autoResponderJob.update({ where: { id: job.id }, data: { status: "COMPLETED" } });
      return "sent";
    } else {
      await handleJobFailure(job, sendResult.error ?? "Send failed");
      return "failed";
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[auto-responder] job ${job.id} threw: ${errorMsg}`);
    await handleJobFailure(job, errorMsg);
    return "failed";
  }
}

async function handleJobFailure(job: AutoResponderJob, error: string): Promise<void> {
  const newRetryCount = job.retryCount + 1;
  if (newRetryCount >= MAX_RETRY_COUNT) {
    await db.autoResponderJob.update({
      where: { id: job.id },
      data: { status: "FAILED", lastError: error, retryCount: newRetryCount },
    });

    await db.autoResponderSendLog.create({
      data: {
        responderId: job.responderId,
        responderVersionId: job.responderVersionId,
        integrationId: job.integrationId,
        channel: job.channel,
        orderNumber: job.orderNumber,
        eventType: "FAILED",
        source: job.source,
        status: "failed",
        reason: error,
        queuedAt: job.createdAt,
        attemptedAt: new Date(),
        failedAt: new Date(),
        retryCount: newRetryCount,
      },
    }).catch(() => {
      // Dedupe constraint may block, that's fine
    });
  } else {
    const backoff = RETRY_BACKOFF_MS[newRetryCount - 1] ?? 120_000;
    await db.autoResponderJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        retryCount: newRetryCount,
        lastError: error,
        processAfter: new Date(Date.now() + backoff),
      },
    });
  }
}

async function autoDisableResponder(responderId: string, reason: string): Promise<void> {
  await db.autoResponder.update({
    where: { id: responderId },
    data: { status: "INACTIVE", deactivatedAt: new Date() },
  });
  await db.auditLog.create({
    data: {
      action: "auto_responder_auto_disabled",
      entityType: "auto_responder",
      entityId: responderId,
      details: { reason },
    },
  });
}

async function logSendEvent(
  job: Pick<AutoResponderJob, "responderId" | "responderVersionId" | "integrationId" | "channel" | "orderNumber" | "createdAt">,
  eventType: "SKIPPED" | "DUPLICATE_PREVENTED" | "NO_ACTIVE_RESPONDER" | "INTEGRATION_DISABLED" | "RESPONDER_AUTO_DISABLED",
  source: "SHIP_ORDERS" | "RECONCILIATION" | "PREVIEW" | "TESTING_AREA",
  _renderedContent: null,
  reason: string,
): Promise<void> {
  await db.autoResponderSendLog.create({
    data: {
      responderId: job.responderId,
      responderVersionId: job.responderVersionId,
      integrationId: job.integrationId,
      channel: job.channel,
      orderNumber: job.orderNumber,
      eventType,
      source,
      reason,
      queuedAt: job.createdAt,
      attemptedAt: new Date(),
    },
  }).catch(() => {
    // Dedupe constraint may block — that's safe
  });
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export async function previewResponder(
  responderId: string,
  orderNumber: string,
): Promise<{
  renderedSubject: string;
  renderedBody: string;
  context: RenderContext;
  responderName: string;
  channel: Platform;
}> {
  const responder = await db.autoResponder.findUniqueOrThrow({
    where: { id: responderId },
    include: { integration: true },
  });

  const config = buildEbayConfig(responder.integration);
  const details = await fetchEbayOrderDetails(responder.integrationId, config, [orderNumber]);
  const orderDetails = details.get(orderNumber);

  if (!orderDetails) throw new Error(`Order ${orderNumber} not found on ${responder.channel}`);
  if (!orderDetails.buyerUserId) throw new Error("Buyer user ID missing — cannot preview");
  if (!orderDetails.itemId) throw new Error("Item ID missing — cannot preview");

  const ctx: RenderContext = {
    buyerName: orderDetails.buyerName,
    orderId: orderNumber,
    itemName: orderDetails.itemTitle,
    trackingNumber: undefined,
    carrier: "USPS",
    storeName: responder.integration.label,
  };

  void recordNetworkTransferSample({
    channel: "AUTO_RESPONDER",
    label: `preview / ${responder.channel}`,
    bytesEstimate: 200,
    integrationId: responder.integrationId,
  });

  return {
    renderedSubject: renderTemplate(responder.subjectTemplate, ctx),
    renderedBody: renderTemplate(responder.bodyTemplate, ctx),
    context: ctx,
    responderName: responder.messageName,
    channel: responder.channel,
  };
}

// ─── Log queries ─────────────────────────────────────────────────────────────

export async function getAutoResponderLogs(filters: {
  from?: Date;
  to?: Date;
  channel?: Platform;
  responderId?: string;
  eventType?: string;
  orderNumber?: string;
  page?: number;
  limit?: number;
}): Promise<{ logs: AutoResponderSendLog[]; total: number }> {
  const where: Record<string, unknown> = {};
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (filters.channel) where.channel = filters.channel;
  if (filters.responderId) where.responderId = filters.responderId;
  if (filters.eventType) where.eventType = filters.eventType;
  if (filters.orderNumber) where.orderNumber = { contains: filters.orderNumber };

  const limit = filters.limit ?? 50;
  const page = filters.page ?? 1;

  const [logs, total] = await Promise.all([
    db.autoResponderSendLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: (page - 1) * limit,
      include: { responder: { select: { messageName: true } } },
    }),
    db.autoResponderSendLog.count({ where }),
  ]);

  return { logs, total };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function pruneOldSendLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - SEND_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Only prune non-SENT logs older than retention. Keep SENT logs for dedupe indefinitely.
  const { count } = await db.autoResponderSendLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      eventType: { notIn: ["SENT"] },
    },
  });
  return count;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export async function runReconciliation(): Promise<{
  ordersChecked: number;
  jobsEnqueued: number;
  duplicatesPrevented: number;
}> {
  const paused = await isAutoResponderPaused();
  if (paused) return { ordersChecked: 0, jobsEnqueued: 0, duplicatesPrevented: 0 };

  let ordersChecked = 0;
  let jobsEnqueued = 0;
  let duplicatesPrevented = 0;

  for (const channel of EBAY_CHANNELS) {
    const active = await getActiveResponderForChannel(channel);
    if (!active || !active.activatedAt) continue;

    const integration = await db.integration.findUnique({ where: { platform: channel } });
    if (!integration?.enabled) continue;

    const config = buildEbayConfig(integration);
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let orders: EbayOrderDetails[];
    try {
      orders = await fetchRecentlyShippedOrders(integration.id, config, from, now);
    } catch {
      continue;
    }

    for (const order of orders) {
      ordersChecked++;

      if (!order.shippedTime) continue;
      const shippedAt = new Date(order.shippedTime);
      if (shippedAt < active.activatedAt) continue;

      const result = await enqueueAutoResponderJob({
        channel,
        orderNumber: order.orderId,
        ebayItemId: order.itemId,
        ebayBuyerUserId: order.buyerUserId,
        buyerName: order.buyerName,
        itemTitle: order.itemTitle,
        source: "RECONCILIATION",
      });

      if (result.queued) {
        jobsEnqueued++;
      } else if (result.reason === "duplicate_prevented") {
        duplicatesPrevented++;
      }
    }
  }

  await db.auditLog.create({
    data: {
      action: "auto_responder_reconciliation",
      entityType: "auto_responder",
      details: { ordersChecked, jobsEnqueued, duplicatesPrevented },
    },
  });

  return { ordersChecked, jobsEnqueued, duplicatesPrevented };
}
