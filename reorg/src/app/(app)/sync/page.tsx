export default function SyncPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Sync</h1>
        <p className="text-sm text-muted-foreground">
          Pull-only sync controls — fetch latest data from connected marketplaces
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 2 — sync controls and status per integration</p>
      </div>
    </div>
  );
}
