"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  MessageSquareText,
  Plus,
  Power,
  PowerOff,
  Copy,
  Trash2,
  Pencil,
  Eye,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Pause,
  Play,
  Search,
  Send,
  Bug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Platform } from "@prisma/client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ResponderRow {
  id: string;
  messageName: string;
  channel: Platform;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED" | "INVALID";
  activatedAt: string | null;
  updatedAt: string;
  createdAt: string;
  integrationLabel: string;
  integrationEnabled: boolean;
  totalSent: number;
  totalFailures: number;
  lastSent: string | null;
}

interface LogRow {
  id: string;
  orderNumber: string;
  channel: Platform;
  eventType: string;
  source: string;
  status: string | null;
  reason: string | null;
  renderedSubject: string | null;
  renderedBody: string | null;
  createdAt: string;
  responder?: { messageName: string } | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  TPP_EBAY: "eBay TPP",
  TT_EBAY: "eBay TT",
};

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  INACTIVE: "bg-white/10 text-white/60 border-white/20",
  ARCHIVED: "bg-white/5 text-white/30 border-white/10",
  INVALID: "bg-red-500/20 text-red-300 border-red-500/30",
};

const EVENT_STYLES: Record<string, string> = {
  SENT: "text-emerald-400",
  FAILED: "text-red-400",
  QUEUED: "text-blue-400",
  SKIPPED: "text-amber-400",
  DUPLICATE_PREVENTED: "text-amber-300",
  NO_ACTIVE_RESPONDER: "text-white/40",
  PREVIEW: "text-cyan-400",
  TEST_SEND: "text-purple-400",
  INTEGRATION_DISABLED: "text-red-300",
  RESPONDER_AUTO_DISABLED: "text-red-300",
};

function formatDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function AutoResponderPage() {
  const [tab, setTab] = useState<"responders" | "logs">("responders");

  return (
    <div className="flex flex-col gap-6 px-6 py-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center gap-3">
        <MessageSquareText className="h-6 w-6 text-white/60 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-white">Auto Responder</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Automatically send eBay messages to buyers after their orders are shipped.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-white/10">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("responders")}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
              tab === "responders" ? "text-white border-b-2 border-white" : "text-white/50 hover:text-white/80",
            )}
          >
            Responders
          </button>
          <button
            onClick={() => setTab("logs")}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
              tab === "logs" ? "text-white border-b-2 border-white" : "text-white/50 hover:text-white/80",
            )}
          >
            Logs
          </button>
        </div>
        <a
          href="/api/auto-responder/debug"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          title="View debug endpoint (JSON)"
        >
          <Bug className="h-3 w-3" />
          Debug
        </a>
      </div>

      {tab === "responders" ? <RespondersTab /> : <LogsTab />}
    </div>
  );
}

// ─── Responders Tab ──────────────────────────────────────────────────────────

function RespondersTab() {
  const [responders, setResponders] = useState<ResponderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [killSwitchPaused, setKillSwitchPaused] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (channelFilter !== "all") qs.set("channel", channelFilter);
      if (showArchived) qs.set("showArchived", "true");
      const res = await fetch(`/api/auto-responder?${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      setResponders(json.data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [channelFilter, showArchived]);

  const loadKillSwitch = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-responder/kill-switch");
      if (res.ok) {
        const json = await res.json();
        setKillSwitchPaused(json.data.paused);
      }
    } catch { /* ignore for non-admins */ }
  }, []);

  useEffect(() => { void load(); void loadKillSwitch(); }, [load, loadKillSwitch]);

  async function handleAction(id: string, action: "activate" | "deactivate" | "duplicate" | "archive") {
    setActionLoading(id);
    try {
      const url = action === "archive"
        ? `/api/auto-responder/${id}`
        : `/api/auto-responder/${id}/${action}`;
      const method = action === "archive" ? "DELETE" : "POST";
      const res = await fetch(url, { method });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Failed to ${action}`);
        return;
      }
      void load();
    } catch {
      setError(`Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function toggleKillSwitch() {
    setKillSwitchLoading(true);
    try {
      const res = await fetch("/api/auto-responder/kill-switch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !killSwitchPaused }),
      });
      if (res.ok) {
        const json = await res.json();
        setKillSwitchPaused(json.data.paused);
      }
    } catch { /* ignore */ }
    finally { setKillSwitchLoading(false); }
  }

  const activeCount = responders.filter((r) => r.status === "ACTIVE").length;

  // Sort: active pinned to top, then by updatedAt desc
  const sorted = [...responders].sort((a, b) => {
    if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
    if (b.status === "ACTIVE" && a.status !== "ACTIVE") return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {["all", "TPP_EBAY", "TT_EBAY"].map((ch) => (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer",
                channelFilter === ch ? "bg-white/15 text-white" : "bg-white/5 text-white/50 hover:text-white/80",
              )}
            >
              {ch === "all" ? "All" : CHANNEL_LABELS[ch]}
            </button>
          ))}

          <label className="flex items-center gap-1.5 text-xs text-white/40 ml-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-white/20"
            />
            Show Archived
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={toggleKillSwitch}
            disabled={killSwitchLoading}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer",
              killSwitchPaused
                ? "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30"
                : "bg-white/5 text-white/50 hover:text-white/80",
            )}
          >
            {killSwitchPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {killSwitchPaused ? "Resume All" : "Emergency Pause"}
          </button>

          <Link
            href="/auto-responder/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer"
          >
            <Plus className="h-3 w-3" />
            New Responder
          </Link>
        </div>
      </div>

      {killSwitchPaused && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Auto Responder is paused. No new messages will be sent until resumed.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <p className="text-xs text-white/30">
        A shipped auto-response will only ever be sent once per order number per channel.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-white/30" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12 text-white/40 text-sm">
          No responders yet.{" "}
          <Link href="/auto-responder/new" className="text-white/70 underline hover:text-white">
            Create one
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs text-white/40 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Activated</th>
                <th className="px-4 py-3 font-medium">Last Sent</th>
                <th className="px-4 py-3 font-medium text-right">Sent</th>
                <th className="px-4 py-3 font-medium text-right">Failed</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03] transition-colors">
                  <td className="px-4 py-3 text-white/90 font-medium">{r.messageName}</td>
                  <td className="px-4 py-3">
                    <span className="text-white/60 text-xs">{CHANNEL_LABELS[r.channel] ?? r.channel}</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      {r.integrationEnabled ? (
                        <ShieldCheck className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <ShieldOff className="h-3 w-3 text-red-400" />
                      )}
                      <span className="text-[10px] text-white/30">{r.integrationEnabled ? "Connected" : "Disconnected"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium", STATUS_STYLES[r.status])}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-white/40">{formatDate(r.activatedAt)}</td>
                  <td className="px-4 py-3 text-xs text-white/40">{formatDate(r.lastSent)}</td>
                  <td className="px-4 py-3 text-right text-xs text-emerald-400 tabular-nums">{r.totalSent}</td>
                  <td className="px-4 py-3 text-right text-xs text-red-400 tabular-nums">{r.totalFailures}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {r.status !== "ARCHIVED" && (
                        <>
                          <Link
                            href={`/auto-responder/${r.id}/edit`}
                            className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Link>
                          <Link
                            href={`/auto-responder/${r.id}/preview`}
                            className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
                            title="Preview"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            onClick={() => handleAction(r.id, "duplicate")}
                            disabled={actionLoading === r.id}
                            className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40"
                            title="Duplicate"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          {r.status === "ACTIVE" ? (
                            <button
                              onClick={() => handleAction(r.id, "deactivate")}
                              disabled={actionLoading === r.id}
                              className="p-1.5 rounded hover:bg-white/10 text-amber-400 hover:text-amber-300 transition-colors cursor-pointer disabled:opacity-40"
                              title="Deactivate"
                            >
                              <PowerOff className="h-3.5 w-3.5" />
                            </button>
                          ) : r.status === "INACTIVE" ? (
                            <button
                              onClick={() => handleAction(r.id, "activate")}
                              disabled={actionLoading === r.id}
                              className="p-1.5 rounded hover:bg-white/10 text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer disabled:opacity-40"
                              title="Activate"
                            >
                              <Power className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          <button
                            onClick={() => handleAction(r.id, "archive")}
                            disabled={actionLoading === r.id}
                            className="p-1.5 rounded hover:bg-white/10 text-red-400/60 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Testing Area — only visible when all responders are inactive */}
      {activeCount === 0 && !loading && <TestingArea />}
    </div>
  );
}

// ─── Testing Area ────────────────────────────────────────────────────────────

function TestingArea() {
  const [orderNumber, setOrderNumber] = useState("");
  const [responderId, setResponderId] = useState("");
  const [responders, setResponders] = useState<ResponderRow[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dupeConfirm, setDupeConfirm] = useState("");
  const [showDupePrompt, setShowDupePrompt] = useState(false);

  useEffect(() => {
    fetch("/api/auto-responder?showArchived=false")
      .then((r) => r.json())
      .then((j) => setResponders(j.data ?? []))
      .catch(() => {});
  }, []);

  async function handleTestSend(confirmDuplicate = false) {
    if (!orderNumber.trim() || !responderId) return;
    setSending(true);
    setError("");
    setResult(null);
    setShowDupePrompt(false);

    try {
      const res = await fetch("/api/auto-responder/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber: orderNumber.trim(), responderId, confirmDuplicate }),
      });
      const json = await res.json();

      if (res.status === 409 && json.error === "duplicate_warning") {
        setShowDupePrompt(true);
        return;
      }

      if (!res.ok) {
        setError(json.error ?? "Test send failed");
        return;
      }

      setResult(`Test message sent for order ${orderNumber}. Check Logs tab for details.`);
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-purple-300">
        <ShieldAlert className="h-4 w-4" />
        Testing Area — Admin Only
      </div>
      <p className="text-xs text-white/40">
        Send a real test message using a saved responder. Only available when all responders are disabled.
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1">
          <label className="text-xs text-white/50">Order Number</label>
          <input
            type="text"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="e.g. 13-14447-09753"
            className="rounded border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20 w-56"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Responder</label>
          <select
            value={responderId}
            onChange={(e) => setResponderId(e.target.value)}
            className="rounded border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 w-56"
          >
            <option value="">Select responder...</option>
            {responders.filter((r) => r.status !== "ARCHIVED").map((r) => (
              <option key={r.id} value={r.id}>{r.messageName} ({CHANNEL_LABELS[r.channel]})</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => handleTestSend(false)}
          disabled={!orderNumber.trim() || !responderId || sending}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send Test
        </button>
      </div>

      {showDupePrompt && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <p className="text-sm text-amber-300">
            This order already received an auto-response. Type <code className="font-mono bg-white/10 px-1 rounded">SEND_DUPLICATE</code> to confirm:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={dupeConfirm}
              onChange={(e) => setDupeConfirm(e.target.value)}
              placeholder="SEND_DUPLICATE"
              className="rounded border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white font-mono placeholder:text-white/20 w-48"
            />
            <button
              onClick={() => { if (dupeConfirm === "SEND_DUPLICATE") handleTestSend(true); }}
              disabled={dupeConfirm !== "SEND_DUPLICATE" || sending}
              className="px-3 py-1.5 text-sm font-medium rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors cursor-pointer disabled:opacity-40"
            >
              Confirm & Send
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {result && <p className="text-sm text-emerald-400">{result}</p>}
    </div>
  );
}

// ─── Logs Tab ────────────────────────────────────────────────────────────────

function LogsTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("");
  const [orderSearch, setOrderSearch] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page) });
      if (channelFilter) qs.set("channel", channelFilter);
      if (eventTypeFilter) qs.set("eventType", eventTypeFilter);
      if (orderSearch) qs.set("orderNumber", orderSearch);
      const res = await fetch(`/api/auto-responder/logs?${qs}`);
      const json = await res.json();
      if (res.ok) {
        setLogs(json.data.logs);
        setTotal(json.data.total);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [page, channelFilter, eventTypeFilter, orderSearch]);

  useEffect(() => { void load(); }, [load]);

  function handleCsvExport() {
    const qs = new URLSearchParams({ format: "csv" });
    if (channelFilter) qs.set("channel", channelFilter);
    if (eventTypeFilter) qs.set("eventType", eventTypeFilter);
    if (orderSearch) qs.set("orderNumber", orderSearch);
    window.open(`/api/auto-responder/logs?${qs}`, "_blank");
  }

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <select
            value={channelFilter}
            onChange={(e) => { setChannelFilter(e.target.value); setPage(1); }}
            className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white"
          >
            <option value="">All Channels</option>
            <option value="TPP_EBAY">eBay TPP</option>
            <option value="TT_EBAY">eBay TT</option>
          </select>
          <select
            value={eventTypeFilter}
            onChange={(e) => { setEventTypeFilter(e.target.value); setPage(1); }}
            className="rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white"
          >
            <option value="">All Events</option>
            <option value="SENT">Sent</option>
            <option value="FAILED">Failed</option>
            <option value="QUEUED">Queued</option>
            <option value="SKIPPED">Skipped</option>
            <option value="DUPLICATE_PREVENTED">Duplicate Prevented</option>
            <option value="TEST_SEND">Test Send</option>
            <option value="PREVIEW">Preview</option>
          </select>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/30" />
            <input
              type="text"
              value={orderSearch}
              onChange={(e) => { setOrderSearch(e.target.value); setPage(1); }}
              placeholder="Order #"
              className="rounded border border-white/10 bg-black/30 pl-7 pr-2 py-1.5 text-xs text-white placeholder:text-white/30 w-40"
            />
          </div>
        </div>
        <button
          onClick={handleCsvExport}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-white/5 text-white/60 hover:text-white/90 hover:bg-white/10 transition-colors cursor-pointer"
        >
          <Download className="h-3 w-3" />
          CSV Export
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-white/30" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-white/40 text-sm">No log entries found.</div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs text-white/40 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium">Timestamp</th>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 font-medium">Responder</th>
                <th className="px-4 py-3 font-medium">Event</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      className="text-xs text-white/50 hover:text-white/80 cursor-pointer"
                    >
                      {formatDate(log.createdAt)}
                    </button>
                    {expandedId === log.id && (
                      <div className="mt-2 rounded border border-white/10 bg-black/30 p-3 text-xs space-y-2">
                        {log.renderedSubject && (
                          <div><span className="text-white/30">Subject:</span> <span className="text-white/70">{log.renderedSubject}</span></div>
                        )}
                        {log.renderedBody && (
                          <div><span className="text-white/30">Body:</span> <pre className="text-white/60 whitespace-pre-wrap mt-1">{log.renderedBody}</pre></div>
                        )}
                        {log.reason && (
                          <div><span className="text-white/30">Reason:</span> <span className="text-white/60">{log.reason}</span></div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/70">{log.orderNumber}</td>
                  <td className="px-4 py-3 text-xs text-white/50">{CHANNEL_LABELS[log.channel] ?? log.channel}</td>
                  <td className="px-4 py-3 text-xs text-white/50">{log.responder?.messageName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={cn("text-xs font-medium", EVENT_STYLES[log.eventType] ?? "text-white/50")}>
                      {log.eventType.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-white/40">{log.source.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3 text-xs text-white/40">{log.status ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
              <span className="text-xs text-white/40">{total} total</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className="p-1 cursor-pointer disabled:opacity-30">
                  <ChevronLeft className="h-4 w-4 text-white/50" />
                </button>
                <span className="text-xs text-white/50">{page} / {totalPages}</span>
                <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className="p-1 cursor-pointer disabled:opacity-30">
                  <ChevronRight className="h-4 w-4 text-white/50" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
