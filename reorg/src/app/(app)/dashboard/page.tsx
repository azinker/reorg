"use client";

import { DataGrid } from "@/components/grid/data-grid";
import { MOCK_ROWS } from "@/lib/mock-data";

export default function DashboardPage() {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <DataGrid rows={MOCK_ROWS} />
    </div>
  );
}
