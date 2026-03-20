import {
  ClipboardCheck,
  CheckCircle,
  Circle,
  AlertCircle,
  Clock,
} from "lucide-react";
import { db } from "@/lib/db";
import { cn } from "@/lib/utils";
import { getAutomationHealthSnapshot } from "@/lib/services/automation-health";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { hasConnectedCredentials } from "@/lib/integrations/factory";
import { isLivePushEnabled, isSchedulerEnabled } from "@/lib/automation-settings";
import type { Platform, Role } from "@prisma/client";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

type StepStatus = "Not Started" | "In Progress" | "Complete" | "Needs Attention";

type SetupStep = {
  number: number;
  title: string;
  status: StepStatus;
  description: string;
};

const PLATFORM_STEP_META: Array<{
  number: number;
  title: string;
  platform: Platform;
  description: string;
}> = [
  {
    number: 1,
    title: "Connect TPP eBay",
    platform: "TPP_EBAY",
    description: "Configure The Perfect Part eBay integration and API credentials",
  },
  {
    number: 2,
    title: "Connect TT eBay",
    platform: "TT_EBAY",
    description: "Configure Telitetech eBay integration and API credentials",
  },
  {
    number: 3,
    title: "Connect BigCommerce",
    platform: "BIGCOMMERCE",
    description: "Configure BigCommerce store connection and API token",
  },
  {
    number: 4,
    title: "Connect Shopify",
    platform: "SHOPIFY",
    description: "Configure Shopify store connection and API credentials",
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

function getIntegrationStepStatus(connected: boolean, enabled: boolean): StepStatus {
  if (connected && enabled) return "Complete";
  if (connected) return "In Progress";
  return "Not Started";
}

function getImportStatus(
  productCount: number,
  completeRows: number,
  partialRows: number,
): StepStatus {
  if (completeRows > 0 && completeRows === productCount && productCount > 0) {
    return "Complete";
  }
  if (completeRows > 0 || partialRows > 0) {
    return "In Progress";
  }
  return "Not Started";
}

function getShippingRateStatus(filledTiers: number, totalTiers: number): StepStatus {
  if (filledTiers >= totalTiers && totalTiers > 0) return "Complete";
  if (filledTiers > 0) return "In Progress";
  return "Not Started";
}

export default async function SetupPage() {
  const [
    integrations,
    users,
    masterRows,
    shippingRates,
    syncJobs,
    globalWriteLockSetting,
    schedulerEnabled,
    livePushEnabled,
    automationHealth,
  ] = await Promise.all([
    db.integration.findMany({ orderBy: { platform: "asc" } }),
    db.user.findMany({ select: { email: true, role: true } }),
    db.masterRow.findMany({
      select: {
        id: true,
        weight: true,
        supplierCost: true,
        supplierShipping: true,
      },
    }),
    db.shippingRate.findMany({
      select: {
        cost: true,
      },
    }),
    db.syncJob.findMany({
      select: {
        status: true,
      },
      take: 200,
      orderBy: { createdAt: "desc" },
    }),
    db.appSetting.findUnique({ where: { key: "global_write_lock" } }),
    isSchedulerEnabled(),
    isLivePushEnabled(),
    getAutomationHealthSnapshot(),
  ]);

  const integrationMap = new Map(
    integrations.map((integration) => [integration.platform, integration]),
  );

  const productCount = masterRows.length;
  const completeRows = masterRows.filter(
    (row) =>
      !!row.weight?.trim() &&
      row.supplierCost != null &&
      row.supplierShipping != null,
  ).length;
  const partialRows = masterRows.filter(
    (row) =>
      !!row.weight?.trim() ||
      row.supplierCost != null ||
      row.supplierShipping != null,
  ).length;
  const filledShippingTiers = shippingRates.filter((rate) => rate.cost != null).length;
  const totalShippingTiers = shippingRates.length;

  const adminEmails = new Set(
    users
      .filter((user) => user.role === ("ADMIN" as Role))
      .map((user) => user.email.trim().toLowerCase()),
  );

  const completedSyncs = syncJobs.filter((job) => job.status === "COMPLETED").length;
  const syncAttempted = syncJobs.length > 0;
  const syncFailed = syncJobs.some((job) => job.status === "FAILED");
  const currentErrorCount = masterRows.filter(
    (row) =>
      !row.weight?.trim() ||
      row.supplierCost == null ||
      row.supplierShipping == null,
  ).length + syncJobs.filter((job) => job.status === "FAILED").length;

  const globalWriteLock =
    typeof globalWriteLockSetting?.value === "boolean"
      ? globalWriteLockSetting.value
      : true;

  const steps: SetupStep[] = [
    ...PLATFORM_STEP_META.map((meta) => {
      const integration = integrationMap.get(meta.platform);
      const connected = integration
        ? hasConnectedCredentials(meta.platform, getIntegrationConfig(integration))
        : false;

      return {
        number: meta.number,
        title: meta.title,
        status: integration
          ? getIntegrationStepStatus(connected, integration.enabled)
          : "Not Started",
        description: connected
          ? `${meta.description}. Connected${integration?.enabled ? " and enabled" : ", but not enabled yet"}.`
          : meta.description,
      };
    }),
    {
      number: 5,
      title: "Add admin users",
      status:
        adminEmails.has("adam@theperfectpart.net") &&
        (adminEmails.has("coryzz@live.com") || adminEmails.has("cory@theperfectpart.net"))
          ? "Complete"
          : adminEmails.size > 0
            ? "In Progress"
            : "Not Started",
      description: `${adminEmails.size} admin user(s) currently configured.`,
    },
    {
      number: 6,
      title: "Import starter workbook",
      status: getImportStatus(productCount, completeRows, partialRows),
      description:
        productCount === 0
          ? "No master products found yet."
          : `${completeRows} of ${productCount} master rows already have weight, supplier cost, and supplier shipping filled.`,
    },
    {
      number: 7,
      title: "Populate shipping rate table",
      status: getShippingRateStatus(filledShippingTiers, totalShippingTiers),
      description: `${filledShippingTiers} of ${totalShippingTiers} shipping tiers currently have a cost.`,
    },
    {
      number: 8,
      title: "Confirm master store",
      status:
        integrationMap.get("TPP_EBAY")?.isMaster
          ? "Complete"
          : integrationMap.size > 0
            ? "Needs Attention"
            : "Not Started",
      description: integrationMap.get("TPP_EBAY")?.isMaster
        ? "TPP eBay is configured as the master store."
        : "TPP eBay is not currently marked as the master store.",
    },
    {
      number: 9,
      title: "Keep global write lock ON",
      status: globalWriteLock && !livePushEnabled ? "Complete" : "Needs Attention",
      description: globalWriteLock && !livePushEnabled
        ? "Global write lock is enabled and live push is still disabled."
        : "Global write safety settings need review before allowing marketplace writes.",
    },
    {
      number: 10,
      title: "Run first sync",
      status:
        completedSyncs > 0
          ? "Complete"
          : syncAttempted
            ? syncFailed
              ? "Needs Attention"
              : "In Progress"
            : "Not Started",
      description:
        completedSyncs > 0
          ? `${completedSyncs} sync job(s) have completed successfully. Scheduler is ${schedulerEnabled ? "enabled" : "still off"}.`
          : syncAttempted
            ? "A sync has been attempted, but there is not a completed run yet."
            : "No sync jobs have run yet.",
    },
    {
      number: 11,
      title: "Verify automation health",
      status:
        automationHealth.summary.status === "healthy"
          ? "Complete"
          : automationHealth.summary.status === "delayed"
            ? "Needs Attention"
            : "Needs Attention",
      description:
        automationHealth.summary.status === "healthy"
          ? "Automatic pulls and webhook health are within the expected window."
          : `${automationHealth.summary.detail} ${automationHealth.summary.recommendedAction}`,
    },
    {
      number: 12,
      title: "Review errors",
      status:
        currentErrorCount === 0
          ? syncAttempted
            ? "Complete"
            : "Not Started"
          : "Needs Attention",
      description:
        currentErrorCount === 0
          ? "No current missing-data or failed-sync issues detected."
          : `${currentErrorCount} issue(s) currently need attention on the Errors page.`,
    },
  ];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-8" data-tour="setup-header">
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
          Guided onboarding and live system readiness checks
        </p>
      </div>

      <div className="space-y-0" data-tour="setup-steps">
        {steps.map((step, index) => {
          const config = statusConfig[step.status];
          const Icon = config.icon;
          const isLast = index === steps.length - 1;

          return (
            <div
              key={step.number}
              className={cn("flex gap-4 py-5", !isLast && "border-b border-border")}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-sm font-semibold text-foreground">
                {step.number}
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-medium text-foreground">
                    {step.title}
                  </h3>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium",
                      config.className,
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
      <PageTour page="setup" steps={PAGE_TOUR_STEPS.setup} ready />
    </div>
  );
}
