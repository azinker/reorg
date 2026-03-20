import type { TourStep } from "@/components/onboarding/tour-overlay";

export const DASHBOARD_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: null,
    title: "Welcome to the Dashboard",
    body: "This quick tour walks through the main parts of the Marketplace Operations dashboard—search, filters, grid tools, and your live data connection. Use Next to continue, Back to review a step, or the X to exit anytime.",
  },
  {
    id: "connection",
    target: "dashboard-connection",
    title: "Connection status",
    body: "This line shows whether you’re connected to the live database or viewing sample data. Hover it when connected to see product counts and related listings by store.",
  },
  {
    id: "search",
    target: "dashboard-search",
    title: "Search",
    body: "Find SKUs quickly by typing a SKU, title, UPC, or marketplace item ID. Pick a result to scroll that row into view in the grid.",
  },
  {
    id: "filters",
    target: "dashboard-filters",
    title: "Filters",
    body: "Narrow the grid by store, stock level, staged changes only, or missing data (e.g. missing UPC). Use Clear when you want to reset filters.",
  },
  {
    id: "toolbar",
    target: "dashboard-toolbar",
    title: "Row count & actions",
    body: "See how many rows match your filters. From here you can run a global price update, clear staged values, review failed pushes, choose visible columns, or export.",
  },
  {
    id: "grid",
    target: "dashboard-grid",
    title: "Product grid",
    body: "Scroll horizontally for pricing, fees, ad rates, and profit. Expand parent rows to see child SKUs. Many cells are editable—hover for actions like copy or edit.",
  },
];
