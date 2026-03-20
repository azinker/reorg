import type { TourStep } from "@/components/onboarding/tour-overlay";

export const DASHBOARD_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: null,
    title: "Welcome to the Dashboard",
    body: "This tour walks you through how to find products, filter your view, use the toolbar, and read each major column. Take your time—use Next and Back, or the X to exit; you can always restart from Settings or the Tour button in the top bar.",
  },
  {
    id: "connection",
    target: "dashboard-connection",
    title: "Live data vs sample data",
    body: "The header shows whether you are connected to your real Neon database or viewing mock/sample rows. Green means live data is loading. Amber means you are not on live data (empty DB, connection issue, or local demo).\n\nExample: Before a buyer meeting, you confirm the line says “Connected” so the SKUs and prices you discuss match production.",
  },
  {
    id: "search",
    target: "dashboard-search",
    title: "Search across the catalog",
    body: "Type a SKU, words from the title, a UPC, or a marketplace item ID. Matching rows appear in a dropdown; pick one and the grid scrolls that product into view. Use Show/Hide search if you need more vertical space.\n\nExample: A customer emails “Item ID 1234567890 on eBay”—paste that ID here and jump straight to the row.",
  },
  {
    id: "filters",
    target: "dashboard-filters",
    title: "Filters that match how you work",
    body: "Limit the grid by store (TPP, TT, BigCommerce, Shopify), stock (in stock, low, out), “Staged only” for changes not yet pushed, or “Missing data” (no UPC, image, cost, etc.). Combine filters to audit problems. Clear resets everything.\n\nExample: Choose “Missing UPC” before a listing blitz so you only fix barcodes that block publishing.",
  },
  {
    id: "row-count",
    target: "dashboard-row-count",
    title: "How many rows you are looking at",
    body: "The count shows rows that match your search and filters. If you see two numbers, the second is the total before filters—useful when something “disappeared” because a filter hid it.\n\nExample: You expected 200 SKUs but see “50 rows (200 total)”—clear Missing Image to see who was filtered out.",
  },
  {
    id: "global-price",
    target: "dashboard-global-price",
    title: "Global Price Update",
    body: "Opens a guided flow to apply a price change across many listings at once (by rules you choose in the modal), instead of editing one cell at a time. Review carefully before confirming—this affects many rows.\n\nExample: Your supplier raises cost 5% on a line of shackles—you use Global Price Update to bump retail on all affected SKUs in one pass.",
  },
  {
    id: "staged-tools",
    target: "dashboard-staged-tools",
    title: "Staged changes & failed pushes",
    body: "When present, “Clear Staged” drops local draft values you have not pushed live yet (after confirmation). “Pushes Failed” opens details when a marketplace write did not complete—fix credentials or data, then retry.\n\nExample: After a long editing session, you clear staged on one store only to realize you still had TPP prices staged—this bar reminds you before you push.",
  },
  {
    id: "columns-export",
    target: "dashboard-columns-export",
    title: "Columns & export",
    body: "Columns lets you show or hide optional fields (weight, supplier cost, ad rate, profit, etc.). Frozen columns stay on the left when you scroll sideways. Export downloads the current grid view for spreadsheets or sharing.\n\nExample: Your accountant only needs SKU, title, and supplier cost—hide the rest, export CSV, and send the file.",
  },
  {
    id: "grid",
    target: "dashboard-grid",
    title: "The grid—scroll and skim",
    body: "This is the main table: each row is a product (or a child variation under a parent). Scroll horizontally to reach prices, fees, ad rates, and profit. Vertically you will see hundreds or thousands of rows—density and font size live in Settings.\n\nExample: You skim the Profit column while scrolling to spot outliers before a pricing meeting.",
  },
  {
    id: "header-expand",
    target: "dashboard-header-expand",
    title: "Expand parent rows (variations)",
    body: "The chevron column opens “parent” rows that group child SKUs—think one listing with Size or Color options. Expanding shows each child’s own prices and IDs without losing the parent context.\n\nExample: A tow strap listing has three lengths as child SKUs—you expand to confirm each length’s eBay price matches your sheet.",
  },
  {
    id: "header-frozen",
    target: "dashboard-header-frozen",
    title: "Frozen columns—identity stays put",
    body: "Photo, UPC, Item IDs, SKU, and Title usually stay fixed on the left while you scroll prices to the right—so you always know which product you are editing. Column headers with arrows sort when you click (e.g. SKU, Title).\n\nExample: You compare Sale Price across SHPFY vs TPP—SKU stays visible so you never lose your place.",
  },
  {
    id: "header-qty",
    target: "dashboard-header-qty",
    title: "Live quantity",
    body: "Shows marketplace inventory for the row (and can be sorted). Use it with stock filters to prioritize replenishment or to catch zero qty before a promo.\n\nExample: Filter “Low Stock” and sort quantity ascending—fulfill the 3‑unit SKUs first.",
  },
  {
    id: "header-sale-price",
    target: "dashboard-header-sale-price",
    title: "Sale Price—edit, stage, or push",
    body: "Each store appears as its own pill. Click to edit; after you confirm the value, choose Stage (safe draft—recalculates profit) or Push (send live immediately if your org allows). You will see STAGED vs LIVE badges when they differ.\n\nExample: You stage $19.99 on Shopify SHPFY, check profit, then Push when the promo starts Friday.",
  },
  {
    id: "header-platform-fees",
    target: "dashboard-header-platform-fees",
    title: "Platform fees (eBay)",
    body: "Adjust the blended marketplace fee percentage used for eBay-side math. Changing it updates how profit is estimated for those listings—use your real blended rate (fees + promos).\n\nExample: Your effective eBay take is 12.7% after promos—you set that here so Profit is not falsely high.",
  },
  {
    id: "header-ad-rate",
    target: "dashboard-header-ad-rate",
    title: "Promoted General Ad Rate",
    body: "Promoted listing spend as a percent of revenue, by store. Edit like sale price: stage to preview profit impact, then push when ready. Some stores may show N/A if ads are not modeled there.\n\nExample: You raise promoted spend from 8% to 10% on TPP eBay—stage first so Profit shows whether the SKU still clears your floor.",
  },
  {
    id: "header-profit",
    target: "dashboard-header-profit",
    title: "Profit column",
    body: "Estimated margin after sale price, supplier cost, shipping, fees, and ad rate (where applicable). Use it as a sanity check—not tax advice. If a column is hidden, turn it on under Columns.\n\nExample: Two listings look similar in price, but one has higher shipping—Profit shows which actually earns more.",
  },
  {
    id: "wrap-up",
    target: null,
    title: "You are set",
    body: "Use the Tour button in the top bar anytime to run this again. In Settings you can replay the tour, change density, search bar, write locks, and more. When you are done with a session, log out from the top bar if you are on a shared machine.",
  },
];
