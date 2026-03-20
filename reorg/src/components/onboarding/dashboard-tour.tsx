"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { DASHBOARD_TOUR_STEPS } from "@/components/onboarding/dashboard-tour-steps";
import {
  getLocalDashboardTourSeen,
  setLocalDashboardTourSeen,
} from "@/lib/onboarding-local";

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

  useEffect(() => {
    if (!loaded || !gridReady || tourSeen) return;
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
