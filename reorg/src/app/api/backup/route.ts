import { NextResponse } from "next/server";

export async function GET() {
  // TODO: Wire to real DB + R2 when connected
  // Returns list of backup records from the Backup table

  return NextResponse.json({
    data: {
      backups: [],
      message: "Connect a database and Cloudflare R2 to manage backups.",
    },
  });
}

export async function POST() {
  // TODO: Wire to real backup service when DB + R2 are connected
  // Backup service will:
  // 1. Snapshot internal reorG state (MasterRows, MarketplaceListings, StagedChanges)
  // 2. Generate per-store marketplace export files
  // 3. Generate companion CSV/XLSX
  // 4. Upload to Cloudflare R2
  // 5. Create Backup record with 30-day expiry
  // 6. Return download URLs

  return NextResponse.json({
    data: {
      backupId: `mock-backup-${Date.now()}`,
      status: "pending",
      message: "Connect a database and Cloudflare R2 to run real backups.",
    },
  });
}
