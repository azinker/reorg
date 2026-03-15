# Go-Live Checklist

Use this checklist before taking reorG live in production. Completing each step helps ensure a smooth launch.

---

## Database & Data

- [ ] **Database migrated** — Run `npm run db:migrate:deploy` (or your production migration process) so all tables exist
- [ ] **Database seeded** (if fresh) — Admin users and integrations created
- [ ] **Admin passwords changed** — Default seed password `changeme-on-first-login` replaced for all admin accounts
- [ ] **Starter data imported** — At least a basic import done so the grid has data (or you’re okay with empty grid at launch)

---

## Integrations

- [ ] **All needed integrations connected** — TPP, TT, BigCommerce, Shopify — whatever you use
- [ ] **API tokens verified** — Each integration tested (e.g. run a sync)
- [ ] **First sync completed** — At least one successful sync per connected store
- [ ] **Write locks ON** — Global and per-store write locks enabled until you’re ready to push

---

## Shipping & Import

- [ ] **Shipping rates populated** — Cost entered for each weight tier you use
- [ ] **Import tested** — Download template, fill sample data, upload, confirm it works

---

## Write Safety

- [ ] **Global write lock ON** — `GLOBAL_WRITE_LOCK=true` or equivalent in production
- [ ] **Per-store write locks ON** — No store can push until you enable it
- [ ] **Dry-run tested** — Run a dry-run push and confirm output looks correct
- [ ] **Staging tested** — If using staging (`stage.reorg.theperfectpart.net`), confirm writes are blocked

See `docs/write-safety-checklist.md` for full details.

---

## DNS & SSL

- [ ] **Production domain configured** — `reorg.theperfectpart.net` added in Vercel (or your host)
- [ ] **Staging domain configured** — `stage.reorg.theperfectpart.net` if using staging
- [ ] **CNAME records set** — Both domains point to `cname.vercel-dns.com`
- [ ] **SSL verified** — Domains show as Valid in Vercel, HTTPS works

See `docs/dns-vercel-ssl.md` for setup.

---

## Environment Variables

- [ ] **Production `.env` / Vercel env vars set** — All required variables configured
- [ ] **`NEXT_PUBLIC_APP_ENV=production`** — Correct environment
- [ ] **`AUTH_URL`** — Points to production URL (e.g. `https://reorg.theperfectpart.net`)
- [ ] **No secrets in client code** — Only `NEXT_PUBLIC_*` vars exposed to the browser

See `docs/env-checklist.md` for the full list.

---

## Backup Readiness

- [ ] **R2 (or backup storage) configured** — `R2_*` variables set for production
- [ ] **Manual backup works** — Trigger a backup and confirm it completes
- [ ] **Download works** — You can download a backup file from the Backups page

See `docs/backup-recovery.md` for more.

---

## User Access

- [ ] **Admin accounts created** — Adam, Cory, or others as needed
- [ ] **Passwords changed** — No default passwords left
- [ ] **Roles correct** — Admin vs Operator as intended

---

## Final Checks

- [ ] **Smoke test passed** — Run through `docs/smoke-test.md`
- [ ] **No critical errors** — Errors page clean or only known non-blocking issues
- [ ] **Staging tested** — If using staging, full workflow tested there first

---

## Launch Day

1. Confirm all items above
2. Enable write locks only when ready to push
3. Monitor Engine Room and Errors for the first few hours
4. Keep a backup from just before first real push
