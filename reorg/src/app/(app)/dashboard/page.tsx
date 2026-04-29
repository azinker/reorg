import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Gauge,
  LifeBuoy,
  Lock,
  RefreshCw,
  TableProperties,
  Timer,
  type LucideIcon,
} from "lucide-react";
import {
  HelpdeskMessageDirection,
  HelpdeskTicketStatus,
  SyncStatus,
  TaskStatus,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import { computeSla } from "@/lib/helpdesk/sla";
import { getActor } from "@/lib/impersonation";
import {
  NAV_PAGES_BY_KEY,
  resolveAllowedPageKeys,
  type PageKey,
} from "@/lib/nav-pages";
import { cn } from "@/lib/utils";

type DashboardSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

const ACTIVE_TICKET_STATUSES = [
  HelpdeskTicketStatus.NEW,
  HelpdeskTicketStatus.TO_DO,
  HelpdeskTicketStatus.WAITING,
] as const;

const QUICK_LINKS: PageKey[] = [
  "help-desk",
  "tasks",
  "sync",
  "catalog",
  "inventory-forecaster",
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatRelative(value: Date | string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  const deltaMs = Date.now() - date.getTime();
  if (!Number.isFinite(deltaMs)) return "Unknown";
  if (deltaMs < 60_000) return "Just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readSettingString(
  settings: Array<{ key: string; value: Prisma.JsonValue }>,
  key: string,
) {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "string" ? value : null;
}

function readSettingNumber(
  settings: Array<{ key: string; value: Prisma.JsonValue }>,
  key: string,
) {
  const value = settings.find((setting) => setting.key === key)?.value;
  return typeof value === "number" ? value : null;
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
  href,
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: "neutral" | "good" | "warn" | "danger";
  href?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "border-red-500/25 bg-red-500/10 text-red-300"
      : tone === "warn"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-300"
        : tone === "good"
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
          : "border-border bg-card text-muted-foreground";

  const card = (
    <div
      className={cn(
        "group flex min-h-[128px] flex-col justify-between rounded-lg border p-4",
        toneClass,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {title}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
            {value}
          </p>
        </div>
        <span className="rounded-md border border-current/15 bg-background/40 p-2">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{detail}</span>
        {href ? (
          <ArrowRight className="h-4 w-4 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
        ) : null}
      </div>
    </div>
  );

  if (!href) return card;
  return (
    <Link href={href} className="block cursor-pointer">
      {card}
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: DashboardSearchParams;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");

  const params = (await searchParams) ?? {};
  const itemIdRaw = Array.isArray(params.itemId) ? params.itemId[0] : params.itemId;
  const platformItemIdRaw = Array.isArray(params.platformItemId)
    ? params.platformItemId[0]
    : params.platformItemId;
  const legacyItemId = itemIdRaw ?? platformItemIdRaw;
  if (legacyItemId) {
    const q = new URLSearchParams();
    q.set(itemIdRaw ? "itemId" : "platformItemId", legacyItemId);
    const platformRaw = Array.isArray(params.platform)
      ? params.platform[0]
      : params.platform;
    if (platformRaw) q.set("platform", platformRaw);
    redirect(`/catalog?${q.toString()}`);
  }

  const deniedRaw = Array.isArray(params.denied)
    ? params.denied[0]
    : params.denied;
  const deniedPage =
    deniedRaw && deniedRaw in NAV_PAGES_BY_KEY
      ? NAV_PAGES_BY_KEY[deniedRaw as PageKey]
      : null;

  const allowedPages = resolveAllowedPageKeys({
    role: actor.role,
    pagePermissions: actor.pagePermissions,
  });
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const myTicketWhere: Prisma.HelpdeskTicketWhereInput = {
    isArchived: false,
    isSpam: false,
    status: { in: [...ACTIVE_TICKET_STATUSES] },
    OR: [
      { primaryAssigneeId: actor.userId },
      { additionalAssignees: { some: { userId: actor.userId } } },
    ],
  };

  const [
    myAssignedOpen,
    myTodoTickets,
    myResolvedLast24h,
    myOutboundLast24h,
    teamOpenTickets,
    openTicketSlaRows,
    myOpenTasks,
    myOverdueTasks,
    sharedOpenTasks,
    schedulerSettings,
    recentFailedSyncs,
    queuedOrRunningSyncs,
  ] = await Promise.all([
    db.helpdeskTicket.count({ where: myTicketWhere }),
    db.helpdeskTicket.count({
      where: {
        ...myTicketWhere,
        status: { in: [HelpdeskTicketStatus.NEW, HelpdeskTicketStatus.TO_DO] },
      },
    }),
    db.helpdeskTicket.count({
      where: {
        resolvedById: actor.userId,
        resolvedAt: { gte: last24h },
      },
    }),
    db.helpdeskMessage.count({
      where: {
        authorUserId: actor.userId,
        direction: HelpdeskMessageDirection.OUTBOUND,
        sentAt: { gte: last24h },
        deletedAt: null,
      },
    }),
    db.helpdeskTicket.count({
      where: {
        isArchived: false,
        isSpam: false,
        status: { in: [...ACTIVE_TICKET_STATUSES] },
      },
    }),
    db.helpdeskTicket.findMany({
      where: {
        isArchived: false,
        isSpam: false,
        status: { in: [...ACTIVE_TICKET_STATUSES] },
      },
      select: {
        lastBuyerMessageAt: true,
        firstResponseAt: true,
      },
      take: 500,
    }),
    db.task.count({
      where: {
        assignedToUserId: actor.userId,
        deletedAt: null,
        status: { not: TaskStatus.COMPLETED },
      },
    }),
    db.task.count({
      where: {
        assignedToUserId: actor.userId,
        deletedAt: null,
        status: { not: TaskStatus.COMPLETED },
        dueAt: { lt: new Date() },
      },
    }),
    db.task.count({
      where: {
        isSharedTeamTask: true,
        deletedAt: null,
        status: { not: TaskStatus.COMPLETED },
      },
    }),
    db.appSetting.findMany({
      where: {
        key: {
          in: [
            "scheduler_last_tick_at",
            "scheduler_last_outcome",
            "scheduler_last_due_count",
            "scheduler_last_dispatched_count",
            "scheduler_last_error",
          ],
        },
      },
      select: { key: true, value: true },
    }),
    db.syncJob.count({
      where: { status: SyncStatus.FAILED, createdAt: { gte: last24h } },
    }),
    db.syncJob.count({
      where: { status: { in: [SyncStatus.PENDING, SyncStatus.RUNNING] } },
    }),
  ]);

  const slaAtRisk = openTicketSlaRows.reduce((count, ticket) => {
    const bucket = computeSla({
      lastBuyerMessageAt: ticket.lastBuyerMessageAt,
      firstResponseAt: ticket.firstResponseAt,
    }).bucket;
    return bucket === "AMBER" || bucket === "RED" ? count + 1 : count;
  }, 0);

  const schedulerLastTick = readSettingString(
    schedulerSettings,
    "scheduler_last_tick_at",
  );
  const schedulerOutcome = readSettingString(
    schedulerSettings,
    "scheduler_last_outcome",
  );
  const schedulerDueCount = readSettingNumber(
    schedulerSettings,
    "scheduler_last_due_count",
  );
  const schedulerDispatchedCount = readSettingNumber(
    schedulerSettings,
    "scheduler_last_dispatched_count",
  );
  const schedulerError = readSettingString(
    schedulerSettings,
    "scheduler_last_error",
  );

  const quickLinks = QUICK_LINKS.map((key) => NAV_PAGES_BY_KEY[key]).filter(
    (page) => allowedPages.has(page.key),
  );

  return (
    <main className="min-h-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        {deniedPage ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium text-foreground">
                {deniedPage.label} is locked for this account.
              </p>
              <p className="mt-0.5 text-amber-200/80">
                The page is still visible in the menu, but it is not included in
                this user's allow list.
              </p>
            </div>
          </div>
        ) : null}

        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div data-tour="dashboard-home">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#C43E3E]">
              reorG
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Dashboard
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Your Help Desk workload, task pressure, and sync pulse in one
              safe home view.
            </p>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {actor.name || actor.email}
            </span>
          </div>
        </header>

        <section data-tour="dashboard-helpdesk" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <LifeBuoy className="h-4 w-4 text-[#C43E3E]" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Help Desk
              </h2>
            </div>
            {allowedPages.has("help-desk") ? (
              <Link
                href="/help-desk"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                Open inbox
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="My Open Tickets"
              value={formatNumber(myAssignedOpen)}
              detail={`${formatNumber(myTodoTickets)} need agent action`}
              icon={LifeBuoy}
              href={allowedPages.has("help-desk") ? "/help-desk" : undefined}
            />
            <MetricCard
              title="Team Open"
              value={formatNumber(teamOpenTickets)}
              detail="Active buyer conversations"
              icon={Gauge}
              tone={teamOpenTickets > 50 ? "warn" : "neutral"}
              href={allowedPages.has("help-desk") ? "/help-desk" : undefined}
            />
            <MetricCard
              title="SLA Watch"
              value={formatNumber(slaAtRisk)}
              detail="Open tickets amber or red"
              icon={Timer}
              tone={slaAtRisk > 0 ? "warn" : "good"}
              href={allowedPages.has("help-desk") ? "/help-desk" : undefined}
            />
            <MetricCard
              title="My Last 24h"
              value={formatNumber(myOutboundLast24h)}
              detail={`${formatNumber(myResolvedLast24h)} resolved by you`}
              icon={CheckCircle2}
              tone="good"
              href={allowedPages.has("help-desk") ? "/help-desk" : undefined}
            />
          </div>
        </section>

        <section data-tour="dashboard-tasks" className="grid gap-3 lg:grid-cols-3">
          <MetricCard
            title="My Tasks"
            value={formatNumber(myOpenTasks)}
            detail={`${formatNumber(myOverdueTasks)} overdue`}
            icon={ClipboardList}
            tone={myOverdueTasks > 0 ? "warn" : "neutral"}
            href={allowedPages.has("tasks") ? "/tasks" : undefined}
          />
          <MetricCard
            title="Shared Team Tasks"
            value={formatNumber(sharedOpenTasks)}
            detail="Open shared work items"
            icon={Activity}
            href={allowedPages.has("tasks") ? "/tasks" : undefined}
          />
          <MetricCard
            title="Catalog Access"
            value={allowedPages.has("catalog") ? "On" : "Locked"}
            detail={
              allowedPages.has("catalog")
                ? "Catalog grid is available"
                : "Not in this user's allow list"
            }
            icon={TableProperties}
            tone={allowedPages.has("catalog") ? "good" : "warn"}
            href={allowedPages.has("catalog") ? "/catalog" : undefined}
          />
        </section>

        <section
          data-tour="dashboard-ops"
          className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]"
        >
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-[#C43E3E]" />
                  <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Sync Pulse
                  </h2>
                </div>
                <p className="mt-3 text-2xl font-semibold text-foreground">
                  {formatRelative(schedulerLastTick)}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Last scheduler tick at {formatDateTime(schedulerLastTick)}
                </p>
              </div>
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium",
                  schedulerOutcome === "error"
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                )}
              >
                {schedulerOutcome ?? "unknown"}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="border-l border-border pl-3">
                <p className="text-xs text-muted-foreground">Due</p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {formatNumber(schedulerDueCount ?? 0)}
                </p>
              </div>
              <div className="border-l border-border pl-3">
                <p className="text-xs text-muted-foreground">Dispatched</p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {formatNumber(schedulerDispatchedCount ?? 0)}
                </p>
              </div>
              <div className="border-l border-border pl-3">
                <p className="text-xs text-muted-foreground">Queued/Running</p>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {formatNumber(queuedOrRunningSyncs)}
                </p>
              </div>
            </div>
            {schedulerError ? (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Latest scheduler tick reported an error. Review Sync or
                  Engine Room if your account has access.
                </span>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[#C43E3E]" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Last 24h
              </h2>
            </div>
            <p className="mt-3 text-2xl font-semibold text-foreground">
              {formatNumber(recentFailedSyncs)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Failed sync jobs in the last 24 hours.
            </p>
            {allowedPages.has("sync") ? (
              <Link
                href="/sync"
                className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
              >
                Review sync
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
          </div>
        </section>

        {quickLinks.length > 0 ? (
          <section data-tour="dashboard-quick-links" className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Quick Links
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {quickLinks.map((page) => (
                <Link
                  key={page.key}
                  href={page.href}
                  className="group flex min-h-[96px] flex-col justify-between rounded-lg border border-border bg-card p-4 text-sm text-foreground hover:bg-muted/60"
                >
                  <span className="font-medium">{page.label}</span>
                  <span className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="line-clamp-2">{page.description}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <PageTour page="dashboard" steps={PAGE_TOUR_STEPS.dashboard} ready />
    </main>
  );
}
