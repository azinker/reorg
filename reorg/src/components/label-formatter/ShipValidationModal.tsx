"use client";

import { AlertTriangle, X } from "lucide-react";
import type { LabelFormatterRowValidationIssue } from "@/lib/label-formatter/row-validation";

export function ShipValidationModal({
  issues,
  onClose,
}: {
  issues: LabelFormatterRowValidationIssue[];
  onClose: () => void;
}) {
  const orderCount = new Set(issues.map((issue) => issue.orderNumber)).size;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ship-validation-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              <h2 id="ship-validation-title" className="text-lg font-semibold">
                Fix orders before shipping
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {orderCount} order{orderCount === 1 ? "" : "s"} need editing in the working table before labels can be created.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <ul className="space-y-3">
            {issues.map((issue, index) => (
              <li
                key={`${issue.orderNumber}-${issue.field}-${index}`}
                className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm"
              >
                <div className="font-medium text-foreground">
                  Order {issue.orderNumber}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (table row {issue.rowIndex})
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {issue.field}: {issue.message}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Back to working table
          </button>
        </div>
      </div>
    </div>
  );
}
