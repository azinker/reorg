import type { Integration, Platform } from "@prisma/client";
import { getAppEnv } from "@/lib/app-env";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";

export function getExpectedWebhookBaseUrl() {
  const appEnv = getAppEnv();

  if (appEnv === "production") {
    return "https://reorg.theperfectpart.net";
  }

  if (appEnv === "staging") {
    return "https://stage.reorg.theperfectpart.net";
  }

  const baseUrl = process.env.AUTH_URL?.trim();
  if (!baseUrl) {
    throw new Error("AUTH_URL must be set before resolving local webhook destinations.");
  }

  return baseUrl.replace(/\/$/, "");
}

function getAcceptedWebhookBaseUrls() {
  const appEnv = getAppEnv();

  if (appEnv === "production") {
    return ["https://reorg.theperfectpart.net"];
  }

  if (appEnv === "staging") {
    return ["https://stage.reorg.theperfectpart.net"];
  }

  const baseUrls = new Set<string>([
    "https://reorg.theperfectpart.net",
    "https://stage.reorg.theperfectpart.net",
  ]);
  const localBaseUrl = process.env.AUTH_URL?.trim();
  if (localBaseUrl) {
    baseUrls.add(localBaseUrl.replace(/\/$/, ""));
  }

  return [...baseUrls];
}

export function getExpectedWebhookDestination(platform: Platform) {
  switch (platform) {
    case "SHOPIFY":
      return `${getExpectedWebhookBaseUrl()}/api/webhooks/shopify`;
    case "BIGCOMMERCE":
      return `${getExpectedWebhookBaseUrl()}/api/webhooks/bigcommerce`;
    default:
      return null;
  }
}

export function assessIntegrationWebhookHealth(
  integration: Pick<Integration, "platform" | "config">,
) {
  const appEnv = getAppEnv();
  const config = getIntegrationConfig(integration);
  const expectedDestination = getExpectedWebhookDestination(integration.platform);
  const acceptedDestinations = getAcceptedWebhookBaseUrls().map((baseUrl) => {
    switch (integration.platform) {
      case "SHOPIFY":
        return `${baseUrl}/api/webhooks/shopify`;
      case "BIGCOMMERCE":
        return `${baseUrl}/api/webhooks/bigcommerce`;
      default:
        return null;
    }
  }).filter((value): value is string => Boolean(value));
  const currentDestination = config.webhookState.destination;

  if (!expectedDestination) {
    return {
      status: "info" as const,
      message: "This integration does not use webhook registration.",
      expectedDestination: null,
      currentDestination,
    };
  }

  if (!currentDestination) {
    return {
      status: "warning" as const,
      message: "Webhook destination has not been registered yet.",
      expectedDestination,
      currentDestination: null,
    };
  }

  if (appEnv === "local" && acceptedDestinations.includes(currentDestination)) {
    return {
      status: "ok" as const,
      message: "Webhook destination points to a deployed environment, which is expected while running locally.",
      expectedDestination,
      currentDestination,
    };
  }

  if (currentDestination !== expectedDestination) {
    return {
      status: "warning" as const,
      message: "Webhook destination does not match the expected environment domain.",
      expectedDestination,
      currentDestination,
    };
  }

  return {
    status: "ok" as const,
    message: "Webhook destination matches the expected environment domain.",
    expectedDestination,
    currentDestination,
  };
}
