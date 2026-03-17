"use client";

import { useState, useEffect } from "react";
import { useTheme } from "@/components/providers/theme-provider";
import { useSettings } from "@/lib/use-settings";
import type { Density } from "@/lib/settings-store";
import { Moon, Sun, Monitor, Rows3, Rows4, AlignJustify } from "lucide-react";

const DENSITY_OPTIONS: { value: Density; icon: typeof Rows3; label: string }[] = [
  { value: "compact", icon: Rows4, label: "Compact" },
  { value: "comfortable", icon: Rows3, label: "Comfortable" },
  { value: "spacious", icon: AlignJustify, label: "Spacious" },
];

export function TopBar() {
  const { theme, setTheme } = useTheme();
  const { settings, update } = useSettings();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const density = mounted ? settings.density : "comfortable";
  const themeValue = mounted ? theme : "system";

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          Marketplace Operations
        </span>
      </div>
      <div className="flex items-center gap-3">
        {/* Density Toggle - use stable value until mounted to avoid hydration mismatch */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Density</span>
          <div className="flex items-center rounded-md border border-border bg-background p-0.5">
            {DENSITY_OPTIONS.map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => update({ density: value })}
                className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
                  density === value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={label}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>

        {/* Theme Toggle */}
        <div className="flex items-center rounded-md border border-border bg-background p-0.5">
          <button
            onClick={() => setTheme("light")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "light"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Light mode"
          >
            <Sun className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setTheme("dark")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "dark"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Dark mode"
          >
            <Moon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setTheme("system")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "system"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="System theme"
          >
            <Monitor className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
