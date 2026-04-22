"use client";

/**
 * eDesk-style folder sidebar.
 *
 * Visual grammar (matches eDesk's Mailbox pane exactly):
 *
 *   ─────────────────────────
 *   Channel chips (TPP / TT / All)
 *   ─────────────────────────
 *   Pre-sales                ←  primary system folder
 *   My Tickets               ←  agent-scoped folder
 *
 *   All Tickets              ←  always-visible parent. Clicking selects the
 *      New                       union view. Children render directly below as
 *      To Do                     indented plain-text rows (no icon, count
 *      Waiting                   right-aligned). No chevron — they're always
 *                                shown so the agent can pivot quickly.
 *
 *   Cancel Requests          ←  pinned tag-backed folder
 *
 *   ▼ Tags                   ←  collapsible (other tag-backed views)
 *      Snoozed
 *      Resolved
 *      Unassigned
 *      @ Mentioned
 *      Favorites
 *      Spam
 *      Archived
 *   ─────────────────────────
 *   Filters
 *   My Profile
 *   Global Settings (admin)
 *
 * The Tags drawer's collapse state is persisted in localStorage so an agent
 * doesn't have to re-expand it every reload. The All Tickets children are
 * intentionally always-shown to match eDesk and avoid an extra click.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  User,
  ListChecks,
  Sparkles,
  PauseCircle,
  CheckCircle2,
  UserX,
  AtSign,
  Star,
  AlertOctagon,
  Archive,
  Tags,
  Filter as FilterIcon,
  UserCircle2,
  ShieldCheck,
  Ban,
  ChevronDown,
  ChevronRight,
  HelpCircle,
} from "lucide-react";
import type { HelpdeskFolderKey } from "@/hooks/use-helpdesk";

interface FolderRow {
  key: HelpdeskFolderKey;
  label: string;
  /**
   * Optional row icon. eDesk omits icons on indented children (New / To Do /
   * Waiting under All Tickets) so we make this optional rather than required.
   */
  icon?: React.ComponentType<{ className?: string }>;
  tooltip: string;
  /** When true, the row renders with the indented "child" treatment. */
  child?: boolean;
  /**
   * Optional Tailwind text color class for the icon when the row is NOT
   * active. Lets us color each folder distinctly (Pre-sales = sparkle yellow,
   * Resolved = green, Spam = red) instead of every icon being the same brand
   * red, which makes scanning the sidebar much faster. Defaults to
   * "text-brand" for parity with the original look.
   */
  iconAccent?: string;
  /**
   * Optional richer explanation surfaced as a click/hover popover next to
   * the label. Used for folders whose semantics aren't obvious from the
   * name alone (Waiting, Resolved) — agents kept asking what gets routed
   * where, so we expose the rules inline instead of burying them in docs.
   */
  helpDetail?: string;
}

// ── Section A: pinned/primary folders shown at the very top ────────────────
const PRIMARY: FolderRow[] = [
  {
    key: "pre_sales",
    label: "Pre-sales",
    icon: Sparkles,
    tooltip:
      "Buyer questions before a purchase. Higher priority — these often convert when answered fast.",
    iconAccent: "text-amber-500",
  },
  {
    key: "my_tickets",
    label: "My Tickets",
    icon: User,
    tooltip:
      "Tickets where YOU are the assigned owner. You picked these up or they were assigned to you specifically — your queue.",
    iconAccent: "text-violet-500",
  },
];

// ── Section B: "All Tickets" parent + always-visible status children ───────
const ALL_PARENT: FolderRow = {
  key: "all_tickets",
  label: "All Tickets",
  icon: ListChecks,
  tooltip:
    "Every active ticket across the team, regardless of assignee or status. The New / To Do / Waiting rows below filter this view by triage status.",
  iconAccent: "text-sky-500",
};
// Children of "All Tickets". Rendered as indented plain-text rows with no
// icon and a right-aligned count, matching eDesk exactly. The folder icons
// are intentionally dropped because the visual hierarchy (indent + parent's
// icon above) already conveys the grouping; adding icons here just adds
// noise and makes the column look "busy".
// v2 sidebar: NEW is folded into TO_DO, so the inbox surfaces a single
// "needs response" bucket. The legacy `all_new` folder key still resolves
// to the same query (kept in folders.ts for back-compat with any saved
// links), but we no longer render it as its own row — duplicate counts
// would just confuse the agent.
const ALL_CHILDREN: FolderRow[] = [
  {
    key: "all_to_do",
    label: "To Do",
    tooltip:
      "Tickets needing an agent reply — every unanswered buyer message lives here, brand-new or follow-up.",
    child: true,
  },
  {
    key: "all_waiting",
    label: "Waiting",
    tooltip: "Replied to the buyer — waiting for them to respond.",
    child: true,
    helpDetail:
      "A ticket lands in Waiting when the LAST message in the thread is from an agent (a reply or external email) and the ticket isn't archived/resolved/spam. As soon as the buyer replies it bounces back to To Do. Use this folder to scan for stalled conversations where the buyer hasn't come back to you.",
  },
];

// ── Section C: pinned tag-backed folder above the Tags drawer ──────────────
const PINNED_TAGS: FolderRow[] = [
  {
    key: "buyer_cancellation",
    label: "Cancel Requests",
    icon: Ban,
    tooltip:
      "Tickets routed here by any filter whose action is 'Move to Cancel Requests'. These are hidden from All Tickets / New / To Do / Waiting so they don't dilute the main inbox — handle them fast to avoid forced cancellations.",
    iconAccent: "text-rose-500",
  },
];

// ── Section D: Tags drawer — system / state-machine folders ────────────────
const TAGS_GROUP: FolderRow[] = [
  {
    key: "snoozed",
    label: "Snoozed",
    icon: PauseCircle,
    tooltip:
      "Hidden until a chosen wake-up time, then reappear in their original folder.",
    child: true,
    iconAccent: "text-indigo-500",
  },
  {
    key: "resolved",
    label: "Resolved",
    icon: CheckCircle2,
    tooltip:
      "Closed conversations. Tickets land here when an agent marks them resolved or when an outbound reply was the last word in the thread.",
    child: true,
    iconAccent: "text-emerald-500",
    helpDetail:
      "Resolved is the closed-conversation bucket. Tickets get here three ways: (1) an agent picks 'Send + Resolve' on a reply, (2) an agent clicks Resolve on the ticket header, or (3) the nightly auto-resolve sweeps tickets where the agent had the last word and the buyer never came back. If the buyer DOES reply later, the ticket bounces back to To Do automatically — Resolved is reversible, not destructive.",
  },
  {
    key: "unassigned",
    label: "Unassigned",
    icon: UserX,
    tooltip:
      "Active tickets with no owner. Pick one up by assigning yourself.",
    child: true,
    iconAccent: "text-zinc-400",
  },
  {
    key: "mentioned",
    label: "@ Mentioned",
    icon: AtSign,
    tooltip:
      "Tickets where another agent typed @your-handle in an internal note. Use this to follow conversations you've been pulled into without being the assignee.",
    child: true,
    iconAccent: "text-violet-500",
  },
  {
    key: "favorites",
    label: "Favorites",
    icon: Star,
    tooltip:
      "Tickets any agent has starred from the per-ticket header bar. Team-wide — useful for keeping VIP buyers, escalations, or weird edge cases handy without changing their folder.",
    child: true,
    iconAccent: "text-amber-400",
  },
  {
    key: "spam",
    label: "Spam",
    icon: AlertOctagon,
    tooltip:
      "Marked as spam by an agent or a filter. Hidden from the main inbox.",
    child: true,
    iconAccent: "text-red-500",
  },
  {
    key: "archived",
    label: "Archived",
    icon: Archive,
    tooltip:
      "Manually archived or auto-archived by a filter (e.g. shipping confirmations). Stored permanently — never deleted.",
    child: true,
    iconAccent: "text-slate-400",
  },
];

// localStorage key for the collapse state of the Tags drawer. Defaulted
// to expanded on first load (matches eDesk's own out-of-the-box behaviour).
// All Tickets is intentionally NOT collapsible — eDesk shows New / To Do /
// Waiting permanently underneath, so we do too.
const TAGS_OPEN_KEY = "helpdesk.sidebar.tagsOpen";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage unavailable (privacy mode) — silent fallback.
  }
}

interface FolderSidebarProps {
  active: HelpdeskFolderKey;
  counts: Partial<Record<HelpdeskFolderKey, number>>;
  onChange: (folder: HelpdeskFolderKey) => void;
  channelFilter: "TPP_EBAY" | "TT_EBAY" | "ALL";
  onChannelChange: (channel: "TPP_EBAY" | "TT_EBAY" | "ALL") => void;
  /**
   * When true, renders an extra "Global Settings" link in the bottom nav row
   * that points at /help-desk/global-settings (Safe Mode, sync controls,
   * write locks, retro auto-resolve). Hidden for non-admins so we don't tease
   * features they can't use.
   */
  isAdmin?: boolean;
}

export function FolderSidebar({
  active,
  counts,
  onChange,
  channelFilter,
  onChannelChange,
  isAdmin = false,
}: FolderSidebarProps) {
  const [tagsOpen, setTagsOpen] = useState(true);

  // Hydrate persisted collapse state on mount. We do this in an effect to
  // avoid SSR/CSR markup mismatches (localStorage is client-only).
  useEffect(() => {
    setTagsOpen(readBool(TAGS_OPEN_KEY, true));
  }, []);

  function toggleTags() {
    setTagsOpen((prev) => {
      const next = !prev;
      writeBool(TAGS_OPEN_KEY, next);
      return next;
    });
  }

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-r border-hairline bg-card">
      <div className="border-b border-hairline px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Help Desk</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          eBay member messages
        </p>
      </div>

      <div className="border-b border-hairline px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Tags className="h-3 w-3" /> Channel
        </div>
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          {(["ALL", "TPP_EBAY", "TT_EBAY"] as const).map((ch) => {
            // Match the table's channel column color language so muscle
            // memory transfers between sidebar and grid: TPP = violet,
            // TT = emerald, ALL stays brand.
            const activeCls =
              ch === "TPP_EBAY"
                ? "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : ch === "TT_EBAY"
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "border-brand/40 bg-brand-muted text-brand";
            return (
              <button
                key={ch}
                type="button"
                onClick={() => onChannelChange(ch)}
                className={cn(
                  "rounded-md border px-1.5 py-1 font-medium transition-colors cursor-pointer",
                  channelFilter === ch
                    ? activeCls
                    : "border-hairline bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground",
                )}
              >
                {ch === "ALL" ? "All" : ch === "TPP_EBAY" ? "TPP" : "TT"}
              </button>
            );
          })}
        </div>
      </div>

      <nav
        className="flex-1 overflow-y-auto p-2 text-sm"
        aria-label="Help Desk folders"
      >
        {/* Section A: primary folders */}
        <ul className="space-y-0.5">
          {PRIMARY.map((f) => (
            <FolderItem
              key={f.key}
              row={f}
              active={active === f.key}
              count={counts[f.key] ?? 0}
              onSelect={onChange}
            />
          ))}
        </ul>

        {/* Section B: All Tickets — parent + always-visible status children.
         *
         * eDesk shows All Tickets as a regular folder row with New / To Do /
         * Waiting indented permanently underneath (no chevron, no collapse).
         * The children render as plain-text rows with the count right-aligned,
         * relying on indentation alone to show the parent/child relationship.
         * Matching that exactly here keeps muscle memory consistent for
         * agents who flip between eDesk and reorg. */}
        <ul className="mt-2 space-y-0.5">
          <FolderItem
            row={ALL_PARENT}
            active={active === ALL_PARENT.key}
            count={counts[ALL_PARENT.key] ?? 0}
            onSelect={onChange}
          />
          {ALL_CHILDREN.map((f) => (
            <FolderItem
              key={f.key}
              row={f}
              active={active === f.key}
              count={counts[f.key] ?? 0}
              onSelect={onChange}
            />
          ))}
        </ul>

        {/* Section C: pinned tag-backed folders */}
        <ul className="mt-2 space-y-0.5">
          {PINNED_TAGS.map((f) => (
            <FolderItem
              key={f.key}
              row={f}
              active={active === f.key}
              count={counts[f.key] ?? 0}
              onSelect={onChange}
            />
          ))}
        </ul>

        {/* Section D: Tags drawer — system / state machine folders */}
        <div className="mt-2">
          <SectionDisclosure
            label="Tags"
            icon={Tags}
            open={tagsOpen}
            onToggle={toggleTags}
          />
          {tagsOpen ? (
            <ul className="mt-0.5 space-y-0.5">
              {TAGS_GROUP.map((f) => (
                <FolderItem
                  key={f.key}
                  row={f}
                  active={active === f.key}
                  count={counts[f.key] ?? 0}
                  onSelect={onChange}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </nav>

      <div className="mt-auto border-t border-hairline p-2 text-sm">
        <Link
          href="/help-desk/filters"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors hover:bg-surface-2"
          title="Manage inbox rules — auto-archive, auto-tag, etc."
        >
          <FilterIcon className="h-3.5 w-3.5 shrink-0 text-violet-500" />
          <span>Filters</span>
        </Link>
        <Link
          href="/help-desk/profile"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors hover:bg-surface-2"
          title="Your agent profile — name, handle, avatar, signature."
        >
          <UserCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span>My Profile</span>
        </Link>
        {isAdmin ? (
          <Link
            href="/help-desk/global-settings"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-foreground transition-colors hover:bg-surface-2"
            title="Admin only — Safe Mode, sync schedule, write locks, retro auto-resolve."
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-brand" />
            <span>Global Settings</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ── Internal pieces ────────────────────────────────────────────────────────

interface FolderItemProps {
  row: FolderRow;
  active: boolean;
  count: number;
  onSelect: (key: HelpdeskFolderKey) => void;
}

function FolderItem({ row, active, count, onSelect }: FolderItemProps) {
  const Icon = row.icon;
  // Indented children (New / To Do / Waiting under All Tickets) render in
  // eDesk's plain-text style: no icon, lighter weight, and a right-aligned
  // count rendered as plain text rather than a pill. Parent / top-level
  // rows keep the icon + pill treatment they've always had.
  const isPlainChild = row.child && !Icon;
  // The helpDetail popover lives next to the row (not inside the button)
  // so hovering the (?) doesn't fight the row's hover background. We use
  // an outer relative wrapper and a sibling button sibling-to-the-anchor
  // pattern: that way the popover is keyboard-accessible (focus on the
  // anchor reveals it) without trapping clicks on the folder itself.
  return (
    <li className="group/folder relative">
      <button
        type="button"
        onClick={() => onSelect(row.key)}
        title={row.tooltip}
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm transition-colors cursor-pointer",
          isPlainChild ? "pl-8 pr-2 font-normal" : "px-2 font-medium",
          row.child && Icon ? "pl-7 pr-2" : "",
          active
            ? "bg-brand-muted text-brand"
            : "text-foreground hover:bg-surface-2",
        )}
      >
        {Icon ? (
          <Icon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              // When active, force brand color so the icon visually merges
              // with the brand-tinted active row. When inactive, fall back
              // to per-row accent (so Resolved is green, Spam is red, etc.)
              // and finally text-brand if no accent was specified.
              active ? "text-brand" : (row.iconAccent ?? "text-brand"),
            )}
          />
        ) : null}
        <span className="flex-1 truncate">{row.label}</span>
        {row.helpDetail ? <FolderHelpAffordance detail={row.helpDetail} label={row.label} /> : null}
        {count > 0 ? (
          isPlainChild ? (
            <span
              className={cn(
                "text-[11px] tabular-nums",
                active ? "text-brand" : "text-muted-foreground",
              )}
            >
              {count}
            </span>
          ) : (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                active
                  ? "bg-brand/20 text-brand"
                  : "bg-surface-2 text-muted-foreground",
              )}
            >
              {count}
            </span>
          )
        ) : null}
      </button>
    </li>
  );
}

interface FolderHelpAffordanceProps {
  detail: string;
  label: string;
}

/**
 * Inline (?) icon that reveals a popover explaining the folder's routing
 * rules. Click toggles, blur closes — keeps it keyboard-accessible without
 * pulling in a popover library. We stop click propagation so tapping the
 * icon doesn't also navigate to the folder.
 */
function FolderHelpAffordance({ detail, label }: FolderHelpAffordanceProps) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={`What is the ${label} folder?`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-surface-2 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-brand/40 cursor-help"
      >
        <HelpCircle className="h-3 w-3" />
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-full top-1/2 z-30 ml-2 w-72 -translate-y-1/2 rounded-md border border-hairline bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg"
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}

interface SectionDisclosureProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  open: boolean;
  onToggle: () => void;
}

/**
 * "Tags" section header — a non-selectable disclosure. Clicking anywhere on
 * the row toggles the disclosure since there's no folder behind the label.
 */
function SectionDisclosure({
  label,
  icon: Icon,
  open,
  onToggle,
}: SectionDisclosureProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
    >
      {open ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
      <Icon className="h-3 w-3" />
      <span className="flex-1">{label}</span>
    </button>
  );
}
