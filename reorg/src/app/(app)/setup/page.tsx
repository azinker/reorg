"use client";

import {
  ClipboardCheck,
  CheckCircle,
  Circle,
  AlertCircle,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

type StepStatus = "Not Started" | "In Progress" | "Complete" | "Needs Attention";

const steps: {
  number: number;
  title: string;
  status: StepStatus;
  description: string;
}[] = [
  {
    number: 1,
    title: "Connect TPP eBay",
    status: "Not Started",
    description: "Configure The Perfect Part eBay integration and API credentials",
  },
  {
    number: 2,
    title: "Connect TT eBay",
    status: "Not Started",
    description: "Configure Telitetech eBay integration and API credentials",
  },
  {
    number: 3,
    title: "Connect BigCommerce",
    status: "Not Started",
    description: "Configure BigCommerce store connection and API token",
  },
  {
    number: 4,
    title: "Connect Shopify",
    status: "Not Started",
    description: "Configure Shopify store connection and API credentials",
  },
  {
    number: 5,
    title: "Add admin users",
    status: "Complete",
    description: "Both admins seeded (Adam Zinker, Cory Zinker)",
  },
  {
    number: 6,
    title: "Import starter workbook",
    status: "Not Started",
    description: "Download template, populate data, and run import wizard",
  },
  {
    number: 7,
    title: "Populate shipping rate table",
    status: "Not Started",
    description: "Add weight-to-cost mappings for 1oz–16oz and 2LBS–10LBS",
  },
  {
    number: 8,
    title: "Confirm master store",
    status: "Complete",
    description: "TPP eBay set as master store",
  },
  {
    number: 9,
    title: "Keep global write lock ON",
    status: "Complete",
    description: "Write lock enabled for safe operations",
  },
  {
    number: 10,
    title: "Run first dry-run sync",
    status: "Not Started",
    description: "Execute sync in dry-run mode to validate data flow",
  },
  {
    number: 11,
    title: "Review errors",
    status: "Not Started",
    description: "Check Errors page for any sync or validation issues",
  },
];

const statusConfig: Record<
  StepStatus,
  { icon: typeof CheckCircle; className: string }
> = {
  "Not Started": {
    icon: Circle,
    className:
      "border-muted-foreground/40 bg-muted/50 text-muted-foreground",
  },
  "In Progress": {
    icon: Clock,
    className:
      "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  Complete: {
    icon: CheckCircle,
    className:
      "border-green-500/40 bg-green-500/15 text-green-600 dark:text-green-400",
  },
  "Needs Attention": {
    icon: AlertCircle,
    className:
      "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
};

export default function SetupPage() {
  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <ClipboardCheck
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Setup Checklist
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Guided onboarding and system health checklist
        </p>
      </div>

      {/* Checklist */}
      <div className="space-y-0">
        {steps.map((step, index) => {
          const config = statusConfig[step.status];
          const Icon = config.icon;
          const isLast = index === steps.length - 1;

          return (
            <div
              key={step.number}
              className={cn(
                "flex gap-4 py-5",
                !isLast && "border-b border-border"
              )}
            >
              {/* Step number */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-sm font-semibold text-foreground">
                {step.number}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-medium text-foreground">
                    {step.title}
                  </h3>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium",
                      config.className
                    )}
                  >
                    <Icon className="h-3 w-3 shrink-0" aria-hidden />
                    {step.status}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
