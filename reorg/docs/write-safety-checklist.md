# Write Safety Checklist

reorG is built so marketplace changes only happen when you explicitly approve them. Use this checklist to confirm write safety is configured correctly.

---

## Global Write Lock

- [ ] **Global write lock is ON** — `GLOBAL_WRITE_LOCK=true` in `.env` (or equivalent app setting)
- [ ] **When ON** — No push to any marketplace can execute, even if per-store locks are off
- [ ] **Toggle visible** — Admins can see and change the global lock in Settings/Integrations

---

## Per-Store Write Locks

- [ ] **Per-store locks default to ON** — Each integration (TPP, TT, BC, Shopify) starts with writes blocked
- [ ] **Locks visible** — Each store has its own write-lock toggle in the Integrations UI
- [ ] **Only enabled when intended** — Turn a store’s lock off only when you’re ready to push to that store

---

## Staging Environment

- [ ] **Staging is write-protected** — When `NEXT_PUBLIC_APP_ENV=staging`, writes to marketplaces are blocked by default
- [ ] **Override only for testing** — Staging write enablement (if any) is admin-only and clearly marked
- [ ] **Production separate** — Production uses `NEXT_PUBLIC_APP_ENV=production` and its own lock settings

---

## Dry-Run Flow

- [ ] **Dry-run works** — You can run a push in dry-run mode
- [ ] **Dry-run shows details** — You see what would change (store, listing, field, old value, new value)
- [ ] **No writes in dry-run** — Dry-run never writes to any marketplace
- [ ] **Confirmation required for live push** — A real push only runs after you confirm the dry-run results

---

## Push Confirmation

- [ ] **Confirmation step exists** — Before a live push, you must explicitly confirm
- [ ] **All changes listed** — The confirmation shows every change that will be sent
- [ ] **Clear platform and listing** — Each change is tied to a specific store and listing

---

## No Delete Functionality

- [ ] **No delete listings** — There is no UI, API, or code path that deletes marketplace listings
- [ ] **No delete buttons** — No “Delete listing” or similar in the app
- [ ] **SDK delete not used** — Even if the platform SDK supports delete, reorG does not call it

---

## Sync Is Pull-Only

- [ ] **Sync never pushes** — Manual and scheduled sync only pull data from marketplaces
- [ ] **Sync updates live values** — Sync updates `MarketplaceListing` (live data) only
- [ ] **Sync never touches staged values** — `StagedChange` records are never overwritten by sync

---

## Staged Values Survive Sync

- [ ] **Staged value persists** — If you stage a price change, run sync, then the staged value is still there
- [ ] **Live value updates under staged** — Sync updates the live value; the staged value stays until you push or cancel
- [ ] **Staged vs live visible** — The UI clearly shows staged value vs live value

---

## Audit Trail

- [ ] **Push operations logged** — Each push creates an audit record (e.g. in Engine Room / audit log)
- [ ] **Who, what, when** — Logs include user, action, affected entities, and timestamp
- [ ] **Logs retained** — Audit data is kept (e.g. 10 days per AGENTS.md)

---

## Quick Verification

1. Set `GLOBAL_WRITE_LOCK=true`
2. Turn off all per-store write locks (or leave them on)
3. Run a dry-run push — it should show planned changes and not execute
4. Run a sync — confirm it updates data but does not push
5. Stage a change, run sync — confirm the staged value is still present

If all of the above behave as expected, write safety is correctly configured.
