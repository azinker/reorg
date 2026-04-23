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
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  Inbox,
  FolderPlus,
  Folder,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { HelpdeskFolderKey } from "@/hooks/use-helpdesk";

export interface AgentFolderData {
  id: string;
  name: string;
  color: string;
  ticketCount: number;
  createdBy: { id: string; name: string | null; email: string };
}

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
   * When set, double-indents the row (grandchild). Used for the "Unread" and
   * "Awaiting Reply" sub-buckets under "To Do".
   */
  grandchild?: boolean;
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
      "Tickets needing an agent reply — every unanswered buyer message lives here. The two sub-buckets split them by read status so agents can focus on truly unread mail first.",
    child: true,
    helpDetail:
      "To Do is every ticket where the buyer had the last word and you haven't replied yet. The two sub-buckets split the queue: 'Unread' is the count that mirrors eBay's own 'Unread from members' badge (buyer messages you haven't even opened yet). 'Awaiting Reply' is tickets you've read but haven't answered. Opening a ticket auto-marks it read and moves it from Unread → Awaiting Reply; sending your reply moves it out of To Do entirely.",
  },
  {
    key: "all_to_do_unread",
    label: "Unread",
    tooltip:
      "Unread buyer messages — matches eBay's own 'Unread from members' count. This is the one you watch. Opening a ticket auto-marks it read and flips it to Awaiting Reply.",
    child: true,
    grandchild: true,
  },
  {
    key: "all_to_do_awaiting",
    label: "Awaiting Reply",
    tooltip:
      "Read buyer messages you still owe a response to. Not scary like Unread — but don't let this pile up.",
    child: true,
    grandchild: true,
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
// Cancel Requests is the parent; "From eBay" sits underneath it as an
// indented child (same visual treatment as To Do / Waiting under All Tickets).
// Both folders are now hardcoded, not user-filter-driven:
//   - Cancel Requests is keyed off the BUYER_CANCELLATION_TAG_NAME tag, which
//     the sync stamps automatically when `detectCancellationRequest` matches.
//   - From eBay is keyed off `type=SYSTEM`, stamped by `detectFromEbay`.
const PINNED_TAGS: FolderRow[] = [
  {
    key: "buyer_cancellation",
    label: "Cancel Requests",
    icon: Ban,
    tooltip:
      "Tickets where the buyer asked to cancel an order. Auto-routed by hardcoded sync logic (no user filter required). Hidden from All Tickets / To Do / Waiting so they don't dilute the main inbox — handle them fast to avoid forced cancellations.",
    iconAccent: "text-rose-500",
  },
  {
    key: "from_ebay",
    label: "From eBay",
    icon: Inbox,
    tooltip:
      "Notifications eBay sent us itself — not buyer messages. Examples: Return Approved, Item Delivered, Buyer Shipped Item, Case Closed, We Sent Your Payout. Auto-routed by hardcoded sync logic. Use the chips above the table to filter by event type.",
    child: true,
    iconAccent: "text-sky-500",
    helpDetail:
      "Anything eBay's bookkeeping system sends us (NOT a buyer message) lands here automatically. The sync inspects the message's sender, subject, and body to stamp `type=SYSTEM` plus a sub-type like RETURN_APPROVED or ITEM_DELIVERED. From-eBay tickets are excluded from All Tickets / To Do / Waiting so the main inbox stays focused on buyer mail. Inside this folder, use the chips above the table to drill into a single event type.",
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
  isAdmin?: boolean;
  agentFolders: AgentFolderData[];
  activeAgentFolderId: string | null;
  onAgentFolderSelect: (folderId: string) => void;
  onAgentFolderCreate: (name: string, color: string) => Promise<void>;
  onAgentFolderDelete: (folderId: string) => Promise<void>;
  onAgentFolderRename: (folderId: string, name: string) => Promise<void>;
}

export function FolderSidebar({
  active,
  counts,
  onChange,
  channelFilter,
  onChannelChange,
  isAdmin = false,
  agentFolders,
  activeAgentFolderId,
  onAgentFolderSelect,
  onAgentFolderCreate,
  onAgentFolderDelete,
  onAgentFolderRename,
}: FolderSidebarProps) {
  const [tagsOpen, setTagsOpen] = useState(true);
  const [agentFoldersOpen, setAgentFoldersOpen] = useState(true);

  // Hydrate persisted collapse state on mount. We do this in an effect to
  // avoid SSR/CSR markup mismatches (localStorage is client-only).
  useEffect(() => {
    setTagsOpen(readBool(TAGS_OPEN_KEY, true));
    setAgentFoldersOpen(readBool("helpdesk.sidebar.agentFoldersOpen", true));
  }, []);

  function toggleTags() {
    setTagsOpen((prev) => {
      const next = !prev;
      writeBool(TAGS_OPEN_KEY, next);
      return next;
    });
  }

  function toggleAgentFolders() {
    setAgentFoldersOpen((prev) => {
      const next = !prev;
      writeBool("helpdesk.sidebar.agentFoldersOpen", next);
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
              active={active === f.key && !activeAgentFolderId}
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
            active={active === ALL_PARENT.key && !activeAgentFolderId}
            count={counts[ALL_PARENT.key] ?? 0}
            onSelect={onChange}
          />
          {ALL_CHILDREN.map((f) => (
            <FolderItem
              key={f.key}
              row={f}
              active={active === f.key && !activeAgentFolderId}
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
              active={active === f.key && !activeAgentFolderId}
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
                  active={active === f.key && !activeAgentFolderId}
                  count={counts[f.key] ?? 0}
                  onSelect={(k) => { onChange(k); }}
                />
              ))}
            </ul>
          ) : null}
        </div>

        {/* Section E: Agent Folders — user-created folders */}
        <div className="mt-2">
          <SectionDisclosure
            label="Agent Folders"
            icon={FolderPlus}
            open={agentFoldersOpen}
            onToggle={toggleAgentFolders}
          />
          {agentFoldersOpen ? (
            <AgentFoldersSection
              folders={agentFolders}
              activeId={activeAgentFolderId}
              onSelect={onAgentFolderSelect}
              onCreate={onAgentFolderCreate}
              onDelete={onAgentFolderDelete}
              onRename={onAgentFolderRename}
            />
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
          // Grandchild rows (Unread / Awaiting Reply under To Do) nest one
          // level deeper with a smaller, muted label so the hierarchy reads
          // at a glance without relying on vertical tree glyphs.
          row.grandchild ? "pl-12 pr-2 text-[12px]" : "",
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
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Recompute position whenever the popover is opened. Using fixed positioning
  // anchored to the trigger button's viewport rect lets the tooltip escape the
  // sidebar's `overflow-y: auto` clipping, which previously hid it behind the
  // adjacent panel.
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setCoords({
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    });
  }, [open]);

  return (
    <span
      className="relative inline-flex"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={buttonRef}
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
      {open && mounted && coords
        ? createPortal(
            <span
              role="tooltip"
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                transform: "translateY(-50%)",
              }}
              className="z-[100] w-72 rounded-md border border-hairline bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg pointer-events-none"
            >
              {detail}
            </span>,
            document.body,
          )
        : null}
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

// ── Agent Folders section ─────────────────────────────────────────────────

const COLOR_OPTIONS = [
  { value: "violet", cls: "bg-violet-500" },
  { value: "blue", cls: "bg-blue-500" },
  { value: "emerald", cls: "bg-emerald-500" },
  { value: "amber", cls: "bg-amber-500" },
  { value: "rose", cls: "bg-rose-500" },
  { value: "sky", cls: "bg-sky-500" },
  { value: "orange", cls: "bg-orange-500" },
  { value: "teal", cls: "bg-teal-500" },
  { value: "pink", cls: "bg-pink-500" },
  { value: "indigo", cls: "bg-indigo-500" },
] as const;

const FOLDER_COLOR_TEXT: Record<string, string> = {
  violet: "text-violet-500",
  blue: "text-blue-500",
  emerald: "text-emerald-500",
  amber: "text-amber-500",
  rose: "text-rose-500",
  sky: "text-sky-500",
  orange: "text-orange-500",
  teal: "text-teal-500",
  pink: "text-pink-500",
  indigo: "text-indigo-500",
};

interface AgentFoldersSectionProps {
  folders: AgentFolderData[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, color: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

function AgentFoldersSection({
  folders,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: AgentFoldersSectionProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("violet");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    await onCreate(trimmed, newColor);
    setNewName("");
    setNewColor("violet");
    setCreating(false);
  }, [newName, newColor, onCreate]);

  const handleRename = useCallback(async (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed) { setEditingId(null); return; }
    await onRename(id, trimmed);
    setEditingId(null);
  }, [editName, onRename]);

  return (
    <div className="mt-0.5">
      <ul className="space-y-0.5">
        {folders.map((f) => {
          const isActive = activeId === f.id;
          const isEditing = editingId === f.id;
          const colorCls = FOLDER_COLOR_TEXT[f.color] ?? "text-violet-500";
          return (
            <li key={f.id} className="group/agfolder relative">
              {isEditing ? (
                <div className="flex items-center gap-1 pl-7 pr-2 py-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(f.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-brand/60"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => handleRename(f.id)}
                    className="text-emerald-500 hover:text-emerald-400 cursor-pointer"
                    title="Save"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(f.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md pl-7 pr-2 py-1.5 text-left text-sm transition-colors cursor-pointer",
                    isActive
                      ? "bg-brand-muted text-brand"
                      : "text-foreground hover:bg-surface-2",
                  )}
                >
                  <Folder className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-brand" : colorCls)} />
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.ticketCount > 0 ? (
                    <span
                      className={cn(
                        "text-[11px] tabular-nums",
                        isActive ? "text-brand" : "text-muted-foreground",
                      )}
                    >
                      {f.ticketCount}
                    </span>
                  ) : null}
                  <span className="hidden items-center gap-0.5 group-hover/agfolder:flex">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(f.id);
                        setEditName(f.name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          setEditingId(f.id);
                          setEditName(f.name);
                        }
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                      title="Rename folder"
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(f.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          onDelete(f.id);
                        }
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-red-500 cursor-pointer"
                      title="Delete folder"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {creating ? (
        <div className="mt-1 space-y-1.5 pl-7 pr-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Folder name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setCreating(false); setNewName(""); }
            }}
            className="w-full rounded border border-hairline bg-surface px-2 py-1 text-xs text-foreground outline-none focus:border-brand/60"
          />
          <div className="flex flex-wrap gap-1">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setNewColor(c.value)}
                className={cn(
                  "h-4 w-4 rounded-full transition-all cursor-pointer",
                  c.cls,
                  newColor === c.value
                    ? "ring-2 ring-white ring-offset-1 ring-offset-card"
                    : "opacity-50 hover:opacity-100",
                )}
                title={c.value}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="rounded bg-brand px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40 cursor-pointer"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(""); }}
              className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-md pl-7 pr-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
        >
          <FolderPlus className="h-3 w-3" />
          <span>New folder</span>
        </button>
      )}
    </div>
  );
}
