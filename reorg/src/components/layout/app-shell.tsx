"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { DashboardConnectionProvider } from "@/contexts/dashboard-connection-context";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";

interface AppShellProps {
  children: React.ReactNode;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  } | null;
  /**
   * Set of page keys this user is allowed to see in the sidebar. NULL means
   * "use the legacy default" (operators see everything except admin-only,
   * admins see everything). Computed server-side in the (app) layout.
   */
  allowedPageKeys: string[] | null;
  /**
   * When set, an admin is currently impersonating someone else — render the
   * "Logged in as <name>" banner across the top so the admin can never
   * forget they're driving someone else's session.
   */
  impersonation: { realName: string; realEmail: string } | null;
}

export function AppShell({
  children,
  user,
  allowedPageKeys,
  impersonation,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {impersonation ? (
        <ImpersonationBanner
          realName={impersonation.realName}
          realEmail={impersonation.realEmail}
          targetName={user?.name ?? "user"}
          targetEmail={user?.email ?? ""}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden lg:flex">
          <Sidebar
            userRole={user?.role ?? null}
            allowedPageKeys={allowedPageKeys}
          />
        </div>
        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/50 transition-opacity lg:hidden",
            mobileOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
          )}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:hidden",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar
            mobile
            userRole={user?.role ?? null}
            allowedPageKeys={allowedPageKeys}
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
        <DashboardConnectionProvider>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <TopBar user={user} onOpenSidebar={() => setMobileOpen(true)} />
            <main className="min-w-0 flex-1 overflow-auto">{children}</main>
          </div>
        </DashboardConnectionProvider>
      </div>
    </div>
  );
}
