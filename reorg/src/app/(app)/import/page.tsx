"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import {
  Upload,
  FileDown,
  FileCheck,
  Settings2,
  CheckCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: 1, label: "Download Template", icon: FileDown },
  { id: 2, label: "Upload File", icon: Upload },
  { id: 3, label: "Preview & Validate", icon: FileCheck },
  { id: 4, label: "Choose Mode", icon: Settings2 },
  { id: 5, label: "Confirm", icon: CheckCircle },
] as const;

const SUPPORTED_FIELDS = [
  "sku",
  "upc",
  "weight",
  "supplier_cost",
  "supplier_shipping_cost",
  "notes",
];

export default function ImportPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{
    validRows: number;
    errorRows: number;
    preview: Record<string, unknown>[];
    errors: { row: number; errors: string[] }[];
  } | null>(null);
  const [importMode, setImportMode] = useState<"fill_blanks" | "overwrite">("fill_blanks");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; applyErrors: { row: number; error: string }[] } | null>(null);
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
          applyErrors: json.data.applyErrors ?? [],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function downloadTemplate() {
    window.location.href = "/api/import/template";
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Import
        </h1>
        <p className="text-sm text-muted-foreground">
          Import starter data and ongoing internal updates from workbook
          templates
        </p>
      </div>

      {/* Step progress bar */}
      <div className="mb-8">
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
                    "group flex flex-1 cursor-pointer flex-col items-center gap-2 py-2",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                      isActive &&
                        "border-primary bg-primary text-primary-foreground",
                      isCompleted &&
                        "border-green-500/50 bg-green-500/20 text-green-600 dark:text-green-400",
                      !isActive &&
                        !isCompleted &&
                        "border-border bg-muted/50 text-muted-foreground group-hover:border-muted-foreground/50"
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                </button>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-0.5 flex-1 min-w-[20px]",
                      step.id < currentStep ? "bg-green-500/40" : "bg-border"
                    )}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="rounded-lg border border-border bg-card p-6">
        {currentStep === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Download template
              </h2>
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
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              )}
              aria-label="Download import template"
            >
              <FileDown className="h-4 w-4" aria-hidden />
              Download template
            </button>

            <div>
              <h3 className="text-sm font-medium text-foreground">
                Supported fields
              </h3>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                {SUPPORTED_FIELDS.map((field) => (
                  <li key={field}>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                      {field}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Imported <span className="font-medium text-foreground">UPC</span> values are staged for review and push.
                They do not write directly to marketplaces during import.
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
                <code className="rounded bg-muted px-1 font-mono">1</code>–
                <code className="rounded bg-muted px-1 font-mono">16</code> for
                ounces (e.g., <code className="rounded bg-muted px-1 font-mono">5</code>{" "}
                = 5oz). Use{" "}
                <code className="rounded bg-muted px-1 font-mono">2LBS</code>–
                <code className="rounded bg-muted px-1 font-mono">10LBS</code> for
                pounds.
              </p>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">
              Upload File
            </h2>
            <p className="text-sm text-muted-foreground">
              Select your workbook file to import.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
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
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">
              Preview & Validate
            </h2>
            <p className="text-sm text-muted-foreground">
              Review your data before importing.
            </p>
            {file && (
              <>
                <button
                  type="button"
                  disabled={loading}
                  onClick={runPreview}
                  className="inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />}
                  {loading ? "Validating…" : "Validate file"}
                </button>
                {preview && (
                  <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
                    <p className="text-sm font-medium">
                      Valid rows: {preview.validRows} · Rows with errors: {preview.errorRows}
                    </p>
                    {preview.preview.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        First rows: {preview.preview.map((r) => (r as { sku?: string }).sku ?? "—").join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            {!file && <p className="text-sm text-amber-600 dark:text-amber-400">Go back to step 2 and select a file.</p>}
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">
              Choose Mode
            </h2>
            <p className="text-sm text-muted-foreground">
              Select full import or update mode.
            </p>
            <div className="flex gap-4">
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
                <span className="text-sm">Overwrite (replace existing values)</span>
              </label>
            </div>
          </div>
        )}

        {currentStep === 5 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">
              Confirm
            </h2>
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
              {loading ? "Importing…" : "Run import"}
            </button>
            {result && (
              <div className="rounded-md border border-border bg-muted/20 p-4 text-sm">
                <p className="font-medium">Import complete.</p>
                <p className="text-muted-foreground">Created: {result.created} · Updated: {result.updated}</p>
                {result.applyErrors.length > 0 && (
                  <p className="mt-1 text-amber-600 dark:text-amber-400">
                    {result.applyErrors.length} row(s) had errors.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
