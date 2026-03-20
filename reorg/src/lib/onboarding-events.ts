/** Dispatched from the TopBar to open/close the dashboard tour (toggle when already on /dashboard). */
export const OPEN_DASHBOARD_TOUR_EVENT = "reorg:open-dashboard-tour";

export function dispatchToggleDashboardTour() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_DASHBOARD_TOUR_EVENT));
}
