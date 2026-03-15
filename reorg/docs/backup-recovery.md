# Backup & Recovery

reorG automatically backs up your data and stores it in the cloud. This guide explains how backups work and how to use them.

---

## How Backups Work

### When Backups Run

1. **Daily automated** — A scheduled job creates a backup once per day
2. **Manual trigger** — You can start a backup anytime from the Backups page
3. **Pre-bulk-push automatic** — Before a bulk push (e.g. more than 10 items), reorG runs a backup automatically

### Where Backups Are Stored

Backups are stored in **Cloudflare R2**. Each backup is kept for **30 days**, then automatically removed.

### What’s Included

A backup includes:

- **Marketplace data** — Live listing data (prices, inventory, titles, etc.) from each connected store
- **Internal data** — Master rows: SKU, weight, supplier cost, supplier shipping, notes
- **Staged values** — Pending changes you haven’t pushed yet
- **Variation structure** — Parent/child relationships for variation listings

This gives you a full snapshot of reorG’s state at backup time.

---

## v1: Download Only (No Auto-Restore)

In v1:

- **Backups are for export and download**
- **There is no automated restore into marketplaces**
- You can download backup files and use them for records or manual recovery
- Future versions may add restore features; the design allows for it, but v1 does not perform restore

---

## How to Use Backups

### Manual Backup

1. Go to **Backups** in the sidebar
2. Click **Create Backup** (or **Run Backup**)
3. Wait for the job to finish
4. The new backup appears in the list with date, type, and size

### Download a Backup

1. Go to **Backups**
2. Find the backup you want
3. Click **Download**
4. Save the file locally (e.g. to a secure folder or drive)

### Before a Big Push

If you’re about to push many changes, run a manual backup first (or rely on the pre-bulk-push automatic backup). That way you have a recent snapshot if something goes wrong.

---

## Backup Types

| Type | When It Runs |
|------|--------------|
| **Daily** | Scheduled daily job |
| **Manual** | You trigger it from the Backups page |
| **Pre-push** | Automatically before a bulk push (e.g. >10 items) |

---

## Requirements

Backups need **Cloudflare R2** configured:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT`

See `docs/env-checklist.md` for details.

---

## Best Practices

- Run a **manual backup** before major changes or bulk pushes
- **Download** important backups and keep them in a safe location
- **Check the Backups page** periodically to confirm daily backups are running
- Use backups for **audit** and **recovery planning** — in v1, restore is manual only
