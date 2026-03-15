export default function SetupPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Setup Checklist</h1>
        <p className="text-sm text-muted-foreground">
          Guided onboarding and system health checklist
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 7 — dynamic checklist reflecting current system state</p>
      </div>
    </div>
  );
}
