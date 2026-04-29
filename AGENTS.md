# reorG - Project Agent Instructions

## Identity

**reorG** by The Perfect Part — an internal marketplace operations application.
Production domain: `reorg.theperfectpart.net`

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
9. **NEVER** delete a Help Desk message, ticket, note, or audit log row. Hide via `isArchived` / `isSpam` / `isDeleted` only — all reversible.
10. **NEVER** dispatch a Help Desk outbound message (eBay or Resend) outside the `HelpdeskOutboundJob` worker, and never bypass `HELPDESK_SAFE_MODE` or the per-transport feature flag.
11. **NEVER** initiate an unsolicited eBay buyer message in v1. Only RTQ replies inside an existing buyer thread are allowed; `AddMemberMessageAAQToPartner` is reserved for explicit future approval.
12. **NEVER** let the Help Desk eBay sync worker call any write/send eBay method. Sync is `GetMyMessages`-only.

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

- Two environments: local, production (`reorg.theperfectpart.net`)
- Production launches with write locks easily controllable
- Environment-specific behavior controlled via `NEXT_PUBLIC_APP_ENV` (local | production)
- Secrets are in environment variables; never committed to git
- `.env.example` documents all required variables without real values

### Database Environments

Two Neon projects — read the hostname, not the filename, to tell them apart:

| Env      | Neon host                                          | Use for                                               |
|----------|----------------------------------------------------|-------------------------------------------------------|
| **Prod** | `ep-little-fire-ana4fmmh.c-6.us-east-1.aws.neon.tech` (the one with **"little"** in its name) | All production reads, backfills, and inspections. `reorg/.env.prod` points here. |
| Staging  | `ep-calm-cell-an2czh87.c-6.us-east-1.aws.neon.tech`    | Local dev only. `reorg/.env` defaults here.           |

**Non-negotiable:** any one-off script, inspect, or backfill that targets
"the real data the user sees in prod" must set `DATABASE_URL` to the
`little-fire` pooler URL. Before running, echo the resolved host and
refuse to proceed if it doesn't contain `little-fire`. See
`scripts/_inspect-ticket-14-14511.ts` and
`scripts/_backfill-outbound-attribution.ts` for the pattern.

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
/dashboard          Signed-in home dashboard (safe user/team operations metrics)
/catalog            Main data grid (permission-controlled catalog screen)
/sync               Pull-only sync controls + status
/integrations       Integration management, write locks, tokens
/engine-room        Ops control center, logs, push queue, audit
/errors             Friendly error summaries + technical toggle
/unmatched          Unmatched external listings
/import             Import wizard
/shipping-rates     Shipping rate table editor
/backups            Backup management + download
/settings           User/app preferences, density, timezone, theme, write safety
/help-desk          eBay buyer-message inbox (3-pane: folders / thread list / context)
/help-desk/dashboard Help Desk operational metrics (Admin / Team Lead)
```

---

## Help Desk

The Help Desk is an in-app inbox for eBay buyer messages. v1 scope is
**eBay only** (TPP + TT, with TT read-only) plus an "External" composer
mode that sends email via Resend. Anything not covered here is out of v1.

### Architecture

- **Sync (read-only)**: `lib/services/helpdesk-ebay.ts` (Trading API client)
  + `lib/services/helpdesk-ebay-sync.ts` (2-stage poll: fast tick for
  active threads, slow tick for backfill). Cron entry at
  `/api/cron/helpdesk-poll`.
- **Outbound (write)**: `lib/services/helpdesk-outbound.ts` worker
  drains `HelpdeskOutboundJob` rows. Two transports:
    1. `sendHelpdeskReply()` → eBay `AddMemberMessageRTQ` (reply only —
       no unsolicited AAQToPartner in v1).
    2. `sendExternalEmail()` → Resend (uses `HELPDESK_RESEND_FROM` →
       falls back to `RESEND_FROM`).
- **API**: under `/api/helpdesk/**` (tickets, messages, notes, tags,
  templates, dashboard, sync status). All routes auth-gated via Auth.js.
- **UI**: `/help-desk` is a 3-pane shell — folder sidebar + ticket list +
  thread/context. State managed in `hooks/use-helpdesk.ts`.
- **Settings**: per-user prefs (send delay, auto-advance, density) live
  client-side in `localStorage` in v1, surfaced via
  `components/helpdesk/HelpdeskSettingsDialog.tsx`.

### Feature Flags (all default safe)

| Flag                           | Default | Effect                                                      |
|--------------------------------|---------|-------------------------------------------------------------|
| `HELPDESK_SAFE_MODE`           | `true`  | Blocks every outbound transport (eBay + Resend).            |
| `HELPDESK_ENABLE_EBAY_SEND`    | `false` | Allows RTQ replies (only when safe mode is also off).       |
| `HELPDESK_ENABLE_RESEND_EXTERNAL` | `false` | Allows External composer mode.                            |
| `HELPDESK_ENABLE_ATTACHMENTS`  | `false` | Allows outbound attachments (External mode only).           |

Production go-live order: keep `SAFE_MODE=true` while sync & UI bake,
then flip safe mode off and enable transports one at a time.

### Non-Negotiables

See `.cursor/rules/helpdesk-safety.mdc` for the full list. Highlights:

- No deletion. Hide via `isArchived` / `isSpam` / soft-delete on notes.
- All sends go through the `HelpdeskOutboundJob` worker. No direct
  `sendHelpdeskReply()` from a route handler.
- `safeMode` is checked inside the worker, and a blocked send writes a
  `HelpdeskAuditLog` row of action `OUTBOUND_BLOCKED`.
- Sync is pull-only. The sync worker may not call any eBay write method.
- Sync never overwrites agent-authored fields (notes, tags, assignments,
  status set by an agent, `snoozedUntil`, manual `kind`).
- 180-day backfill cap; idempotent on `(ebayMessageId)`.
- Templates: shared vs personal; agents can only edit their own.
- SLA buckets are computed against business-hours
  (Mon–Fri 09:00–17:00, default America/New_York). See
  `lib/helpdesk/sla.ts`.

### Tests

Pure helpers in `reorg/src/lib/helpdesk/*.ts` have unit tests under the
same folder. Run with `npm test` (Node's built-in test runner via `tsx
--test`). New helpers must ship with tests in the same folder.

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
