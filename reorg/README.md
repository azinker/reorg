# reorG

**Internal marketplace operations platform by The Perfect Part.**

Aggregate, compare, simulate, stage, and selectively push listing data across connected marketplaces (eBay, BigCommerce, Shopify).

---

## Quick Start

### Prerequisites

- Node.js 20+ (v24 recommended)
- PostgreSQL database (local, Neon, or Supabase)
- npm

### Setup

```bash
# 1. Clone and install
cd reorg
npm install

# 2. Copy environment template
cp .env.example .env
# Edit .env with your database URL and secrets

# 3. Generate Prisma client
npx prisma generate

# 4. Run database migrations
npx prisma migrate dev

# 5. Seed the database (admin users, integrations, shipping rates)
npx tsx prisma/seed.ts

# 6. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Default Login

After seeding, two admin accounts exist:
- adam@theperfectpart.net
- coryzz@live.com

Default password: `changeme-on-first-login` (change immediately).

### Auto Pull Acceleration

`reorG` supports secure webhook intake for Shopify and BigCommerce so those stores can wake up a pull-only refresh earlier than the long fallback schedule. Shopify uses signed webhooks. BigCommerce uses a shared secret header you provide when registering the webhook.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Database | PostgreSQL + Prisma 6 |
| Auth | Auth.js v5 (credentials) |
| UI | shadcn/ui + Tailwind CSS v4 |
| Data Grid | TanStack Table + TanStack Virtual |
| State | Zustand |
| Email | Resend |
| Backups | Cloudflare R2 |
| Hosting | Vercel |

---

## Project Structure

```
reorg/
  prisma/           Schema, migrations, seed
  src/
    app/            Next.js App Router pages and API routes
      (app)/        Authenticated app pages (dashboard, sync, etc.)
      api/          API route handlers
      login/        Public login page
    components/     React components
      layout/       Sidebar, top bar, app shell
      providers/    Theme provider
    lib/            Core libraries
      integrations/ Marketplace adapter interfaces and implementations
      services/     Business logic (sync, push, calculation, backup)
    stores/         Zustand client state stores
  docs/             Documentation
  templates/        Import template files
```

---

## Environments

| Environment | Domain | Write Access |
|-------------|--------|-------------|
| Local | localhost:3000 | Configurable |
| Production | reorg.theperfectpart.net | Controlled via write locks |

---

## Safety Rules

1. No marketplace listing deletion — anywhere, ever
2. No pushes without explicit user confirmation
3. Sync is pull-only
4. Sync never overwrites staged values
5. Staging environment is write-protected by default
6. Global + per-store write locks
7. Dry-run mode before any live push

See [AGENTS.md](../AGENTS.md) for complete safety specification.

---

## Documentation

Full documentation lives in `docs/`:
- Setup instructions
- Environment variable checklist
- API token setup guides
- DNS/Vercel/SSL configuration
- Import guide
- Go-live checklist
- And more (generated during build phases)
