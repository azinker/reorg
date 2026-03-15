export default function UnmatchedPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Unmatched External Listings</h1>
        <p className="text-sm text-muted-foreground">
          External listings with no matching master-store SKU
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 7 — unmatched listing table with store indicators</p>
      </div>
    </div>
  );
}
