import type { OnboardingPageKey } from "@/lib/onboarding-pages";

export const OPEN_PAGE_TOUR_EVENT = "reorg:open-page-tour";

export function dispatchTogglePageTour(page: OnboardingPageKey) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_PAGE_TOUR_EVENT, { detail: { page } }));
}
