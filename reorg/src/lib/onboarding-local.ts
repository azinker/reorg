import type { OnboardingPageKey } from "@/lib/onboarding-pages";

function localKey(page: OnboardingPageKey) {
  return `reorg_onboarding_${page}_tour`;
}

export function getLocalTourSeen(page: OnboardingPageKey): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(localKey(page)) === "1";
  } catch {
    return false;
  }
}

export function setLocalTourSeen(page: OnboardingPageKey, seen: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (seen) localStorage.setItem(localKey(page), "1");
    else localStorage.removeItem(localKey(page));
  } catch {
    /* quota */
  }
}

export function clearAllLocalTours() {
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("reorg_onboarding_") && key.endsWith("_tour")) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* */
  }
}
