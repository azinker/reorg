const LOCAL_KEY = "reorg_onboarding_dashboard_tour";

export function getLocalDashboardTourSeen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(LOCAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLocalDashboardTourSeen(seen: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (seen) localStorage.setItem(LOCAL_KEY, "1");
    else localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* quota */
  }
}
