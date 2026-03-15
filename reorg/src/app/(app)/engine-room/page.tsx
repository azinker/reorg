export default function EngineRoomPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Engine Room</h1>
        <p className="text-sm text-muted-foreground">
          Operations control center — sync jobs, push queue, audit trail
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 6 — ops dashboard with logs, change history, and push tracking</p>
      </div>
    </div>
  );
}
