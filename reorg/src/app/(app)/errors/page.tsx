export default function ErrorsPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Errors</h1>
        <p className="text-sm text-muted-foreground">
          Friendly error summaries with technical details available
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 6 — plain-English error display with technical detail toggle</p>
      </div>
    </div>
  );
}
