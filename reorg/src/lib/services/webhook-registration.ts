import { Prisma, type Integration, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";

const SHOPIFY_TOPICS = [
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
] as const;

const BIGCOMMERCE_SCOPES = [
  "store/product/created",
  "store/product/updated",
  "store/product/deleted",
  "store/channel/*/inventory/product/stock_changed",
] as const;

type IntegrationWithConfig = Pick<
  Integration,
  "id" | "platform" | "label" | "config"
>;

interface EnsureWebhookResult {
  platform: Platform;
  label: string;
  destination: string;
  topics: string[];
  providerIds: string[];
}

function getRequiredBaseUrl() {
  const baseUrl = process.env.AUTH_URL?.trim();
  if (!baseUrl) {
    throw new Error("AUTH_URL must be set before registering marketplace webhooks.");
  }

  return baseUrl.replace(/\/$/, "");
}

function asStringConfig(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function saveWebhookState(
  integration: IntegrationWithConfig,
  result: Omit<EnsureWebhookResult, "platform" | "label"> | null,
  error: string | null,
) {
  const config = getIntegrationConfig(integration);

  await db.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...config,
        webhookState: {
          ...config.webhookState,
          destination: result?.destination ?? config.webhookState.destination,
          topics: result?.topics ?? config.webhookState.topics,
          providerIds: result?.providerIds ?? config.webhookState.providerIds,
          lastEnsuredAt: new Date().toISOString(),
          lastEnsureError: error,
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

async function shopifyGraphQL<T>(
  endpoint: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify webhook registration failed with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  if (json.errors?.length) {
    throw new Error(
      `Shopify webhook registration failed: ${json.errors
        .map((error) => error.message ?? "Unknown GraphQL error")
        .join("; ")}`,
    );
  }

  if (!json.data) {
    throw new Error("Shopify webhook registration returned no data.");
  }

  return json.data;
}

async function ensureShopifyWebhooks(
  integration: IntegrationWithConfig,
): Promise<EnsureWebhookResult> {
  const config = integration.config as Record<string, unknown>;
  const storeDomain = asStringConfig(config, "storeDomain") ?? process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken =
    asStringConfig(config, "accessToken") ?? process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion =
    asStringConfig(config, "apiVersion") ??
    process.env.SHOPIFY_API_VERSION ??
    "2026-01";

  if (!storeDomain || !accessToken) {
    throw new Error("Shopify webhook registration requires storeDomain and accessToken.");
  }

  const normalizedStore = storeDomain.includes(".")
    ? storeDomain
    : `${storeDomain}.myshopify.com`;
  const destination = `${getRequiredBaseUrl()}/api/webhooks/shopify`;
  const endpoint = `https://${normalizedStore}/admin/api/${apiVersion}/graphql.json`;

  const listData = await shopifyGraphQL<{
    webhookSubscriptions: {
      edges: Array<{
        node: {
          id: string;
          topic: string;
          uri: string | null;
        };
      }>;
    };
  }>(
    endpoint,
    accessToken,
    `query ExistingWebhookSubscriptions($uri: String!) {
      webhookSubscriptions(first: 50, uri: $uri) {
        edges {
          node {
            id
            topic
            uri
          }
        }
      }
    }`,
    { uri: destination },
  );

  const existing = listData.webhookSubscriptions.edges.map((edge) => edge.node);
  const existingByTopic = new Map(existing.map((item) => [item.topic, item]));

  const createQuery = `mutation CreateWebhookSubscription($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }`;

  for (const topic of SHOPIFY_TOPICS) {
    if (existingByTopic.has(topic)) continue;

    const createData = await shopifyGraphQL<{
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: string;
          topic: string;
          uri: string | null;
        } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(endpoint, accessToken, createQuery, {
      topic,
      webhookSubscription: {
        uri: destination,
      },
    });

    if (createData.webhookSubscriptionCreate.userErrors.length > 0) {
      throw new Error(
        `Shopify could not register ${topic}: ${createData.webhookSubscriptionCreate.userErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }

    const created = createData.webhookSubscriptionCreate.webhookSubscription;
    if (created) {
      existingByTopic.set(created.topic, created);
    }
  }

  const registered = SHOPIFY_TOPICS.map((topic) => existingByTopic.get(topic)).filter(
    (item): item is { id: string; topic: string; uri: string | null } => !!item,
  );

  return {
    platform: integration.platform,
    label: integration.label,
    destination,
    topics: registered.map((item) => item.topic).sort(),
    providerIds: registered.map((item) => item.id).sort(),
  };
}

async function bigCommerceRequest<T>(
  storeHash: string,
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.bigcommerce.com/stores/${storeHash}/v3${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Auth-Token": accessToken,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `BigCommerce webhook registration failed with HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  return (await response.json()) as T;
}

async function ensureBigCommerceWebhooks(
  integration: IntegrationWithConfig,
): Promise<EnsureWebhookResult> {
  const config = integration.config as Record<string, unknown>;
  const storeHash =
    asStringConfig(config, "storeHash") ?? process.env.BIGCOMMERCE_STORE_HASH;
  const accessToken =
    asStringConfig(config, "accessToken") ?? process.env.BIGCOMMERCE_ACCESS_TOKEN;
  const sharedSecret = process.env.BIGCOMMERCE_WEBHOOK_SECRET;

  if (!storeHash || !accessToken || !sharedSecret) {
    throw new Error(
      "BigCommerce webhook registration requires storeHash, accessToken, and BIGCOMMERCE_WEBHOOK_SECRET.",
    );
  }

  const destination = `${getRequiredBaseUrl()}/api/webhooks/bigcommerce`;
  const existingResponse = await bigCommerceRequest<{
    data?: Array<{
      id: number | string;
      scope: string;
      destination: string;
      is_active: boolean;
    }>;
  }>(storeHash, accessToken, "/hooks");

  const existing = existingResponse.data ?? [];
  const matchingByScope = new Map(
    existing
      .filter((hook) => hook.destination === destination)
      .map((hook) => [hook.scope, hook]),
  );

  const providerIds: string[] = [];

  for (const scope of BIGCOMMERCE_SCOPES) {
    const current = matchingByScope.get(scope);
    const payload = {
      scope,
      destination,
      is_active: true,
      headers: {
        Authorization: `Bearer ${sharedSecret}`,
      },
    };

    if (!current) {
      const created = await bigCommerceRequest<{
        data?: { id: number | string };
      }>(storeHash, accessToken, "/hooks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (created.data?.id != null) {
        providerIds.push(String(created.data.id));
      }
      continue;
    }

    const ensured = await bigCommerceRequest<{
      data?: { id: number | string };
    }>(storeHash, accessToken, `/hooks/${current.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    providerIds.push(String(ensured.data?.id ?? current.id));
  }

  return {
    platform: integration.platform,
    label: integration.label,
    destination,
    topics: [...BIGCOMMERCE_SCOPES].sort(),
    providerIds: providerIds.sort(),
  };
}

export async function ensureIntegrationWebhooks(platform: Platform) {
  const integration = await db.integration.findUnique({
    where: { platform },
    select: {
      id: true,
      platform: true,
      label: true,
      config: true,
    },
  });

  if (!integration) {
    throw new Error(`${platform} integration not found.`);
  }

  let result: EnsureWebhookResult;
  try {
    result =
      platform === "SHOPIFY"
        ? await ensureShopifyWebhooks(integration)
        : platform === "BIGCOMMERCE"
          ? await ensureBigCommerceWebhooks(integration)
          : (() => {
              throw new Error(`${platform} does not support webhook registration.`);
            })();

    await saveWebhookState(integration, result, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook registration failed.";
    await saveWebhookState(integration, null, message);
    throw error;
  }

  await db.auditLog.create({
    data: {
      action: "webhook_registration_ensured",
      entityType: "integration",
      entityId: integration.id,
      details: {
        platform: result.platform,
        destination: result.destination,
        topics: result.topics,
        providerIds: result.providerIds,
      },
    },
  });

  return result;
}

export async function ensureConfiguredMarketplaceWebhooks() {
  const results = [];

  for (const platform of [Platform.SHOPIFY, Platform.BIGCOMMERCE] as const) {
    results.push(await ensureIntegrationWebhooks(platform));
  }

  return results;
}
