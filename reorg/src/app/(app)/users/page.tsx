"use client";

/**
 * /users — User profile + (for admins) team management.
 *
 * Two roles, two experiences:
 *   - Operators see a single "My account" panel + their own activity log.
 *   - Admins see "My account", an "Add user" form, the full users table
 *     (with per-user role + page permissions + actions), and the team-wide
 *     activity log.
 *
 * Admin actions per user:
 *   - "Edit" → opens a side drawer where the admin can change the user's
 *     display name, role, password, and page-permission allowlist. The
 *     allowlist is rendered from the server-supplied page registry so
 *     adding a new top-level page automatically shows up here.
 *   - "Login as" → impersonates that user via a signed cookie. The full
 *     app re-renders as the impersonated user. A persistent banner offers
 *     "Return to my account" on every page.
 *
 * Server-side guards still enforce all of this; the UI just hides the
 * controls a non-admin couldn't action anyway.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  ShieldCheck,
  UserPlus,
  Save,
  Activity,
  KeyRound,
  Pencil,
  Eye,
  X,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

interface ManagedUser {
  id: string;
  name: string | null;
  email: string;
  role: "ADMIN" | "OPERATOR";
  pagePermissions: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface PageRegistryEntry {
  key: string;
  href: string;
  label: string;
  adminOnly: boolean;
  alwaysAllow: boolean;
  description: string;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
}

interface UsersPayload {
  currentUser: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  impersonation: {
    realUserId: string;
    realName: string;
    realEmail: string;
  } | null;
  canManageUsers: boolean;
  pageRegistry: PageRegistryEntry[];
  users: ManagedUser[];
  auditLogs: AuditEntry[];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }).format(new Date(value));
}

/**
 * Build a short human-readable summary of a user's page permissions for the
 * users-table row. Three states:
 *   - Admin → "Full access (admin)"
 *   - pagePermissions === null → "Default operator (all non-admin pages)"
 *   - pagePermissions === [] → "Restricted (default pages only)"
 *   - otherwise → "<n> page(s) granted"
 */
function summarizePagePermissions(user: ManagedUser, totalPages: number) {
  if (user.role === "ADMIN") return `Full access (${totalPages} pages)`;
  if (user.pagePermissions === null) return "Default operator access";
  if (user.pagePermissions.length === 0)
    return "Restricted — default pages only";
  return `${user.pagePermissions.length} page${user.pagePermissions.length === 1 ? "" : "s"} granted`;
}

export default function UsersPage() {
  const [payload, setPayload] = useState<UsersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [banner, setBanner] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [activityFilter, setActivityFilter] = useState("all");
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const [profileForm, setProfileForm] = useState({
    name: "",
    password: "",
  });
  const [newUserForm, setNewUserForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "OPERATOR" as "ADMIN" | "OPERATOR",
  });

  async function loadUsers() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load users");
      }

      const nextPayload = json.data as UsersPayload;
      setPayload(nextPayload);
      setProfileForm({
        name: nextPayload.currentUser.name ?? "",
        password: "",
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  const filteredActivity = useMemo(() => {
    if (!payload) return [];
    if (activityFilter === "all") return payload.auditLogs;
    return payload.auditLogs.filter((entry) => entry.user?.id === activityFilter);
  }, [activityFilter, payload]);

  const editingUser = useMemo(
    () => payload?.users.find((u) => u.id === editingUserId) ?? null,
    [payload, editingUserId],
  );

  const isImpersonating = Boolean(payload?.impersonation);

  async function saveProfile() {
    if (isImpersonating) {
      setBanner({
        type: "error",
        message:
          "Profile edits are blocked while impersonating. Return to your account first.",
      });
      return;
    }
    if (!profileForm.name.trim() && !profileForm.password.trim()) {
      setBanner({ type: "error", message: "Add a name or password change first." });
      return;
    }

    setSavingProfile(true);
    setBanner(null);

    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profileForm.name.trim(),
          password: profileForm.password.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to update profile");
      }

      setProfileForm((current) => ({ ...current, password: "" }));
      setBanner({ type: "success", message: "Your profile was updated." });
      await loadUsers();
    } catch (saveError) {
      setBanner({
        type: "error",
        message: saveError instanceof Error ? saveError.message : "Failed to update profile",
      });
    } finally {
      setSavingProfile(false);
    }
  }

  async function createUser() {
    setCreatingUser(true);
    setBanner(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUserForm),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to create user");
      }

      setNewUserForm({
        name: "",
        email: "",
        password: "",
        role: "OPERATOR",
      });
      setBanner({ type: "success", message: "User created successfully." });
      await loadUsers();
    } catch (createError) {
      setBanner({
        type: "error",
        message: createError instanceof Error ? createError.message : "Failed to create user",
      });
    } finally {
      setCreatingUser(false);
    }
  }

  async function impersonate(userId: string) {
    setBanner(null);
    try {
      const res = await fetch(`/api/users/${userId}/impersonate`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to start impersonation.");
      }
      // Reload the entire app so server components re-evaluate the actor.
      window.location.assign("/dashboard");
    } catch (err) {
      setBanner({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to login as user",
      });
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6" data-tour="users-header">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground">
          Manage user access, update your credentials, and review account activity.
        </p>
      </div>

      {banner ? (
        <div
          className={cn(
            "mb-6 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm",
            banner.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-200",
          )}
        >
          {banner.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{banner.message}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="ml-auto rounded p-0.5 text-current hover:bg-current/10"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : loading || !payload ? (
        <div className="rounded-lg border border-border bg-card px-4 py-8 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading users...
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
            <section className="rounded-xl border border-border bg-card p-5" data-tour="users-profile">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[#C43E3E]" />
                <div>
                  <h2 className="text-base font-semibold text-foreground">My account</h2>
                  <p className="text-sm text-muted-foreground">
                    Update your displayed name and password.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Name</span>
                  <input
                    value={profileForm.name}
                    onChange={(event) =>
                      setProfileForm((current) => ({ ...current, name: event.target.value }))
                    }
                    disabled={isImpersonating}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Email</span>
                  <input
                    value={payload.currentUser.email}
                    disabled
                    className="w-full rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                  />
                </label>
                <label className="space-y-2 sm:col-span-2">
                  <span className="text-sm font-medium text-foreground">New password</span>
                  <input
                    type="password"
                    value={profileForm.password}
                    onChange={(event) =>
                      setProfileForm((current) => ({ ...current, password: event.target.value }))
                    }
                    placeholder="Leave blank to keep current password"
                    disabled={isImpersonating}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs uppercase tracking-[0.18em]",
                    payload.currentUser.role === "ADMIN"
                      ? "border-orange-500/30 bg-orange-500/10 text-foreground"
                      : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
                  )}
                >
                  {payload.currentUser.role}
                </span>
                <button
                  type="button"
                  onClick={saveProfile}
                  disabled={savingProfile || isImpersonating}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    isImpersonating
                      ? "Return to your account before editing your own profile."
                      : undefined
                  }
                >
                  {savingProfile ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save profile
                </button>
              </div>
            </section>

            {payload.canManageUsers ? (
              <section className="rounded-xl border border-border bg-card p-5">
                <div className="mb-4 flex items-center gap-2">
                  <UserPlus className="h-5 w-5 text-[#C43E3E]" />
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Add user</h2>
                    <p className="text-sm text-muted-foreground">
                      Admin-only user creation with credential access.
                    </p>
                  </div>
                </div>

                <div className="grid gap-4">
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Name</span>
                    <input
                      value={newUserForm.name}
                      onChange={(event) =>
                        setNewUserForm((current) => ({ ...current, name: event.target.value }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Email</span>
                    <input
                      type="email"
                      value={newUserForm.email}
                      onChange={(event) =>
                        setNewUserForm((current) => ({ ...current, email: event.target.value }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Temporary password</span>
                    <input
                      type="password"
                      value={newUserForm.password}
                      onChange={(event) =>
                        setNewUserForm((current) => ({ ...current, password: event.target.value }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Role</span>
                    <select
                      value={newUserForm.role}
                      onChange={(event) =>
                        setNewUserForm((current) => ({
                          ...current,
                          role: event.target.value as "ADMIN" | "OPERATOR",
                        }))
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="OPERATOR">Operator</option>
                    </select>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={createUser}
                  disabled={creatingUser}
                  className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {creatingUser ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                  Create user
                </button>
              </section>
            ) : null}
          </div>

          <section className="rounded-xl border border-border bg-card p-5" data-tour="users-manage">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">
                {payload.canManageUsers ? "Team" : "My profile"}
              </h2>
              {payload.canManageUsers ? (
                <span className="text-xs text-muted-foreground">
                  {payload.users.length} user{payload.users.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Page access</th>
                    <th className="px-3 py-2 font-medium">Updated</th>
                    {payload.canManageUsers ? (
                      <th className="px-3 py-2 font-medium text-right">Actions</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {payload.users.map((user) => {
                    const isSelf = user.id === payload.currentUser.id;
                    const isAdmin = user.role === "ADMIN";
                    return (
                      <tr key={user.id} className="border-b border-border/60 last:border-b-0">
                        <td className="px-3 py-3 text-foreground">
                          {user.name ?? "Unnamed user"}
                          {isSelf ? (
                            <span className="ml-2 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                              You
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">{user.email}</td>
                        <td className="px-3 py-3">
                          <span
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.18em]",
                              isAdmin
                                ? "border-orange-500/30 bg-orange-500/10 text-foreground"
                                : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
                            )}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          {summarizePagePermissions(user, payload.pageRegistry.length)}
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">
                          {formatDate(user.updatedAt)}
                        </td>
                        {payload.canManageUsers ? (
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingUserId(user.id)}
                                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted cursor-pointer"
                                title="Edit role and page permissions"
                              >
                                <Pencil className="h-3 w-3" />
                                Edit
                              </button>
                              {!isAdmin && !isSelf ? (
                                <button
                                  type="button"
                                  onClick={() => impersonate(user.id)}
                                  disabled={isImpersonating}
                                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-amber-300"
                                  title={
                                    isImpersonating
                                      ? "Return to your account before logging in as another user"
                                      : "Sign in as this user to see their view"
                                  }
                                >
                                  <Eye className="h-3 w-3" />
                                  Login as
                                </button>
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-[#C43E3E]" />
                <div>
                  <h2 className="text-base font-semibold text-foreground">User activity</h2>
                  <p className="text-sm text-muted-foreground">
                    Audit trail of sign-ins, staging, pushes, user creation, and profile updates.
                  </p>
                </div>
              </div>
              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="all">All users</option>
                {payload.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Entity</th>
                    <th className="px-3 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredActivity.map((entry) => (
                    <tr key={entry.id} className="border-b border-border/60 align-top last:border-b-0">
                      <td className="px-3 py-3 text-muted-foreground">{formatDate(entry.createdAt)}</td>
                      <td className="px-3 py-3 text-foreground">
                        {entry.user ? `${entry.user.name} (${entry.user.email})` : "System"}
                      </td>
                      <td className="px-3 py-3 text-foreground">{entry.action}</td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {entry.entityType ?? "n/a"}
                        {entry.entityId ? ` • ${entry.entityId}` : ""}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        <pre className="whitespace-pre-wrap break-words font-mono">
                          {JSON.stringify(entry.details, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {editingUser && payload ? (
        <EditUserDrawer
          user={editingUser}
          pageRegistry={payload.pageRegistry}
          isSelf={editingUser.id === payload.currentUser.id}
          onClose={() => setEditingUserId(null)}
          onSaved={async () => {
            setEditingUserId(null);
            setBanner({ type: "success", message: "User updated." });
            await loadUsers();
          }}
          onError={(message) => setBanner({ type: "error", message })}
        />
      ) : null}

      <PageTour page="users" steps={PAGE_TOUR_STEPS.users} ready />
    </div>
  );
}

// ─── Edit User Drawer ───────────────────────────────────────────────────────

interface EditUserDrawerProps {
  user: ManagedUser;
  pageRegistry: PageRegistryEntry[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
}

/**
 * Right-hand side drawer where an admin can:
 *   - Rename a user
 *   - Flip role between ADMIN and OPERATOR
 *   - Reset the user's password
 *   - Toggle which top-level pages they can see
 *
 * The page-permissions section uses a tri-state model:
 *   "default"     → pagePermissions === null (legacy / "operator default")
 *   "restricted"  → pagePermissions = explicit allowlist
 *
 * Always-allowed pages are rendered as locked-on. Admin-only pages render as
 * "Admin only" (locked off for operators). For admins the entire allowlist
 * is hidden because it's irrelevant — admins always see everything.
 */
function EditUserDrawer({
  user,
  pageRegistry,
  isSelf,
  onClose,
  onSaved,
  onError,
}: EditUserDrawerProps) {
  const [name, setName] = useState(user.name ?? "");
  const [role, setRole] = useState<"ADMIN" | "OPERATOR">(user.role);
  const [password, setPassword] = useState("");
  const [accessMode, setAccessMode] = useState<"default" | "restricted">(
    user.pagePermissions === null ? "default" : "restricted",
  );
  const [allowed, setAllowed] = useState<Set<string>>(
    new Set(user.pagePermissions ?? []),
  );
  const [saving, setSaving] = useState(false);

  // Always-allowed pages are visible to everyone — show them as on but disabled.
  const togglePage = (key: string, on: boolean) => {
    setAllowed((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== (user.name ?? "")) body.name = name.trim();
      if (role !== user.role) body.role = role;
      if (password.trim()) body.password = password.trim();

      // Only send pagePermissions when the user is/will-be an OPERATOR. The
      // admin role overrides anything sent here, so don't litter the audit
      // log with no-op writes.
      if (role === "OPERATOR") {
        if (accessMode === "default") {
          if (user.pagePermissions !== null) body.pagePermissions = null;
        } else {
          body.pagePermissions = Array.from(allowed);
        }
      }

      if (Object.keys(body).length === 0) {
        onError("Nothing to save.");
        setSaving(false);
        return;
      }

      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to save user");
      }
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save user");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Edit {user.name ?? user.email}
            </h3>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">Display name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "ADMIN" | "OPERATOR")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="OPERATOR">Operator (granular page access)</option>
              <option value="ADMIN">Admin (full access)</option>
            </select>
            {isSelf && role === "OPERATOR" && user.role === "ADMIN" ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                You're demoting yourself. Make sure another admin exists first.
              </p>
            ) : null}
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">
              Reset password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current password"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            />
            {password.trim() && password.trim().length < 8 ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Password must be at least 8 characters.
              </p>
            ) : null}
          </label>

          {role === "OPERATOR" ? (
            <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[#C43E3E]" />
                <div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Page access
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Control which top-level pages this user sees in the sidebar.
                    Server-side guards still enforce this regardless of UI.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setAccessMode("default")}
                  className={cn(
                    "rounded-md border px-2.5 py-2 text-left font-medium transition-colors cursor-pointer",
                    accessMode === "default"
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  Default operator
                  <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
                    All non-admin pages
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAccessMode("restricted")}
                  className={cn(
                    "rounded-md border px-2.5 py-2 text-left font-medium transition-colors cursor-pointer",
                    accessMode === "restricted"
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  Custom allowlist
                  <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">
                    Pick specific pages
                  </span>
                </button>
              </div>

              {accessMode === "restricted" ? (
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
                  {pageRegistry.map((page) => {
                    const isLocked = page.alwaysAllow || page.adminOnly;
                    const checked = page.alwaysAllow
                      ? true
                      : page.adminOnly
                        ? false
                        : allowed.has(page.key);
                    return (
                      <label
                        key={page.key}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted",
                          isLocked && "cursor-not-allowed opacity-70",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isLocked}
                          onChange={(e) => togglePage(page.key, e.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="flex-1">
                          <span className="font-medium text-foreground">{page.label}</span>
                          {page.alwaysAllow ? (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                              Always on
                            </span>
                          ) : page.adminOnly ? (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-orange-700 dark:text-orange-300">
                              Admin only
                            </span>
                          ) : null}
                          <span className="block text-[11px] text-muted-foreground">
                            {page.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Operator default — sees every page except admin-only pages
                  (Payouts, Public Network Transfer).
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-4 text-xs text-orange-900 dark:text-orange-200">
              Admins always see every page. Page permissions are only
              configurable for operators.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-muted cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
