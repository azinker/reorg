"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileSpreadsheet,
  Loader2,
  PackageCheck,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LABEL_FORMATTER_ZIP_FILENAME,
  sourceStoreLabel,
  type LabelFormatterLineItem,
  type LabelFormatterRow,
  type LabelFormatterSourceStore,
} from "@/lib/label-formatter/types";

type WorkingRow = LabelFormatterRow & {
  id: string;
  createdAt: string;
  updatedAt?: string;
};

type LookupResponse =
  | { status: "found"; order: LabelFormatterRow }
  | { status: "conflict"; matches: LabelFormatterRow[] }
  | { status: "not_found"; errors: Array<{ store: string; message: string }> };

type HistoryRow = {
  id: string;
  createdAt: string;
  createdBy: { name: string | null; email: string | null } | null;
  rowCount: number;
  orderNumbers: unknown;
  sourceStores: unknown;
  excelFileName: string;
  pdfFileName: string;
  zipFileName: string | null;
};

const WORKING_ROWS_STORAGE_KEY = "reorg.labelFormatter.workingRows.v1";

const EMPTY_MANUAL_ROW: LabelFormatterRow = {
  note: "",
  orderNumber: "",
  sourceStore: "MANUAL",
  buyerName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zipCode: "",
  lineItems: [{ sku: "", quantity: 1 }],
};

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isSourceStore(value: unknown): value is LabelFormatterSourceStore {
  return value === "EBAY_TPP" || value === "EBAY_TT" || value === "BIGCOMMERCE" || value === "SHOPIFY" || value === "MANUAL";
}

function normalizeStoredLineItems(value: unknown): LabelFormatterLineItem[] {
  if (!Array.isArray(value)) return [{ sku: "", quantity: 1 }];

  const lineItems = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sku = stringValue(item.sku);
    const quantity = Number(item.quantity);
    return [{
      sku,
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    }];
  });

  return lineItems.length > 0 ? lineItems : [{ sku: "", quantity: 1 }];
}

function normalizeStoredRows(value: unknown): WorkingRow[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item)) return [];

    const orderNumber = stringValue(item.orderNumber);
    if (!orderNumber.trim()) return [];

    return [{
      id: stringValue(item.id) || makeId(),
      note: stringValue(item.note),
      orderNumber,
      sourceStore: isSourceStore(item.sourceStore) ? item.sourceStore : "MANUAL",
      buyerName: stringValue(item.buyerName),
      addressLine1: stringValue(item.addressLine1),
      addressLine2: stringValue(item.addressLine2),
      city: stringValue(item.city),
      state: stringValue(item.state),
      zipCode: stringValue(item.zipCode),
      lineItems: normalizeStoredLineItems(item.lineItems),
      createdAt: stringValue(item.createdAt) || new Date().toISOString(),
      updatedAt: stringValue(item.updatedAt) || undefined,
    }];
  });
}

function toWorkingRow(row: LabelFormatterRow, note: string): WorkingRow {
  return {
    ...row,
    id: makeId(),
    note,
    addressLine2: row.addressLine2 ?? "",
    lineItems: row.lineItems.length > 0 ? row.lineItems : [{ sku: "", quantity: 1 }],
    createdAt: new Date().toISOString(),
  };
}

function skuSummary(items: LabelFormatterLineItem[]) {
  if (items.length === 0) return "No SKU data available";
  return items.map((item) => `${item.sku || "SKU"} x ${item.quantity || 1}`).join(", ");
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function sourceStoreList(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.map((entry) => isSourceStore(entry) ? sourceStoreLabel(entry) : String(entry)).join(", ");
}

function validateManualRow(row: LabelFormatterRow) {
  if (!row.orderNumber.trim()) return "Order number is required.";
  if (!row.buyerName.trim()) return "Buyer name is required.";
  if (!row.addressLine1.trim()) return "Address line 1 is required.";
  if (!row.city.trim()) return "City is required.";
  if (!row.state.trim()) return "State is required.";
  if (!row.zipCode.trim()) return "Zip code is required.";
  if (row.lineItems.length === 0 || row.lineItems.some((line) => !line.sku.trim() || !Number.isInteger(line.quantity) || line.quantity < 1)) {
    return "Add at least one SKU with a positive quantity.";
  }
  return null;
}

export function LabelFormatterClient() {
  const [orderNumber, setOrderNumber] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<WorkingRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lookupLoading, setLookupLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState<"all" | "selected" | null>(null);
  const [banner, setBanner] = useState<{ type: "success" | "error" | "warning"; message: string } | null>(null);
  const [duplicatePending, setDuplicatePending] = useState<WorkingRow | null>(null);
  const [conflictPending, setConflictPending] = useState<LabelFormatterRow[] | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<LabelFormatterRow>(EMPTY_MANUAL_ROW);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [workingRowsHydrated, setWorkingRowsHydrated] = useState(false);

  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds]);
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  useEffect(() => {
    try {
      const storedRows = window.localStorage.getItem(WORKING_ROWS_STORAGE_KEY);
      if (storedRows) setRows(normalizeStoredRows(JSON.parse(storedRows)));
    } catch {
      window.localStorage.removeItem(WORKING_ROWS_STORAGE_KEY);
    } finally {
      setWorkingRowsHydrated(true);
    }

    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!workingRowsHydrated) return;
    window.localStorage.setItem(WORKING_ROWS_STORAGE_KEY, JSON.stringify(rows));
  }, [rows, workingRowsHydrated]);

  useEffect(() => {
    setSelectedIds((current) => {
      const activeIds = new Set(rows.map((row) => row.id));
      const next = new Set([...current].filter((id) => activeIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/label-formatter/history?limit=20", { cache: "no-store" });
      const json = (await res.json()) as { data?: HistoryRow[] };
      if (res.ok && json.data) setHistory(json.data);
    } catch {
      // History is secondary to the working export flow.
    }
  }

  function addRow(row: WorkingRow, forceDuplicate = false) {
    const duplicate = rows.some((existing) => existing.orderNumber.trim() === row.orderNumber.trim());
    if (duplicate && !forceDuplicate) {
      setDuplicatePending(row);
      return;
    }
    setRows((current) => [...current, row]);
    setBanner({ type: "success", message: `Added ${row.orderNumber}.` });
    setOrderNumber("");
    setNote("");
  }

  async function handleLookupSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = orderNumber.trim();
    if (!trimmed || lookupLoading) return;

    setLookupLoading(true);
    setBanner(null);
    try {
      const res = await fetch("/api/label-formatter/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber: trimmed }),
      });
      const json = (await res.json()) as { data?: LookupResponse; error?: string };
      if (!res.ok || !json.data) {
        setBanner({ type: "error", message: json.error ?? "Lookup failed. You can add the row manually." });
        setManualDraft({ ...EMPTY_MANUAL_ROW, note, orderNumber: trimmed });
        return;
      }

      if (json.data.status === "found") {
        addRow(toWorkingRow(json.data.order, note));
      } else if (json.data.status === "conflict") {
        setConflictPending(json.data.matches);
      } else {
        setBanner({ type: "warning", message: "No matching connected store order found. You can add it manually." });
        setManualDraft({ ...EMPTY_MANUAL_ROW, note, orderNumber: trimmed });
      }
    } catch {
      setBanner({ type: "error", message: "Network error during lookup. You can add the row manually." });
      setManualDraft({ ...EMPTY_MANUAL_ROW, note, orderNumber: trimmed });
    } finally {
      setLookupLoading(false);
    }
  }

  function updateRow(id: string, patch: Partial<WorkingRow>) {
    setRows((current) =>
      current.map((row) =>
        row.id === id ? { ...row, ...patch, updatedAt: new Date().toISOString() } : row,
      ),
    );
  }

  function updateLineItem(rowId: string, index: number, patch: Partial<LabelFormatterLineItem>) {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== rowId) return row;
        const lineItems = row.lineItems.map((line, lineIndex) =>
          lineIndex === index ? { ...line, ...patch } : line,
        );
        return { ...row, lineItems, updatedAt: new Date().toISOString() };
      }),
    );
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function removeSelectedRows() {
    if (selectedIds.size === 0) return;
    setRows((current) => current.filter((row) => !selectedIds.has(row.id)));
    setSelectedIds(new Set());
    setBanner({
      type: "success",
      message: `Deleted ${selectedIds.size} selected row${selectedIds.size === 1 ? "" : "s"}.`,
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllSelected() {
    setSelectedIds((current) => {
      if (rows.length > 0 && rows.every((row) => current.has(row.id))) return new Set();
      return new Set(rows.map((row) => row.id));
    });
  }

  async function exportRows(mode: "all" | "selected") {
    const exportSet = mode === "selected" ? selectedRows : rows;
    if (exportSet.length === 0) return;

    setExportLoading(mode);
    setBanner(null);
    try {
      const res = await fetch("/api/label-formatter/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, rows: exportSet }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setBanner({ type: "error", message: json.error ?? "Export failed." });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = LABEL_FORMATTER_ZIP_FILENAME;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setBanner({ type: "success", message: `Exported ${exportSet.length} row${exportSet.length === 1 ? "" : "s"}.` });
      await refreshHistory();
    } catch {
      setBanner({ type: "error", message: "Network error during export." });
    } finally {
      setExportLoading(null);
    }
  }

  function openManualAdd() {
    setManualDraft({
      ...EMPTY_MANUAL_ROW,
      note,
      orderNumber: orderNumber.trim(),
    });
    setManualOpen(true);
  }

  function saveManualRow() {
    const error = validateManualRow(manualDraft);
    if (error) {
      setBanner({ type: "error", message: error });
      return;
    }
    addRow(toWorkingRow(manualDraft, manualDraft.note ?? ""));
    setManualOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Label Formatter</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Look up eBay, BigCommerce, or Shopify orders, prepare resend rows, and export LabelCrow Excel + 4x6 packing slips.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void exportRows("selected")}
            disabled={selectedRows.length === 0 || exportLoading !== null}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            {exportLoading === "selected" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export Selected{selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
          </button>
          <button
            onClick={() => void exportRows("all")}
            disabled={rows.length === 0 || exportLoading !== null}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {exportLoading === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Export All
          </button>
        </div>
      </div>

      <form onSubmit={handleLookupSubmit} className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,1fr)_auto_auto] md:items-end">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Order Number</span>
            <input
              value={orderNumber}
              onChange={(event) => setOrderNumber(event.target.value)}
              placeholder="18-14603-25927"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="INR Case"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
            />
          </label>
          <button
            type="submit"
            disabled={!orderNumber.trim() || lookupLoading}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Add Order
          </button>
          <button
            type="button"
            onClick={openManualAdd}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent"
          >
            <Plus className="h-4 w-4" />
            Manual Add
          </button>
        </div>
      </form>

      {banner ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            banner.type === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
            banner.type === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
            banner.type === "error" && "border-red-500/30 bg-red-500/10 text-red-300",
          )}
        >
          {banner.type === "success" ? <Check className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
          <span>{banner.message}</span>
          {banner.type !== "success" ? (
            <button onClick={() => setManualOpen(true)} className="ml-auto cursor-pointer text-xs font-medium underline">
              Add manually
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <PackageCheck className="h-4 w-4 text-primary" />
            Working Table
            <span className="text-muted-foreground">({rows.length})</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">
              {selectedRows.length > 0 ? `${selectedRows.length} selected` : "No rows selected"}
            </div>
            {selectedRows.length > 0 ? (
              <button
                type="button"
                onClick={removeSelectedRows}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-medium text-red-300 hover:bg-red-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Selected
              </button>
            ) : null}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1500px] text-left text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-12 px-3 py-3">
                  <input type="checkbox" checked={allSelected} onChange={toggleAllSelected} aria-label="Select all rows" />
                </th>
                <th className="px-3 py-3">Notes</th>
                <th className="px-3 py-3">Order Number</th>
                <th className="px-3 py-3">Store</th>
                <th className="px-3 py-3">Buyer Name</th>
                <th className="px-3 py-3">Address Line 1</th>
                <th className="px-3 py-3">Address Line 2</th>
                <th className="px-3 py-3">City</th>
                <th className="px-3 py-3">State</th>
                <th className="px-3 py-3">Zip Code</th>
                <th className="px-3 py-3">SKU / Quantity Summary</th>
                <th className="w-16 px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    Add an order to start building the export.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-muted/20">
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row.id)} aria-label={`Select ${row.orderNumber}`} />
                    </td>
                    <EditableCell value={row.note ?? ""} onChange={(value) => updateRow(row.id, { note: value })} />
                    <EditableCell value={row.orderNumber} onChange={(value) => updateRow(row.id, { orderNumber: value })} mono />
                    <td className="px-3 py-3">
                      <select
                        value={row.sourceStore}
                        onChange={(event) => updateRow(row.id, { sourceStore: event.target.value as LabelFormatterSourceStore })}
                        className="h-9 w-28 rounded-md border border-input bg-background px-2 text-xs"
                      >
                        <option value="EBAY_TPP">eBay TPP</option>
                        <option value="EBAY_TT">eBay TT</option>
                        <option value="BIGCOMMERCE">BigCommerce</option>
                        <option value="SHOPIFY">Shopify</option>
                        <option value="MANUAL">Manual</option>
                      </select>
                    </td>
                    <EditableCell value={row.buyerName} onChange={(value) => updateRow(row.id, { buyerName: value })} />
                    <EditableCell value={row.addressLine1} onChange={(value) => updateRow(row.id, { addressLine1: value })} wide />
                    <EditableCell value={row.addressLine2 ?? ""} onChange={(value) => updateRow(row.id, { addressLine2: value })} wide />
                    <EditableCell value={row.city} onChange={(value) => updateRow(row.id, { city: value })} />
                    <EditableCell value={row.state} onChange={(value) => updateRow(row.id, { state: value })} compact />
                    <EditableCell value={row.zipCode} onChange={(value) => updateRow(row.id, { zipCode: value })} mono />
                    <td className="min-w-[280px] px-3 py-3">
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground">{skuSummary(row.lineItems)}</div>
                        {row.lineItems.map((line, index) => (
                          <div key={`${row.id}-${index}`} className="grid grid-cols-[minmax(120px,1fr)_64px_28px] gap-2">
                            <input
                              value={line.sku}
                              onChange={(event) => updateLineItem(row.id, index, { sku: event.target.value })}
                              className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
                            />
                            <input
                              value={line.quantity}
                              type="number"
                              min={1}
                              onChange={(event) => updateLineItem(row.id, index, { quantity: Math.max(1, Number(event.target.value) || 1) })}
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => updateRow(row.id, { lineItems: row.lineItems.filter((_, i) => i !== index) })}
                              disabled={row.lineItems.length <= 1}
                              className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
                              aria-label="Remove SKU line"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => updateRow(row.id, { lineItems: [...row.lineItems, { sku: "", quantity: 1 }] })}
                          className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          <Plus className="h-3 w-3" />
                          Add SKU
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => removeRow(row.id)}
                        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
                        aria-label={`Delete ${row.orderNumber}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Export History</h2>
          <p className="mt-1 text-xs text-muted-foreground">Generated files download immediately; history records the exported batches.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Created By</th>
                <th className="px-4 py-3">Rows</th>
                <th className="px-4 py-3">Orders</th>
                <th className="px-4 py-3">Stores</th>
                <th className="px-4 py-3">Files</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No exports yet.</td></tr>
              ) : history.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3">{entry.createdBy?.name ?? entry.createdBy?.email ?? "Unknown"}</td>
                  <td className="px-4 py-3">{entry.rowCount}</td>
                  <td className="px-4 py-3 font-mono text-xs">{textList(entry.orderNumbers)}</td>
                  <td className="px-4 py-3 text-xs">{sourceStoreList(entry.sourceStores)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {entry.excelFileName}, {entry.pdfFileName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {duplicatePending ? (
        <ConfirmModal
          title="Order already exists"
          message="This order already exists in the table. Add it anyway?"
          confirmLabel="Add Anyway"
          onCancel={() => setDuplicatePending(null)}
          onConfirm={() => {
            const row = duplicatePending;
            setDuplicatePending(null);
            addRow(row, true);
          }}
        />
      ) : null}

      {conflictPending ? (
        <ConflictModal
          matches={conflictPending}
          note={note}
          onCancel={() => setConflictPending(null)}
          onChoose={(match) => {
            setConflictPending(null);
            addRow(toWorkingRow(match, note));
          }}
        />
      ) : null}

      {manualOpen ? (
        <ManualModal
          draft={manualDraft}
          setDraft={setManualDraft}
          onCancel={() => setManualOpen(false)}
          onSave={saveManualRow}
        />
      ) : null}
    </div>
  );
}

function EditableCell({
  value,
  onChange,
  mono,
  compact,
  wide,
}: {
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  compact?: boolean;
  wide?: boolean;
}) {
  return (
    <td className={cn("px-3 py-3", wide ? "min-w-[220px]" : compact ? "min-w-[80px]" : "min-w-[160px]")}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-primary",
          mono && "font-mono text-xs",
        )}
      />
    </td>
  );
}

function ConfirmModal(props: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{props.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{props.message}</p>
          </div>
          <button onClick={props.onCancel} className="cursor-pointer rounded-md p-1 hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={props.onCancel} className="h-10 cursor-pointer rounded-md border border-border px-3 text-sm hover:bg-accent">Cancel</button>
          <button onClick={props.onConfirm} className="h-10 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">{props.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ConflictModal({
  matches,
  onCancel,
  onChoose,
}: {
  matches: LabelFormatterRow[];
  note: string;
  onCancel: () => void;
  onChoose: (row: LabelFormatterRow) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Order found in both stores</h2>
            <p className="mt-2 text-sm text-muted-foreground">Choose which store should be used for this row.</p>
          </div>
          <button onClick={onCancel} className="cursor-pointer rounded-md p-1 hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {matches.map((match) => (
            <button
              key={`${match.sourceStore}-${match.orderNumber}`}
              onClick={() => onChoose(match)}
              className="cursor-pointer rounded-lg border border-border p-4 text-left hover:bg-accent"
            >
              <div className="text-sm font-semibold">{sourceStoreLabel(match.sourceStore)}</div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{match.orderNumber}</div>
              <div className="mt-3 text-sm">{match.buyerName || "Buyer unavailable"}</div>
              <div className="mt-1 text-xs text-muted-foreground">{match.addressLine1}, {match.city}, {match.state} {match.zipCode}</div>
              <div className="mt-2 text-xs">{skuSummary(match.lineItems)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ManualModal({
  draft,
  setDraft,
  onCancel,
  onSave,
}: {
  draft: LabelFormatterRow;
  setDraft: React.Dispatch<React.SetStateAction<LabelFormatterRow>>;
  onCancel: () => void;
  onSave: () => void;
}) {
  function patch(patchValue: Partial<LabelFormatterRow>) {
    setDraft((current) => ({ ...current, ...patchValue }));
  }
  function patchLine(index: number, patchValue: Partial<LabelFormatterLineItem>) {
    setDraft((current) => ({
      ...current,
      lineItems: current.lineItems.map((line, lineIndex) => lineIndex === index ? { ...line, ...patchValue } : line),
    }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Manual Add</h2>
            <p className="mt-1 text-sm text-muted-foreground">Add address and SKU data for an order that was not found automatically.</p>
          </div>
          <button onClick={onCancel} className="cursor-pointer rounded-md p-1 hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <ManualField label="Notes" value={draft.note ?? ""} onChange={(value) => patch({ note: value })} />
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Store</span>
            <select
              value={draft.sourceStore}
              onChange={(event) => patch({ sourceStore: event.target.value as LabelFormatterSourceStore })}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary"
            >
              <option value="EBAY_TPP">eBay TPP</option>
              <option value="EBAY_TT">eBay TT</option>
              <option value="BIGCOMMERCE">BigCommerce</option>
              <option value="SHOPIFY">Shopify</option>
              <option value="MANUAL">Manual</option>
            </select>
          </label>
          <ManualField label="Order Number" value={draft.orderNumber} onChange={(value) => patch({ orderNumber: value })} />
          <ManualField label="Buyer Name" value={draft.buyerName} onChange={(value) => patch({ buyerName: value })} />
          <ManualField label="Address Line 1" value={draft.addressLine1} onChange={(value) => patch({ addressLine1: value })} />
          <ManualField label="Address Line 2" value={draft.addressLine2 ?? ""} onChange={(value) => patch({ addressLine2: value })} />
          <ManualField label="City" value={draft.city} onChange={(value) => patch({ city: value })} />
          <ManualField label="State" value={draft.state} onChange={(value) => patch({ state: value })} />
          <ManualField label="Zip Code" value={draft.zipCode} onChange={(value) => patch({ zipCode: value })} />
        </div>
        <div className="mt-5 space-y-2">
          <div className="text-sm font-medium">SKU / Quantity</div>
          {draft.lineItems.map((line, index) => (
            <div key={index} className="grid grid-cols-[minmax(180px,1fr)_90px_36px] gap-2">
              <input value={line.sku} onChange={(event) => patchLine(index, { sku: event.target.value })} className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm" />
              <input value={line.quantity} type="number" min={1} onChange={(event) => patchLine(index, { quantity: Math.max(1, Number(event.target.value) || 1) })} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
              <button
                type="button"
                onClick={() => patch({ lineItems: draft.lineItems.filter((_, i) => i !== index) })}
                disabled={draft.lineItems.length <= 1}
                className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-border hover:bg-accent"
                aria-label="Remove SKU"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => patch({ lineItems: [...draft.lineItems, { sku: "", quantity: 1 }] })}
            className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <Plus className="h-4 w-4" />
            Add SKU
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="h-10 cursor-pointer rounded-md border border-border px-3 text-sm hover:bg-accent">Cancel</button>
          <button onClick={onSave} className="h-10 cursor-pointer rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">Add Row</button>
        </div>
      </div>
    </div>
  );
}

function ManualField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary" />
    </label>
  );
}
