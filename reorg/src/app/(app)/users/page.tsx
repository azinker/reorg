"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, UserPlus, Save, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface ManagedUser {
  id: string;
  name: string | null;
  email: string;
  role: "ADMIN" | "OPERATOR";
  createdAt: string;
  updatedAt: string;
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
  canManageUsers: boolean;
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

export default function UsersPage() {
  const [payload, setPayload] = useState<UsersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [activityFilter, setActivityFilter] = useState("all");

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

  async function saveProfile() {
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

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground">
          Manage user access, update your credentials, and review account activity.
        </p>
      </div>

      {banner ? (
        <div
          className={cn(
            "mb-6 rounded-lg border px-4 py-3 text-sm",
            banner.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-200",
          )}
        >
          {banner.message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
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
            <section className="rounded-xl border border-border bg-card p-5">
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-foreground">
                  {payload.currentUser.role}
                </span>
                <button
                  type="button"
                  onClick={saveProfile}
                  disabled={savingProfile}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-base font-semibold text-foreground">Users</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.users.map((user) => (
                    <tr key={user.id} className="border-b border-border/60 last:border-b-0">
                      <td className="px-3 py-3 text-foreground">{user.name ?? "Unnamed user"}</td>
                      <td className="px-3 py-3 text-muted-foreground">{user.email}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-foreground">
                          {user.role}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{formatDate(user.createdAt)}</td>
                      <td className="px-3 py-3 text-muted-foreground">{formatDate(user.updatedAt)}</td>
                    </tr>
                  ))}
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
    </div>
  );
}
