"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  CheckCircle,
  FileCheck,
  FileDown,
  Loader2,
  Settings2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const STEPS = [
  { id: 1, label: "Download Template", icon: FileDown },
  { id: 2, label: "Upload File", icon: Upload },
  { id: 3, label: "Preview & Validate", icon: FileCheck },
  { id: 4, label: "Choose Mode", icon: Settings2 },
  { id: 5, label: "Confirm", icon: CheckCircle },
] as const;

const SUPPORTED_FIELDS = [
  {
    key: "sku",
    required: true,
    description: "Required. Used to match the import row to the correct product row in reorG.",
  },
  {
    key: "upc",
    required: false,
    description: "Optional. Blank UPC cells are ignored. Filled UPC values are staged for review, not pushed live automatically.",
  },
  {
    key: "weight",
    required: false,
    description: "Optional. Use 1-16 for ounces or 2LBS-10LBS for pounds.",
  },
  {
    key: "supplier_cost",
    required: false,
    description: "Optional. Internal supplier cost value for profit calculations.",
  },
  {
    key: "supplier_shipping_cost",
    required: false,
    description: "Optional. Internal supplier shipping cost value for profit calculations.",
  },
  {
    key: "notes",
    required: false,
    description: "Optional. Internal free-text notes stored on the master row inside reorG. They do not push to marketplaces.",
  },
] as const;

const FAILURE_DOWNLOAD_HEADERS = [
  "sku",
  "upc",
  "weight",
  "supplier_cost",
  "supplier_shipping_cost",
  "notes",
  "error_reason",
] as const;

type PreviewState = {
  validRows: number;
  errorRows: number;
  preview: Record<string, unknown>[];
  errors: { row: number; errors: string[] }[];
};

type ImportFailure = {
  row: number;
  sku: string;
  error: string;
  fields: {
    sku: string;
    upc: string;
    weight: string;
    supplier_cost: string;
    supplier_shipping_cost: string;
    notes: string;
    error_reason?: string;
  };
};

type ImportSuccess = {
  row: number;
  sku: string;
  outcome: "created" | "updated" | "no_changes";
  summary: string;
  changedFields: string[];
};

type ImportResult = {
  created: number;
  updated: number;
  unchanged: number;
  applyErrors: { row: number; error: string }[];
  successes: ImportSuccess[];
  failures: ImportFailure[];
};

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export default function ImportPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [importMode, setImportMode] = useState<"fill_blanks" | "overwrite">("fill_blanks");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function runPreview() {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", "preview");
      const res = await fetch("/api/import", { method: "POST", body: form });
      const json = await res.json();
      if (res.ok && json.data) {
        setPreview({
          validRows: json.data.validRows ?? 0,
          errorRows: json.data.errorRows ?? 0,
          preview: json.data.preview ?? [],
          errors: json.data.errors ?? [],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  async function runImport() {
    if (!file) return;
    setLoading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", importMode);
      const res = await fetch("/api/import", { method: "POST", body: form });
      const json = await res.json();
      if (res.ok && json.data) {
        setResult({
          created: json.data.created ?? 0,
          updated: json.data.updated ?? 0,
          unchanged: json.data.unchanged ?? 0,
          applyErrors: json.data.applyErrors ?? [],
          successes: json.data.successes ?? [],
          failures: json.data.failures ?? [],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function downloadTemplate() {
    window.location.href = "/api/import/template";
  }

  function downloadFailedRows() {
    if (!result || result.failures.length === 0) return;

    const csv = [
      FAILURE_DOWNLOAD_HEADERS.join(","),
      ...result.failures.map((failure) =>
        FAILURE_DOWNLOAD_HEADERS.map((header) =>
          csvEscape(failure.fields[header] ?? ""),
        ).join(","),
      ),
    ].join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "reorg-import-failures.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function goToPreviousStep() {
    setCurrentStep((step) => Math.max(1, step - 1));
  }

  function goToNextStep() {
    setCurrentStep((step) => Math.min(STEPS.length, step + 1));
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-8" data-tour="import-header">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Import</h1>
        <p className="text-sm text-muted-foreground">
          Import starter data and ongoing internal updates from workbook templates
        </p>
      </div>

      <div className="mb-8" data-tour="import-steps">
        <div className="flex items-center gap-0">
          {STEPS.map((step, index) => {
            const isActive = step.id === currentStep;
            const isCompleted = step.id < currentStep;
            const Icon = step.icon;

            return (
              <div key={step.id} className="flex flex-1 items-center">
                <button
                  type="button"
                  onClick={() => setCurrentStep(step.id)}
                  aria-label={`Go to step ${step.id}: ${step.label}`}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "group flex flex-1 cursor-pointer flex-col items-center gap-2 rounded py-2",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                      isActive && "border-primary bg-primary text-primary-foreground",
                      isCompleted && "border-green-500/50 bg-green-500/20 text-green-600 dark:text-green-400",
                      !isActive &&
                        !isCompleted &&
                        "border-border bg-muted/50 text-muted-foreground group-hover:border-muted-foreground/50",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </button>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-0.5 min-w-[20px] flex-1",
                      step.id < currentStep ? "bg-green-500/40" : "bg-border",
                    )}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6" data-tour="import-result">
        {currentStep === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Download template</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Get the import template with the correct columns for your data.
              </p>
            </div>

            <button
              type="button"
              onClick={downloadTemplate}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground",
                "transition-colors hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
              aria-label="Download import template"
            >
              <FileDown className="h-4 w-4" aria-hidden />
              Download template
            </button>

            <div>
              <h3 className="text-sm font-medium text-foreground">Supported fields</h3>
              <div className="mt-3 space-y-2">
                {SUPPORTED_FIELDS.map((field) => (
                  <div key={field.key} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        {field.key}
                      </code>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          field.required
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {field.required ? "Required" : "Optional"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Blank optional cells are ignored in both modes. They do not delete existing table data.
              </p>
            </div>

            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 text-sm text-muted-foreground">
              <p>
                The <span className="font-medium text-foreground">Shipping Rates</span> table is already
                wired to the live database and ready to use after you import your internal product data.
              </p>
              <p className="mt-1">
                After importing weights, supplier cost, and supplier shipping cost, review{" "}
                <Link href="/shipping-rates" className="font-medium text-foreground underline-offset-4 hover:underline">
                  Shipping Rates
                </Link>{" "}
                to make sure every tier has a cost, then check{" "}
                <Link href="/errors" className="font-medium text-foreground underline-offset-4 hover:underline">
                  Errors
                </Link>{" "}
                for any rows still missing required internal values.
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">Weight format:</strong> Use{" "}
                <code className="rounded bg-muted px-1 font-mono">1</code>-
                <code className="rounded bg-muted px-1 font-mono">16</code> for
                ounces (for example, <code className="rounded bg-muted px-1 font-mono">5</code> = 5oz). Use{" "}
                <code className="rounded bg-muted px-1 font-mono">2LBS</code>-
                <code className="rounded bg-muted px-1 font-mono">10LBS</code> for pounds.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={goToNextStep}
                className="inline-flex items-center rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
              >
                Next: Upload File
              </button>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">Upload File</h2>
            <p className="text-sm text-muted-foreground">
              Select your workbook file to import.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const nextFile = e.target.files?.[0];
                if (nextFile) setFile(nextFile);
              }}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              className="flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/20 hover:bg-muted/40"
            >
              {file ? (
                <>
                  <FileCheck className="h-8 w-8 text-green-500" />
                  <span className="text-sm font-medium text-foreground">{file.name}</span>
                  <span className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Click or drop file here</span>
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={goToPreviousStep}
                className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                onClick={goToNextStep}
                disabled={!file}
                className="inline-flex items-center rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next: Preview & Validate
              </button>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">Preview & Validate</h2>
            <p className="text-sm text-muted-foreground">
              Review your data before importing.
            </p>
            {file ? (
              <>
                <button
                  type="button"
                  disabled={loading}
                  onClick={runPreview}
                  className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />}
                  {loading ? "Validating..." : "Validate file"}
                </button>
                {preview && (
                  <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
                    <p className="text-sm font-medium">
                      Valid rows: {preview.validRows} · Rows with errors: {preview.errorRows}
                    </p>
                    {preview.preview.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        First rows: {preview.preview.map((row) => (row as { sku?: string }).sku ?? "-").join(", ")}
                      </p>
                    )}
                    {preview.errors.length > 0 && (
                      <div className="max-h-56 overflow-y-auto rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
                          Validation issues
                        </p>
                        <div className="space-y-2">
                          {preview.errors.map((error) => (
                            <div key={`preview-error-${error.row}`} className="rounded border border-border/60 bg-background/50 px-3 py-2 text-sm">
                              <p className="font-medium text-foreground">Row {error.row}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{error.errors.join("; ")}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                Go back to step 2 and select a file.
              </p>
            )}

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={goToPreviousStep}
                className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                onClick={goToNextStep}
                disabled={!preview || preview.validRows === 0}
                className="inline-flex items-center rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next: Choose Mode
              </button>
            </div>
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">Choose Mode</h2>
            <p className="text-sm text-muted-foreground">
              Select full import or update mode.
            </p>
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Blank optional cells are ignored in both modes. Leaving UPC, weight, supplier cost, supplier shipping cost,
              or notes blank means "do not change that field," not "delete it."
            </div>
            <div className="flex flex-col gap-4 lg:flex-row">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="importMode"
                  checked={importMode === "fill_blanks"}
                  onChange={() => setImportMode("fill_blanks")}
                  className="rounded-full border-border"
                />
                <span className="text-sm">Fill blanks only (do not overwrite existing values)</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="importMode"
                  checked={importMode === "overwrite"}
                  onChange={() => setImportMode("overwrite")}
                  className="rounded-full border-border"
                />
                <span className="text-sm">Overwrite provided values only (blank cells are still ignored)</span>
              </label>
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={goToPreviousStep}
                className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                onClick={goToNextStep}
                className="inline-flex items-center rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
              >
                Next: Confirm
              </button>
            </div>
          </div>
        )}

        {currentStep === 5 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">Confirm</h2>
            <p className="text-sm text-muted-foreground">
              Ready to run the import. {preview && `${preview.validRows} valid rows will be applied in "${importMode}" mode.`}
            </p>
            <button
              type="button"
              disabled={loading || !file || !preview || preview.validRows === 0}
              onClick={runImport}
              className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {loading ? "Importing..." : "Run import"}
            </button>
            {result && (
              <div className="space-y-4 rounded-md border border-border bg-muted/20 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">Import complete.</p>
                    <p className="text-muted-foreground">
                      Created: {result.created} · Updated: {result.updated} · No changes: {result.unchanged} · Failed: {result.failures.length}
                    </p>
                  </div>
                  {result.failures.length > 0 && (
                    <button
                      type="button"
                      onClick={downloadFailedRows}
                      className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
                    >
                      <FileDown className="h-4 w-4" />
                      Download failed rows
                    </button>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Created</p>
                    <p className="mt-1 text-xl font-semibold text-foreground">{result.created}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
                    <p className="mt-1 text-xl font-semibold text-foreground">{result.updated}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">No Changes</p>
                    <p className="mt-1 text-xl font-semibold text-foreground">{result.unchanged}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Failed</p>
                    <p className="mt-1 text-xl font-semibold text-foreground">{result.failures.length}</p>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border border-border/70 bg-background/30 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">Successful rows</h3>
                      <span className="text-xs text-muted-foreground">{result.successes.length} rows</span>
                    </div>
                    {result.successes.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No successful rows were applied.</p>
                    ) : (
                      <div className="max-h-80 space-y-2 overflow-y-auto">
                        {result.successes.map((success) => (
                          <div key={`success-${success.row}-${success.sku}`} className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-mono text-sm font-semibold text-foreground">{success.sku}</p>
                              <span
                                className={cn(
                                  "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                                  success.outcome === "created"
                                    ? "bg-blue-500/15 text-blue-300"
                                    : success.outcome === "updated"
                                      ? "bg-emerald-500/15 text-emerald-300"
                                      : "bg-muted text-muted-foreground",
                                )}
                              >
                                {success.outcome === "no_changes" ? "No Changes" : success.outcome}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">Row {success.row}</p>
                            <p className="mt-1 text-sm text-foreground">{success.summary}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-border/70 bg-background/30 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">Failed rows</h3>
                      <span className="text-xs text-muted-foreground">{result.failures.length} rows</span>
                    </div>
                    {result.failures.length === 0 ? (
                      <p className="text-sm text-emerald-300">No failed rows. Everything imported cleanly.</p>
                    ) : (
                      <div className="max-h-80 space-y-2 overflow-y-auto">
                        {result.failures.map((failure) => (
                          <div key={`failure-${failure.row}-${failure.sku || "blank"}`} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-mono text-sm font-semibold text-foreground">
                                {failure.sku || "Missing SKU"}
                              </p>
                              <span className="text-xs text-muted-foreground">Row {failure.row}</span>
                            </div>
                            <p className="mt-1 text-sm text-amber-200">{failure.error}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={goToPreviousStep}
                className="inline-flex items-center rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
              >
                Back
              </button>
              {result ? (
                <button
                  type="button"
                  onClick={() => setCurrentStep(1)}
                  className="inline-flex items-center rounded-lg border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
                >
                  Start Another Import
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
      <PageTour page="import" steps={PAGE_TOUR_STEPS.import} ready />
    </div>
  );
}
