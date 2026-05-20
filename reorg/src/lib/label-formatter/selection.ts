export function selectRowsForLabelFormatterExport<T extends { id: string }>(
  rows: T[],
  selectedIds: Set<string>,
  mode: "all" | "selected",
): T[] {
  return mode === "selected" ? rows.filter((row) => selectedIds.has(row.id)) : rows;
}
