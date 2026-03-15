# Backups Page Design

> Overrides MASTER.md for the Backups disaster recovery page.

## Purpose

Disaster recovery and operational safety. Not a casual export page.
Daily automated + manual backup management with download capability.

## Layout

- Top action bar: "Run Backup Now" button (prominent), retention policy info
- Backup list table: date, type, stores included, size, status, retention countdown, actions
- Download buttons per backup (individual store files or combined ZIP)

## Visual Treatment

- Status badges: Completed (green), In Progress (blue animated), Failed (red), Expiring Soon (amber)
- Retention countdown: "Expires in 12 days" with amber highlight when < 7 days
- Type badges: Daily (automatic), Manual, Pre-Push
- File size formatted human-readable (e.g., "2.4 MB")
