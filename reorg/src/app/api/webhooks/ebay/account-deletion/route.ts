import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildEbayChallengeResponse,
  getEbayAccountDeletionVerificationToken,
  resolveEbayAccountDeletionEndpoint,
} from "@/lib/ebay-account-deletion";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readChallengeCode(request: NextRequest) {
  return (
    request.nextUrl.searchParams.get("challenge_code") ||
    request.nextUrl.searchParams.get("challengeCode")
  );
}

async function writeAuditLog(args: {
  action: string;
  details: Prisma.InputJsonObject;
}) {
  await db.auditLog.create({
    data: {
      action: args.action,
      entityType: "webhook",
      entityId: "ebay-marketplace-account-deletion",
      details: args.details,
    },
  }).catch((error) => {
    console.error("[ebay-account-deletion] audit log write failed", error);
  });
}

export async function GET(request: NextRequest) {
  const challengeCode = readChallengeCode(request);
  const verificationToken = getEbayAccountDeletionVerificationToken();
  const endpoint = resolveEbayAccountDeletionEndpoint();

  if (!challengeCode) {
    return NextResponse.json(
      {
        ok: true,
        endpoint,
        message:
          "eBay Marketplace Account Deletion challenge endpoint is live. Provide challenge_code to verify it.",
      },
      { status: 200 },
    );
  }

  if (!verificationToken || !endpoint) {
    return NextResponse.json(
      {
        error:
          "EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN and endpoint URL must be configured before answering the eBay challenge.",
      },
      { status: 503 },
    );
  }

  const challengeResponse = buildEbayChallengeResponse({
    challengeCode,
    verificationToken,
    endpoint,
  });

  await writeAuditLog({
    action: "ebay_account_deletion_challenge",
    details: {
      endpoint,
      challengeCode,
      respondedAt: new Date().toISOString(),
    },
  });

  return NextResponse.json({ challengeResponse }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let payload: Prisma.InputJsonValue | null = null;

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody) as Prisma.InputJsonValue;
    } catch {
      payload = rawBody;
    }
  }

  void recordNetworkTransferSample({
    channel: "WEBHOOK_INBOUND",
    label: "eBay account deletion webhook inbound",
    bytesEstimate: rawBody ? Buffer.byteLength(rawBody, "utf8") : null,
    metadata: { type: "account_deletion" },
  });

  await writeAuditLog({
    action: "ebay_account_deletion_notification",
    details: {
      endpoint: resolveEbayAccountDeletionEndpoint(),
      receivedAt: new Date().toISOString(),
      payload,
    },
  });

  return NextResponse.json({ received: true }, { status: 200 });
}
