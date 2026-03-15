export default function ShippingRatesPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Shipping Rate Table</h1>
        <p className="text-sm text-muted-foreground">
          Weight-to-cost lookup table for internal shipping cost calculations
        </p>
      </div>
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border">
        <p className="text-sm text-muted-foreground">Phase 5 — editable rate table (1oz–16oz, 2LBS–10LBS)</p>
      </div>
    </div>
  );
}
