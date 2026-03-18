import { ensureConfiguredMarketplaceWebhooks } from "../src/lib/services/webhook-registration";

async function main() {
  const results = await ensureConfiguredMarketplaceWebhooks();

  for (const result of results) {
    console.log(
      [
        `${result.label} (${result.platform})`,
        `destination=${result.destination}`,
        `topics=${result.topics.join(",")}`,
        `providerIds=${result.providerIds.join(",")}`,
      ].join(" | "),
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Failed to ensure marketplace webhooks.",
  );
  process.exit(1);
});
