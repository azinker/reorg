# reorG Design System — Master File

> When building a page, check `design-system/pages/[page-name].md` first.
> If that file exists, its rules override this Master file. Otherwise, follow rules below.

---

**Project:** reorG by The Perfect Part
**Updated:** 2026-03-15
**Category:** Internal Marketplace Operations Dashboard

---

## Brand Identity

- **App name:** reorG
- **Sub-brand:** by The Perfect Part
- **Feel:** Premium operational dashboard, mission-critical internal tool
- **Not:** Generic admin template, crude Excel clone, or gimmicky UI

---

## Color Palette

### Dark Mode (Default)

| Role | Value | Usage |
|------|-------|-------|
| Background | `oklch(0.12 0.015 275)` | Page background |
| Card | `oklch(0.155 0.018 275)` | Cards, panels |
| Primary | `oklch(0.62 0.18 290)` | Actions, links, primary buttons — deep blue-violet |
| Foreground | `oklch(0.93 0.005 265)` | Primary text |
| Muted Foreground | `oklch(0.60 0.02 265)` | Secondary text, descriptions |
| Border | `oklch(0.26 0.02 275)` | Card borders, dividers |
| Staged | `oklch(0.55 0.18 295)` | Purple badge for staged values |
| Destructive | `oklch(0.55 0.22 29)` | Errors, critical alerts |
| Sidebar | `oklch(0.10 0.015 275)` | Sidebar background — slightly darker |

### Light Mode

| Role | Value | Usage |
|------|-------|-------|
| Background | `oklch(0.985 0 0)` | Page background |
| Card | `oklch(1 0 0)` | Cards, panels |
| Primary | `oklch(0.38 0.14 285)` | Actions — darker violet |
| Foreground | `oklch(0.145 0.015 285)` | Primary text |
| Muted Foreground | `oklch(0.48 0.02 265)` | Secondary text |

### Semantic Colors

| Purpose | Indicator |
|---------|-----------|
| Staged value | Purple badge + subtle highlight |
| Live value | Standard muted text beneath staged |
| Error / missing | Amber warning text, not aggressive red |
| Success | Green accent |
| Write-locked | Orange/amber lock icon |

---

## Typography

- **Primary font:** Inter (already loaded via next/font)
- **Monospace (data cells):** System monospace stack for UPC, SKU, item IDs
- **Headings:** Inter, semibold to bold, tight tracking
- **Body:** Inter, regular weight
- **Data cells:** 13-14px for comfortable density, 12px for compact

---

## Spacing & Density

| Density | Cell padding | Row height | Font size |
|---------|-------------|------------|-----------|
| Comfortable (default) | 12px 16px | 48px | 14px |
| Compact | 6px 12px | 36px | 13px |
| Spacious | 16px 20px | 56px | 14px |

---

## Component Patterns

### Store Mini-Blocks

- Fixed-width blocks inside cells for per-store values
- Each block shows: store acronym (TPP, TT, BC, SHPFY) + value
- Uniform height and width across all rows
- Use subtle border and background differentiation
- Align blocks horizontally inside the cell
- Missing store = empty slot with consistent sizing (no layout shift)

### Staged Value Display

- Staged value: prominent, normal font weight, purple "Staged" badge beside it
- Live value: smaller text beneath, muted color, labeled "Live"
- Difference must be obvious at a glance without interaction

### Data Grid

- Alternating row backgrounds for scanability (very subtle)
- Row hover: subtle background highlight
- Selected row: slightly stronger highlight
- Frozen columns: subtle right-border shadow to indicate scroll boundary
- Header row: sticky, slightly darker background, uppercase labels or semibold

### Modals & Drawers

- Dark overlay with slight blur
- Card-style content area
- Close via X button and Esc key
- Max-width appropriate to content

---

## Interaction Standards

- All clickable elements: `cursor-pointer`
- Hover transitions: 150-200ms, color/opacity only (no scale/transform that shifts layout)
- Focus ring: visible, 2px offset, matches primary color
- Button states: default, hover, active, disabled (50% opacity)
- Links to external marketplace listings: `target="_blank"` with `rel="noopener noreferrer"`

---

## Icon System

- **Library:** Lucide React (`lucide-react`)
- **Size:** 16px (w-4 h-4) default, 20px (w-5 h-5) for emphasis
- **Never** use emojis as UI icons
- Marketplace logos: use official SVG assets or labeled acronym badges

---

## Accessibility

- WCAG AA minimum (4.5:1 text contrast, 3:1 large text)
- All form inputs have visible labels
- Color is never the sole indicator — pair with text/icon
- `prefers-reduced-motion` respected
- Keyboard navigation: focus states on all interactive elements
- Screen reader: meaningful alt text, aria-labels where needed

---

## Anti-Patterns (Forbidden)

- No emojis as icons
- No layout-shifting hover effects
- No light mode as default (dark mode is default)
- No aggressive red for staged values (use purple)
- No slow transitions (>300ms)
- No invisible focus states
- No messy stacked text blobs in cells — always structured mini-blocks
- No inconsistent store block sizing across rows
