"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  RefreshCw,
  Plug,
  Gauge,
  AlertTriangle,
  Unlink,
  Upload,
  Weight,
  Database,
  ClipboardCheck,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/sync", label: "Sync", icon: RefreshCw },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/engine-room", label: "Engine Room", icon: Gauge },
  { href: "/errors", label: "Errors", icon: AlertTriangle },
  { href: "/unmatched", label: "Unmatched Listings", icon: Unlink },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/shipping-rates", label: "Shipping Rates", icon: Weight },
  { href: "/backups", label: "Backups", icon: Database },
  { href: "/setup", label: "Setup Checklist", icon: ClipboardCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Brand */}
      <div className="flex h-16 items-center border-b border-sidebar-border px-4">
        {!collapsed && (
          <div className="flex flex-col">
            <span className="text-lg font-bold tracking-tight text-foreground">
              reorG
            </span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              by The Perfect Part
            </span>
          </div>
        )}
        {collapsed && (
          <span className="mx-auto text-lg font-bold text-foreground">rG</span>
        )}
      </div>

      {/* Nav Items */}
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse Toggle */}
      <div className="border-t border-sidebar-border p-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
