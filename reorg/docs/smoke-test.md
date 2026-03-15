# Smoke Test Checklist

Use this checklist to verify reorG is working after setup or deployment. Run through each item and check it off.

---

## Login & Auth

- [ ] **Login page loads** — Navigate to the app URL and see the login screen
- [ ] **Email/password login works** — Sign in with a known admin account
- [ ] **Magic link login works** (if configured) — Request a magic link, receive email, click link and land in the app
- [ ] **Logout works** — Click logout and return to login screen
- [ ] **Session persists** — Refresh the page while logged in; you stay logged in

---

## Navigation

- [ ] **Sidebar visible** — Left sidebar shows all main sections
- [ ] **Dashboard link works** — Click Dashboard, main grid loads
- [ ] **Sync link works** — Sync page loads
- [ ] **Integrations link works** — Integrations page loads
- [ ] **Engine Room link works** — Engine Room page loads
- [ ] **Errors link works** — Errors page loads
- [ ] **Unmatched link works** — Unmatched External Listings page loads
- [ ] **Import link works** — Import page loads
- [ ] **Shipping Rates link works** — Shipping Rates page loads
- [ ] **Backups link works** — Backups page loads
- [ ] **Setup link works** — Setup checklist page loads
- [ ] **Settings link works** — Settings page loads

---

## Dashboard (Main Grid)

- [ ] **Dashboard loads** — No blank page or error
- [ ] **Grid renders** — Rows appear (or "No data" if empty)
- [ ] **Search works** — Type in search bar, results filter
- [ ] **Filters work** — Apply filters (store, status, etc.) and see filtered results
- [ ] **Sort works** — Click column headers, order changes
- [ ] **Frozen columns visible** — UPC, Item IDs, SKU, Title stay visible when scrolling
- [ ] **Links open in new tab** — Marketplace listing links open in a new browser tab

---

## Sync

- [ ] **Sync page loads** — No errors
- [ ] **Run sync** (if integrations connected) — Start a sync, see status update
- [ ] **Sync status shows** — Completed, failed, or in progress is visible
- [ ] **Errors surface** — If sync fails, errors are shown

---

## Integrations

- [ ] **Integrations page loads** — List of TPP, TT, BC, Shopify visible
- [ ] **Integration status shows** — Each shows enabled/disabled, last sync time
- [ ] **Write lock toggles visible** — Per-store write lock controls (Admin only)

---

## Settings

- [ ] **Settings page loads** — No errors
- [ ] **Theme toggle works** — Switch dark/light, theme changes
- [ ] **Density toggle works** — Change density, grid adjusts
- [ ] **Timezone setting works** — Change timezone, dates display in new zone
- [ ] **Write safety settings visible** — Global write lock and related options (Admin)

---

## Import

- [ ] **Import page loads** — Upload area visible
- [ ] **Download template works** — Template file downloads
- [ ] **Upload accepts file** — Select XLSX or CSV, upload processes (may show preview or message)

---

## Shipping Rates

- [ ] **Shipping Rates page loads** — Table of weight keys visible
- [ ] **Edit and save** — Change a cost, save, change persists

---

## Backups

- [ ] **Backups page loads** — Backup list or empty state visible
- [ ] **Manual backup** (if R2 configured) — Trigger backup, see confirmation or status

---

## Engine Room & Errors

- [ ] **Engine Room shows logs** — Recent activity visible
- [ ] **Errors page shows** — Friendly summaries or "No errors"
- [ ] **Technical toggle** (if present) — More detail is available when enabled

---

## Quick Pass / Minimal Test

If time is short, at least verify:

1. Login works
2. Dashboard loads
3. Sidebar navigates to Sync, Integrations, Settings
4. Theme toggle works
5. No console errors (F12 → Console) on main pages

---

## If Something Fails

- Check the browser console (F12 → Console) for errors
- Check the Network tab for failed API requests
- Verify `.env` and database are configured (see `docs/setup.md`)
- For staging/production, confirm environment variables in Vercel (or your host)
