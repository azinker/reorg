# Smoke Test Checklist

Use this checklist to verify reorG is working after setup or deployment. Run through each item and check it off.

---

## Login & Auth

- [ ] **Login page loads** - Navigate to the app URL and see the login screen
- [ ] **Email/password login works** - Sign in with a known admin account
- [ ] **Logout works** - Click Log out and return to login screen
- [ ] **Session persists** - Refresh the page while logged in; you stay logged in

---

## Navigation

- [ ] **Sidebar visible** - Left sidebar shows all main sections
- [ ] **Dashboard link works** - Click Dashboard and confirm the main grid loads
- [ ] **Inventory Forecaster link works** - Inventory Forecaster page loads
- [ ] **Sync link works** - Sync page loads
- [ ] **Integrations link works** - Integrations page loads
- [ ] **Engine Room link works** - Engine Room page loads
- [ ] **Errors link works** - Errors page loads
- [ ] **Unmatched link works** - Unmatched External Listings page loads
- [ ] **Import link works** - Import page loads
- [ ] **Shipping Rates link works** - Shipping Rates page loads
- [ ] **Backups link works** - Backups page loads
- [ ] **Setup link works** - Setup checklist page loads
- [ ] **Settings link works** - Settings page loads

---

## Dashboard (Main Grid)

- [ ] **Dashboard loads** - No blank page or error
- [ ] **Grid renders** - Rows appear, or the expected empty state shows
- [ ] **Search works** - Type in the search bar and confirm results filter
- [ ] **Filters work** - Apply filters and confirm results change
- [ ] **Sort works** - Click column headers and confirm order changes
- [ ] **Frozen columns visible** - UPC, Item IDs, SKU, and Title stay visible when scrolling
- [ ] **Links open in new tab** - Marketplace listing links open in a new browser tab
- [ ] **Store health banner reads clearly** - If automation is delayed, the banner explains what happened and what to do next

---

## Sync

- [ ] **Sync page loads** - No errors
- [ ] **Run sync** (if integrations connected) - Start a sync and confirm status updates
- [ ] **Sync status shows** - Completed, failed, or in-progress status is visible
- [ ] **Automation health reads clearly** - Healthy, Running behind, or Attention needed includes a next step
- [ ] **Errors surface** - If sync fails, the issue appears clearly

---

## Inventory Forecaster

- [ ] **Inventory Forecaster page loads** - No blank page or server error
- [ ] **Run Forecast works** - Forecast completes and results render
- [ ] **Sales coverage shows** - Coverage dates appear in the summary card
- [ ] **Warnings are readable** - Missing credentials or partial history appear as notes, not silent failures
- [ ] **Save Run works** - Forecast run saves successfully
- [ ] **Create Order works** - Internal supplier order draft is created
- [ ] **Supplier order editing works** - Status and ETA can be updated
- [ ] **Export Excel works** - Workbook downloads successfully
- [ ] **Forecast stays read-only for marketplaces** - No marketplace write or push action occurs

---

## Integrations

- [ ] **Integrations page loads** - TPP, TT, BigCommerce, and Shopify are visible
- [ ] **Integration status shows** - Each integration shows enabled or disabled plus last sync time
- [ ] **Write lock toggles visible** - Per-store write lock controls are visible for Admin users

---

## Settings

- [ ] **Settings page loads** - No errors
- [ ] **Theme toggle works** - Switch dark or light and confirm the theme changes
- [ ] **Density toggle works** - Change density and confirm the grid adjusts
- [ ] **Timezone setting works** - Change timezone and confirm dates display in the new zone
- [ ] **Write safety settings visible** - Global write lock and related options are visible for Admin users

---

## Import

- [ ] **Import page loads** - Upload area visible
- [ ] **Download template works** - Template file downloads
- [ ] **Upload accepts file** - Select XLSX or CSV and confirm upload processes

---

## Shipping Rates

- [ ] **Shipping Rates page loads** - Table of weight keys is visible
- [ ] **Edit and save** - Change a cost, save, and confirm the change persists

---

## Backups

- [ ] **Backups page loads** - Backup list or empty state visible
- [ ] **Manual backup** (if R2 configured) - Trigger backup and confirm status or success message

---

## Engine Room & Errors

- [ ] **Engine Room shows logs** - Recent activity is visible
- [ ] **Errors page shows** - Friendly summaries or "No errors" are visible
- [ ] **Technical details expand** - Technical details are available when needed
- [ ] **Automation problems explain the next step** - Delayed or missing-webhook issues include plain-English recovery guidance

---

## Quick Pass / Minimal Test

If time is short, at least verify:

1. Login works
2. Dashboard loads
3. Sidebar navigates to Sync, Integrations, and Settings
4. Theme toggle works
5. No console errors (`F12 -> Console`) on the main pages

---

## If Something Fails

- Check the browser console (`F12 -> Console`) for errors
- Check the Network tab for failed API requests
- Verify `.env` and database are configured (see `docs/setup.md`)
- For staging or production, confirm environment variables in Vercel
- For Shopify or BigCommerce webhook issues, confirm destination URL, signing secret, and recent delivery attempts
