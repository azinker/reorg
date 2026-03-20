export const ONBOARDING_PAGES = [
  "dashboard",
  "sync",
  "integrations",
  "engineRoom",
  "errors",
  "unmatched",
  "import",
  "shippingRates",
  "backups",
  "setup",
  "users",
  "settings",
] as const;

export type OnboardingPageKey = (typeof ONBOARDING_PAGES)[number];

export const PATH_TO_ONBOARDING_PAGE: Record<string, OnboardingPageKey> = {
  "/dashboard": "dashboard",
  "/sync": "sync",
  "/integrations": "integrations",
  "/engine-room": "engineRoom",
  "/errors": "errors",
  "/unmatched": "unmatched",
  "/import": "import",
  "/shipping-rates": "shippingRates",
  "/backups": "backups",
  "/setup": "setup",
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
