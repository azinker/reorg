# reorG - Project Agent Instructions

## Identity

**reorG** by The Perfect Part — an internal marketplace operations application.
Production domain: `reorg.theperfectpart.net`
Staging domain: `stage.reorg.theperfectpart.net`

This document is the persistent source of truth for AI agents working on this codebase.
The master product spec lives in the original prompt and the architecture plan.
This file captures the long-lived rules, conventions, and safety constraints that
must be respected in every session regardless of context window limits.

---

## Absolute Safety Rules

These rules are non-negotiable. No agent, refactor, or feature request may violate them.

1. **NEVER** implement marketplace listing deletion — no delete endpoints, no delete UI, no delete code paths, even if the SDK supports them.
2. **NEVER** push any marketplace change without explicit user confirmation.
3. **NEVER** allow sync to push data. Manual and scheduled sync are pull-only.
4. **NEVER** allow sync to overwrite staged internal values. Sync only refreshes live marketplace values.
5. **NEVER** auto-restore backups into marketplaces. v1 backups are export/download only.
6. **NEVER** expose secrets in client-side code, logs, API responses, or git history.
7. **NEVER** allow writes in the staging environment unless the staging write lock is explicitly disabled by an admin.
8. If there is any ambiguity about whether an operation is read-only or write-capable, treat it as **read-only** until the spec explicitly says otherwise.

---

## Write Safety Architecture

All marketplace writes must pass through this chain:

1. Check global write lock → block if locked
2. Check per-integration write lock → block if locked
3. Check environment (staging = blocked by default)
4. Run dry-run first → display results to user
5. User confirms dry-run results
6. Execute real push with full audit logging
7. Auto-backup triggered before bulk pushes
8. Update staged change status
9. Refresh live values via targeted sync

Write locks, dry-run mode, and per-store write enablement must be exposed in the Settings/Integrations UI for Admin users.

---

## Data Model Rules

### Row Identity

- One main row = one master-store SKU group
- Master store is TPP eBay (configurable, but changing it is a major operation requiring multi-step confirmation)
- Row identity is driven by master-store SKU, not by marketplace listing IDs
- Other stores attach to the master row via exact SKU match only — no fuzzy matching
- Unmatched external listings go to a separate "Unmatched External Listings" page, never into the main grid

### Staged vs Live Values

- Staged changes are stored in a separate `StagedChange` table
- Sync refreshes `MarketplaceListing` (live values) but never touches `StagedChange`
- When a staged value exists, it is displayed prominently; the live value appears smaller underneath
- Staged values persist until explicitly pushed or cancelled
- Edits autosave after a 500ms debounce — they do NOT auto-push

### Variation Listings

- Parent listing = synthetic grouping row at top level
- Child variants = indented nested rows underneath
- Collapsed by default, expandable by user
- Master-store-first structure; cross-marketplace children linked by SKU

### Duplicate Handling

- If master store has duplicate SKUs across different item IDs: one MasterRow, multiple MarketplaceListing records
- If duplicate item IDs have different titles: show first title, alert user about alternates

---

## Store Acronyms

| Store | Acronym | Platform |
|-------|---------|----------|
| The Perfect Part eBay | TPP | eBay |
| Telitetech eBay | TT | eBay |
| BigCommerce | BC | BigCommerce |
| Shopify | SHPFY | Shopify |

---

## Profit Calculation

Per store-listing:

```
profit = salePrice
       - supplierCost
       - supplierShipping
       - shippingCost (from weight → shipping rate table)
       - (salePrice × platformFeeRate)   // 0 for BC/SHPFY in v1
       - (salePrice × adRate)            // 0 for BC/SHPFY in v1
```

- Default platform fee rate: 13.6%
- Editable per row, bulk-updatable
- BC and SHPFY platform fee = 0 in v1
- Ad rate for BC and SHPFY = N/A in v1
- Recalculate client-side instantly on staged edits

---

## Weight Format

User input format (preserved in UI and imports):

- `1` through `16` = ounces (e.g., `5` means 5oz)
- `2LBS` through `10LBS` = pounds (e.g., `2LBS` means 2 pounds)

Internally normalize to ounces for calculation, but preserve user-facing display format.
Shipping rate table keys use the same format.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router, TypeScript strict) |
| Database | PostgreSQL via Prisma |
| Auth | Auth.js v5 (email/password + magic link via Resend) |
| UI | shadcn/ui + Tailwind CSS |
| Data Grid | TanStack Table + TanStack Virtual |
| Client State | Zustand |
| Barcode | JsBarcode |
| Export | SheetJS (xlsx) |
| Backup Storage | Cloudflare R2 |
| Hosting | Vercel |
| Email | Resend |

---

## UI Conventions

- Dark mode is the default theme; light mode available via toggle
- Comfortable density by default; density toggle available
- Premium operational dashboard aesthetic — not a generic admin template
- Per-store values rendered as uniform, equal-size mini-blocks inside cells (not messy stacked text)
- Shared internal values (weight, supplier cost, etc.) rendered once at row level
- Frozen columns by default: UPC, Item IDs, SKU, Title
- Sticky search bar at top of main grid; user can hide/show
- Default sort: alphabetical by master-store title
- Default timezone: America/New_York (configurable in Settings)
- Use SVG icons (Lucide), never emojis as UI elements
- All clickable elements must have cursor-pointer
- Links to marketplace listings open in new tabs
- Modal close via X button and Esc key
- No layout-shifting hover effects

---

## Code Conventions

- TypeScript strict mode everywhere
- Prefer server components; use `"use client"` only when client interactivity is required
- API routes use Zod for request validation
- All database writes go through service functions (never raw Prisma calls in route handlers)
- Integration adapters implement a shared interface defined in `src/lib/integrations/types.ts`
- Error handling: catch, log with context, return typed error responses — never swallow errors silently
- Audit logging for all write operations, sync jobs, push attempts, and admin actions
- Retain logs for 10 days
- No `any` types unless absolutely unavoidable (and documented why)
- File naming: kebab-case for files, PascalCase for components, camelCase for utilities
- Imports use the `@/*` alias

---

## Environment Rules

- Three environments: local, staging (`stage.reorg.theperfectpart.net`), production (`reorg.theperfectpart.net`)
- Staging is write-protected by default
- Production launches with write locks easily controllable
- Environment-specific behavior controlled via `NEXT_PUBLIC_APP_ENV` (local | staging | production)
- Secrets are in environment variables; never committed to git
- `.env.example` documents all required variables without real values

---

## Roles

v1 users:
- Adam Zinker (Admin) — Adam@theperfectpart.net
- Cory Zinker (Admin) — Cory@theperfectpart.net

Admin can: manage integrations, tokens, write locks, staging/production settings, users, shipping rates, master store, imports, backups, push changes.

Architecture supports an Operator role later (can use table, edit, stage, push if permitted, search, view logs/errors) but it is not fully built in v1.

---

## Pages / Routes

```
/dashboard          Main data grid (primary screen)
/sync               Pull-only sync controls + status
/integrations       Integration management, write locks, tokens
/engine-room        Ops control center, logs, push queue, audit
/errors             Friendly error summaries + technical toggle
/unmatched          Unmatched external listings
/import             Import wizard
/shipping-rates     Shipping rate table editor
/backups            Backup management + download
/setup              Setup checklist (dynamic state)
/settings           User/app preferences, density, timezone, theme, write safety
```

---

## Documentation Requirements

The repo must contain complete documentation in `/docs/` including:
README, architecture brief, setup instructions, env checklist, API token guides,
Shopify token creation guide, GoDaddy DNS + Vercel + SSL guide, import template
instructions, shipping rate table guide, smoke test plan, dry-run plan, go-live
checklist, write safety checklist, backup/recovery docs, Cursor setup instructions.

All docs must be understandable by a non-engineer business owner.

---

## Design System

Generated and maintained via the UI/UX Pro Max skill at:
- `design-system/MASTER.md`
- `design-system/pages/*.md` (dashboard, engine-room, errors, backups, sync, settings, import, integrations)

The design system governs visual decisions only. It does not override any business logic,
data model, sync rules, write safety, or architectural decisions in this spec.
