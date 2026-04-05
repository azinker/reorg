/**
 * Low-level Shopify Admin GraphQL POST helper (shared by webhooks, withdraw funds, etc.).
 */

export async function shopifyGraphQL<T>(
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
    throw new Error(`Shopify GraphQL request failed with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  // Shopify may return field-level errors alongside partial data (e.g. payoutSchedule
  // not available for some accounts). Only throw if there is NO data at all.
  if (json.errors?.length && !json.data) {
    throw new Error(
      json.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; "),
    );
  }

  if (!json.data) {
    throw new Error("Shopify GraphQL returned no data.");
  }

  return json.data;
}
