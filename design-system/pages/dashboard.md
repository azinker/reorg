# Dashboard Page Design

> Overrides MASTER.md for the main data grid page.

## Purpose

Primary operational screen. Virtualized data grid showing all master-store SKU groups
with per-store mini-blocks, inline editing, and staged value comparison.

## Layout

- Sticky search bar at top (hideable via preference)
- Filter bar beneath search
- Data grid fills remaining viewport height
- Frozen columns on left (UPC, Item IDs, SKU, Title)
- Horizontal scroll for remaining columns

## Search Bar

- Full-width, rounded input with search icon
- Dynamic autocomplete dropdown (no Enter required)
- Subtle background, prominent on focus
- Hide/show toggle in top-right corner of search area

## Grid Specifics

- Virtualized rows via TanStack Virtual
- Row height: per density setting
- Alternating row backgrounds (subtle 2% opacity difference)
- Variation parents: slightly bolder left border
- Variation children: indented with connecting line indicator
- Expand/collapse chevron for variation parents

## Cell Types

- **UPC:** Barcode image above raw digits, monospace
- **Item IDs:** Store-tagged link blocks, fixed-width per store
- **SKU:** Monospace, prominent, copyable on right-click
- **Title:** Truncated with tooltip on hover
- **Photo:** 40x40 thumbnail, click for modal preview
- **Sale Price:** Store mini-blocks, editable, staged/live display
- **Profit:** Store mini-blocks, calculated, non-editable
- **Ad Rate:** Store mini-blocks, editable for eBay, N/A for BC/SHPFY
- **Weight/Supplier Cost/Supplier Shipping:** Single value at row level

## Staged Treatment

- Purple "Staged" micro-badge next to edited values
- Live value in smaller muted text below
- Subtle purple left-border on rows with any staged changes
