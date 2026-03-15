"use client";

import { useState } from "react";
import {
  Upload,
  FileDown,
  FileCheck,
  Settings2,
  CheckCircle,
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
  "weight",
  "supplier_cost",
  "supplier_shipping_cost",
  "notes",
];

export default function ImportPage() {
  const [currentStep, setCurrentStep] = useState(1);

  return (
    <div className="p-6">
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
            <div className="flex h-40 items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20">
              <span className="text-sm text-muted-foreground">
                Drop file here or click to upload
              </span>
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
          </div>
        )}

        {currentStep === 5 && (
          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">
              Confirm
            </h2>
            <p className="text-sm text-muted-foreground">
              Ready to run the import.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
