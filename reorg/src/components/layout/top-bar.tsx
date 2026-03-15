"use client";

import { useTheme } from "@/components/providers/theme-provider";
import { Moon, Sun, Monitor } from "lucide-react";

export function TopBar() {
  const { theme, setTheme } = useTheme();

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          Marketplace Operations
        </span>
      </div>
      <div className="flex items-center gap-2">
        {/* Theme Toggle */}
        <div className="flex items-center rounded-md border border-border bg-background p-0.5">
          <button
            onClick={() => setTheme("light")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              theme === "light"
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
              theme === "dark"
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
              theme === "system"
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
