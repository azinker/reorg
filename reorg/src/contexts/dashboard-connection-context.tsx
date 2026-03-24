"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { Platform } from "@/lib/grid-types";

export interface GridSummary {
  masterGroups: number;
  variationParents: number;
  standaloneRows: number;
  childRows: number;
  actualProducts: number;
  listingCounts: Map<Platform, Set<string>>;
}

export interface ConnectionInfo {
  source: "db" | "mock" | "error";
  error: string | null;
  summary: GridSummary | null;
}

interface DashboardConnectionContextValue {
  connectionInfo: ConnectionInfo | null;
  setConnectionInfo: (info: ConnectionInfo | null) => void;
}

const DashboardConnectionContext = createContext<DashboardConnectionContextValue | null>(null);

export function DashboardConnectionProvider({ children }: { children: ReactNode }) {
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  return (
    <DashboardConnectionContext.Provider value={{ connectionInfo, setConnectionInfo }}>
      {children}
    </DashboardConnectionContext.Provider>
  );
}

export function useDashboardConnection() {
  const ctx = useContext(DashboardConnectionContext);
  if (!ctx) {
    return {
      connectionInfo: null as ConnectionInfo | null,
      setConnectionInfo: (_: ConnectionInfo | null) => {},
    };
  }
  return ctx;
}
