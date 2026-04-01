export const ONBOARDING_PAGES = [
  "dashboard",
  "inventoryForecaster",
  "tasks",
  "revenue",
  "sync",
  "integrations",
  "engineRoom",
  "publicNetworkTransfer",
  "errors",
  "unmatched",
  "import",
  "shippingRates",
  "backups",
  "users",
  "settings",
] as const;

export type OnboardingPageKey = (typeof ONBOARDING_PAGES)[number];

export const PATH_TO_ONBOARDING_PAGE: Record<string, OnboardingPageKey> = {
  "/dashboard": "dashboard",
  "/inventory-forecaster": "inventoryForecaster",
  "/tasks": "tasks",
  "/revenue": "revenue",
  "/sync": "sync",
  "/integrations": "integrations",
  "/engine-room": "engineRoom",
  "/public-network-transfer": "publicNetworkTransfer",
  "/errors": "errors",
  "/unmatched": "unmatched",
  "/import": "import",
  "/shipping-rates": "shippingRates",
  "/backups": "backups",
  "/users": "users",
  "/settings": "settings",
};

export function onboardingPageFromPathname(pathname: string): OnboardingPageKey | null {
  const clean = pathname.split("?")[0].split("#")[0];
  const normalized = clean !== "/" && clean.endsWith("/") ? clean.slice(0, -1) : clean;
  return PATH_TO_ONBOARDING_PAGE[normalized] ?? null;
}

export function onboardingFlagKey(page: OnboardingPageKey): string {
  return `${page}TourSeen`;
}
