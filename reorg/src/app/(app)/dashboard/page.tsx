export default function DashboardPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Main operational grid — master-store-first view of all SKUs
        </p>
      </div>
      <div className="flex h-[calc(100vh-12rem)] items-center justify-center rounded-lg border border-dashed border-border">
        <div className="text-center">
          <p className="text-lg font-medium text-muted-foreground">
            Data Grid
          </p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Phase 3 — virtualized table with store mini-blocks
          </p>
        </div>
      </div>
    </div>
  );
}
