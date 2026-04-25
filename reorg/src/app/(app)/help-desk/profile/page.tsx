"use client";

/**
 * Agent profile page (/help-desk/profile)
 *
 * Lets the signed-in agent edit how they appear inside the Help Desk:
 *   - Avatar (uploaded → resized to 256px webp data URL on the server)
 *   - Display name + handle
 *   - Title (e.g. "Customer Success", shown under name in pickers)
 *   - Bio (short personal note)
 *
 * The avatar shows up everywhere assignees + message authors render, so this
 * page is the single source of truth for that visual identity. It is NOT an
 * admin tool; admins manage other people's accounts under /settings.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Trash2, Upload, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  useHelpdeskPrefs,
  updateHelpdeskPrefs,
  type HelpdeskPrefs,
} from "@/components/helpdesk/HelpdeskSettingsDialog";

interface MeProfile {
  id: string;
  email: string;
  name: string | null;
  handle: string | null;
  title: string | null;
  bio: string | null;
  avatarUrl: string | null;
  role: string;
}

export default function HelpdeskProfilePage() {
  const [me, setMe] = useState<MeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [title, setTitle] = useState("");
  const [bio, setBio] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const prefs = useHelpdeskPrefs();
  function patchPrefs<K extends keyof HelpdeskPrefs>(key: K, value: HelpdeskPrefs[K]) {
    updateHelpdeskPrefs({ [key]: value } as Partial<HelpdeskPrefs>);
  }
  const isAdmin = me?.role === "ADMIN";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/users/me", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { data: MeProfile };
        if (cancelled) return;
        setMe(j.data);
        setName(j.data.name ?? "");
        setHandle(j.data.handle ?? "");
        setTitle(j.data.title ?? "");
        setBio(j.data.bio ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    if (!me) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          handle: handle.trim() || null,
          title: title.trim() || null,
          bio: bio.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          j?.error?.message ?? j?.error ?? `Save failed (${res.status})`,
        );
      }
      const j = (await res.json()) as { data: MeProfile };
      setMe(j.data);
      setSuccess("Profile saved.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onUpload(file: File) {
    if (!me) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/users/me/avatar", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          j?.error?.message ?? j?.error ?? `Upload failed (${res.status})`,
        );
      }
      const j = (await res.json()) as { data: MeProfile };
      setMe(j.data);
      setSuccess("Avatar updated.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onClearAvatar() {
    if (!me) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/users/me/avatar", { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Clear failed (${res.status})`);
      }
      const j = (await res.json()) as { data: MeProfile };
      setMe(j.data);
      setSuccess("Avatar removed.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-[400px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="px-6 py-8 text-sm text-red-700 dark:text-red-300">
        {error ?? "Failed to load your profile."}
      </div>
    );
  }

  const previewUser = {
    id: me.id,
    name: name || null,
    email: me.email,
    handle: handle || null,
    avatarUrl: me.avatarUrl,
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/help-desk"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Help Desk
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">My Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How you appear to teammates inside the Help Desk. Your avatar shows up
          on every ticket you're assigned to and on every reply you send.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {success}
        </div>
      ) : null}

      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Avatar
        </h2>
        <div className="flex items-center gap-4">
          <Avatar user={previewUser} size="xl" ring />
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Upload image
              </button>
              {me.avatarUrl ? (
                <button
                  type="button"
                  onClick={onClearAvatar}
                  disabled={uploading}
                  className="inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              JPG, PNG or WebP up to 2 MB. We'll resize it to a square automatically.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
              }}
            />
          </div>
        </div>
      </section>

      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Identity
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" hint="Shown on tickets and assignments.">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-foreground focus:border-brand/40 focus:outline-none"
              placeholder="Adam Zinker"
            />
          </Field>
          <Field
            label="Handle"
            hint="Used in @mentions. Letters, numbers, hyphens or underscores."
          >
            <div className="flex h-9 items-center rounded-md border border-hairline bg-surface pl-2 focus-within:border-brand/40">
              <span className="text-sm text-muted-foreground">@</span>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className="h-full flex-1 bg-transparent px-1 text-sm text-foreground focus:outline-none"
                placeholder="adam"
              />
            </div>
          </Field>
          <Field label="Email" hint="Read-only. Contact an admin to change it.">
            <input
              value={me.email}
              disabled
              className="h-9 w-full cursor-not-allowed rounded-md border border-hairline bg-surface-2 px-3 text-sm text-muted-foreground"
            />
          </Field>
          <Field label="Title" hint="Optional. Shown under your name in pickers.">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-foreground focus:border-brand/40 focus:outline-none"
              placeholder="Customer Success"
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Bio" hint="A short note about you. Optional.">
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-sm text-foreground focus:border-brand/40 focus:outline-none"
              placeholder="Handles eBay returns and Shopify pre-sales."
            />
          </Field>
        </div>
      </section>

      {/* Per-agent Help Desk preferences. These are personal — they live in your
       * browser only and don't affect other agents. Global controls (safe mode,
       * sync schedules, etc.) are admin-only and live at /help-desk/global-settings. */}
      <section className="mb-8 rounded-xl border border-hairline bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            My Help Desk Preferences
          </h2>
        </div>
        <div className="space-y-4">
          <PrefRow
            label="Send delay"
            hint="Seconds the composer waits before sending. Click Undo to cancel."
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={10}
                value={prefs.sendDelaySeconds}
                onChange={(e) => patchPrefs("sendDelaySeconds", Number(e.target.value))}
                className="w-40 cursor-pointer accent-brand"
              />
              <span className="w-10 text-right text-sm text-foreground">
                {prefs.sendDelaySeconds}s
              </span>
            </div>
          </PrefRow>
          <PrefRow
            label="Auto-advance"
            hint="After resolving a ticket, jump to the next one in the list."
          >
            <PrefToggle
              checked={prefs.autoAdvance}
              onChange={(v) => patchPrefs("autoAdvance", v)}
            />
          </PrefRow>
          <PrefRow
            label="Sticky composer"
            hint="Keep the composer expanded when switching tickets."
          >
            <PrefToggle
              checked={prefs.composerSticky}
              onChange={(v) => patchPrefs("composerSticky", v)}
            />
          </PrefRow>
          <PrefRow
            label="Composer height"
            hint="Default message box height. You can also drag the composer handle."
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={96}
                max={360}
                step={12}
                value={prefs.composerHeightPx}
                onChange={(e) => patchPrefs("composerHeightPx", Number(e.target.value))}
                className="w-40 cursor-pointer accent-brand"
              />
              <span className="w-12 text-right text-sm text-foreground">
                {prefs.composerHeightPx}px
              </span>
            </div>
          </PrefRow>
          <PrefRow
            label="Auto-mark read"
            hint="Clear the unread badge as soon as you open a ticket."
          >
            <PrefToggle
              checked={prefs.autoMarkRead}
              onChange={(v) => patchPrefs("autoMarkRead", v)}
            />
          </PrefRow>
          <PrefRow label="Density" hint="Affects the ticket list row height.">
            <select
              value={prefs.density}
              onChange={(e) =>
                patchPrefs("density", e.target.value as HelpdeskPrefs["density"])
              }
              className="h-8 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </PrefRow>
          <PrefRow label="Layout" hint="Split shows three panes; List opens tickets in a reader.">
            <select
              value={prefs.layout}
              onChange={(e) =>
                patchPrefs("layout", e.target.value as HelpdeskPrefs["layout"])
              }
              className="h-8 rounded-md border border-hairline bg-surface px-2 text-sm text-foreground"
            >
              <option value="split">Split</option>
              <option value="list">List</option>
            </select>
          </PrefRow>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Stored locally in this browser. Settings sync per-device, not per-account.
        </p>
      </section>

      {isAdmin ? (
        <section className="mb-8 rounded-xl border border-brand/30 bg-brand-muted/40 p-5">
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-brand">
              Admin Controls
            </h2>
          </div>
          <p className="mb-3 text-sm text-foreground">
            You're an Admin. Global settings (Safe Mode, sync schedule, retroactive
            auto-resolve, write locks) live in their own page so they don't get
            mixed up with per-agent preferences.
          </p>
          <Link
            href="/help-desk/global-settings"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90 cursor-pointer"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Open Global Settings
          </Link>
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save profile
        </button>
      </div>
    </div>
  );
}

function PrefRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-3">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint ? (
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-end pt-0.5">{children}</div>
    </div>
  );
}

function PrefToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer " +
        (checked ? "bg-brand" : "bg-surface-2 border border-hairline")
      }
      aria-pressed={checked}
    >
      <span
        className={
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground/70">{hint}</div> : null}
    </label>
  );
}
