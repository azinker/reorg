# reorG Architecture Overview

A brief technical overview of reorG for business owners and developers.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router, TypeScript) |
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

## Data Model Summary

### Core Tables

- **MasterRow** — One row per SKU group. Holds shared internal data: SKU, title, weight, supplier cost, supplier shipping, notes, UPC. Row identity is driven by master-store SKU.

- **MarketplaceListing** — One record per listing on a marketplace. Links to a MasterRow via SKU match. Holds live marketplace data: sale price, inventory, ad rate, platform item ID. Sync updates these; staged edits do not.

- **StagedChange** — Pending edits. When you change a value (e.g. price) before pushing, it’s stored here. Staged values persist until you push or cancel. Sync never overwrites StagedChange.

### Row Identity

- One main row = one master-store SKU group
- Master store = TPP eBay (configurable)
- Other stores attach via exact SKU match only — no fuzzy matching
- Unmatched external listings go to the Unmatched Listings page

---

## Sync Flow

1. User or schedule triggers sync for a store
2. reorG **pulls** listings from the marketplace API (never pushes)
3. SKU matching links listings to MasterRows
4. Matched listings update **MarketplaceListing** (live values)
5. Unmatched listings go to **UnmatchedListing**
6. **StagedChange** is never modified by sync

---

## Push Flow

1. User stages changes (e.g. price, ad rate)
2. User initiates push
3. Write safety checks: global lock, per-store lock, environment (staging blocked by default)
4. Dry-run: show what would change, no writes
5. User confirms
6. Execute push to marketplace APIs
7. Audit log created
8. Auto-backup before bulk pushes
9. Targeted sync refreshes affected listings

---

## Folder Structure

```
reorg/
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── seed.ts          # Seed script
├── src/
│   ├── app/             # Next.js App Router (pages, API routes)
│   │   ├── api/         # API routes (auth, sync, import, etc.)
│   │   └── (auth)/      # Auth pages
│   └── lib/             # Shared logic
│       ├── integrations/  # eBay, BigCommerce, Shopify adapters
│       ├── services/       # Sync, push, matching, calculation
│       ├── auth.ts        # Auth config
│       ├── db.ts          # Prisma client
│       ├── safety.ts      # Write safety checks
│       └── env.ts         # Env validation
├── docs/                # Documentation
├── .env.example         # Env template
└── package.json
```

---

## Safety Principles

- **No deletion** — reorG never deletes marketplace listings
- **Pull-only sync** — Sync never writes to marketplaces
- **Explicit push** — All marketplace writes require user confirmation
- **Staged value protection** — Sync never overwrites StagedChange
- **Write locks** — Global and per-store locks block writes until enabled
