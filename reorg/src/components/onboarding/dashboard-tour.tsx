"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { DASHBOARD_TOUR_STEPS } from "@/components/onboarding/dashboard-tour-steps";
import {
  getLocalDashboardTourSeen,
  setLocalDashboardTourSeen,
} from "@/lib/onboarding-local";
import { OPEN_DASHBOARD_TOUR_EVENT } from "@/lib/onboarding-events";

/** Survives React Strict Mode remount when opening via ?tour=manual */
const PENDING_MANUAL_TOUR_KEY = "reorg_pending_dashboard_tour";

interface DashboardTourProps {
  /** When true, the grid has mounted and tour targets exist in the DOM */
  gridReady: boolean;
}

export function DashboardTour({ gridReady }: DashboardTourProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loaded, setLoaded] = useState(false);
  /** true = user has finished or skipped the tour (do not auto-show) */
  const [tourSeen, setTourSeen] = useState(true);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const replayRef = useRef(false);
  /** User asked to replay via ?tour=replay — do not let GET overwrite tourSeen to true */
  const replayRequested = useRef(false);
  /** Open once when landing with ?tour=manual (from TopBar on other pages) */
  const manualOpenRef = useRef(false);

  const fetchSeen = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as {
        data: { dashboardTourSeen?: boolean } | null;
        useLocalFallback?: boolean;
      };
      if (replayRequested.current) {
        setTourSeen(false);
      } else if (json.useLocalFallback) {
        setTourSeen(getLocalDashboardTourSeen());
      } else {
        setTourSeen(Boolean(json.data?.dashboardTourSeen));
      }
    } catch {
      if (!replayRequested.current) {
        setTourSeen(getLocalDashboardTourSeen());
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void fetchSeen();
  }, [fetchSeen]);

  /** ?tour=replay — replay from Settings (server reset already done) */
  useEffect(() => {
    if (searchParams.get("tour") !== "replay") return;
    replayRequested.current = true;
    replayRef.current = true;
    setTourSeen(false);
    setStepIndex(0);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tour");
    const q = params.toString();
    router.replace(q ? `/dashboard?${q}` : "/dashboard", { scroll: false });
  }, [searchParams, router]);

  /** ?tour=manual — open tour from TopBar without resetting “seen” in the database */
  useEffect(() => {
    if (searchParams.get("tour") !== "manual") return;
    manualOpenRef.current = true;
    try {
      sessionStorage.setItem(PENDING_MANUAL_TOUR_KEY, "1");
    } catch {
      /* private mode */
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tour");
    const q = params.toString();
    router.replace(q ? `/dashboard?${q}` : "/dashboard", { scroll: false });
  }, [searchParams, router]);

  /** TopBar Tour button: toggle open/close (closing does not mark tour complete). */
  useEffect(() => {
    const onToggle = () => {
      setOpen((prev) => {
        if (prev) return false;
        setStepIndex(0);
        return true;
      });
    };
    window.addEventListener(OPEN_DASHBOARD_TOUR_EVENT, onToggle);
    return () => window.removeEventListener(OPEN_DASHBOARD_TOUR_EVENT, onToggle);
  }, []);

  /** Auto-start first visit + replay; also open when ?tour=manual once grid is ready */
  useEffect(() => {
    if (!loaded || !gridReady) return;

    let pendingManual = false;
    try {
      pendingManual = sessionStorage.getItem(PENDING_MANUAL_TOUR_KEY) === "1";
      if (pendingManual) sessionStorage.removeItem(PENDING_MANUAL_TOUR_KEY);
    } catch {
      /* */
    }

    if (pendingManual || manualOpenRef.current) {
      manualOpenRef.current = false;
      const id = window.requestAnimationFrame(() => {
        setOpen(true);
        setStepIndex(0);
      });
      return () => window.cancelAnimationFrame(id);
    }

    if (tourSeen) return;

    if (replayRef.current) {
      const id = window.requestAnimationFrame(() => {
        replayRef.current = false;
        setOpen(true);
        setStepIndex(0);
      });
      return () => window.cancelAnimationFrame(id);
    }
    const id = window.setTimeout(() => {
      setOpen(true);
      setStepIndex(0);
    }, 400);
    return () => window.clearTimeout(id);
  }, [loaded, gridReady, tourSeen]);

  const persistSeen = useCallback(async () => {
    replayRequested.current = false;
    setTourSeen(true);
    setOpen(false);
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      const json = (await res.json()) as { useLocalFallback?: boolean };
      if (json.useLocalFallback) {
        setLocalDashboardTourSeen(true);
      } else {
        await fetch("/api/onboarding", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "complete", page: "dashboard" }),
        });
        setLocalDashboardTourSeen(true);
      }
    } catch {
      setLocalDashboardTourSeen(true);
    }
  }, []);

  const handleExit = useCallback(() => {
    void persistSeen();
  }, [persistSeen]);

  const handleComplete = useCallback(() => {
    void persistSeen();
  }, [persistSeen]);

  const handleNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, DASHBOARD_TOUR_STEPS.length - 1));
  }, []);

  const handleBack = useCallback(() => {
    setStepIndex((i) => Math.max(i - 1, 0));
  }, []);

  return (
    <TourOverlay
      open={open}
      steps={DASHBOARD_TOUR_STEPS}
      stepIndex={stepIndex}
      onNext={handleNext}
      onBack={handleBack}
      onExit={handleExit}
      onComplete={handleComplete}
    />
  );
}
