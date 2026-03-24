import { createHash, timingSafeEqual } from "node:crypto";

const ACCOUNT_DELETION_PATH = "/api/webhooks/ebay/account-deletion";

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveEbayAccountDeletionEndpoint() {
  const explicit = process.env.EBAY_MARKETPLACE_ACCOUNT_DELETION_ENDPOINT?.trim();
  if (explicit) {
    return trimTrailingSlash(explicit);
  }

  const authUrl = process.env.AUTH_URL?.trim();
  if (authUrl) {
    return `${trimTrailingSlash(authUrl)}${ACCOUNT_DELETION_PATH}`;
  }

  return null;
}

export function getEbayAccountDeletionVerificationToken() {
  const token = process.env.EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN?.trim();
  return token || null;
}

export function buildEbayChallengeResponse(args: {
  challengeCode: string;
  verificationToken: string;
  endpoint: string;
}) {
  const payload = `${args.challengeCode}${args.verificationToken}${trimTrailingSlash(args.endpoint)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function isValidEbayChallengeResponse(
  actualResponse: string,
  expectedResponse: string,
) {
  const actualBuffer = Buffer.from(actualResponse, "utf8");
  const expectedBuffer = Buffer.from(expectedResponse, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

