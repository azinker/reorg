"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { OPEN_PAGE_TOUR_EVENT } from "@/lib/onboarding-events";
import { onboardingFlagKey, type OnboardingPageKey } from "@/lib/onboarding-pages";
import { getLocalTourSeen, setLocalTourSeen } from "@/lib/onboarding-local";
import type { TourStep } from "@/components/onboarding/tour-overlay";

const PENDING_MANUAL_TOUR_KEY = "reorg_pending_page_tour";

interface PageTourProps {
  page: OnboardingPageKey;
  steps: TourStep[];
  ready?: boolean;
}

type OnboardingState = Partial<Record<`${OnboardingPageKey}TourSeen`, boolean>>;

export function PageTour({ page, steps, ready = true }: PageTourProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [tourSeen, setTourSeen] = useState(true);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const replayRef = useRef(false);
  const manualOpenRef = useRef(false);

  const fetchSeen = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as {
        data: OnboardingState | null;
        useLocalFallback?: boolean;
      };
      if (json.useLocalFallback) {
        setTourSeen(getLocalTourSeen(page));
      } else {
        const key = onboardingFlagKey(page) as `${OnboardingPageKey}TourSeen`;
        setTourSeen(Boolean(json.data?.[key]));
      }
    } catch {
      setTourSeen(getLocalTourSeen(page));
    } finally {
      setLoaded(true);
    }
  }, [page]);

  useEffect(() => {
    void fetchSeen();
  }, [fetchSeen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("tour") !== "manual") return;
    manualOpenRef.current = true;
    sessionStorage.setItem(PENDING_MANUAL_TOUR_KEY, page);
    params.delete("tour");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [page, pathname, router]);

  useEffect(() => {
    function onToggle(evt: Event) {
      const custom = evt as CustomEvent<{ page?: OnboardingPageKey }>;
      if (custom.detail?.page && custom.detail.page !== page) return;
      setOpen((prev) => {
        if (prev) return false;
        setStepIndex(0);
        return true;
      });
    }
    window.addEventListener(OPEN_PAGE_TOUR_EVENT, onToggle);
    return () => window.removeEventListener(OPEN_PAGE_TOUR_EVENT, onToggle);
  }, [page]);

  useEffect(() => {
    if (!loaded || !ready) return;

    let pendingManual = false;
    try {
      pendingManual = sessionStorage.getItem(PENDING_MANUAL_TOUR_KEY) === page;
      if (pendingManual) sessionStorage.removeItem(PENDING_MANUAL_TOUR_KEY);
    } catch {
      /* */
    }

    if (pendingManual || manualOpenRef.current || replayRef.current) {
      manualOpenRef.current = false;
      replayRef.current = false;
      const id = window.requestAnimationFrame(() => {
        setOpen(true);
        setStepIndex(0);
      });
      return () => window.cancelAnimationFrame(id);
    }

    if (tourSeen) return;
    const id = window.setTimeout(() => {
      setOpen(true);
      setStepIndex(0);
    }, 400);
    return () => window.clearTimeout(id);
  }, [loaded, ready, page, tourSeen]);

  const persistSeen = useCallback(async () => {
    setTourSeen(true);
    setOpen(false);
    setLocalTourSeen(page, true);
    try {
      await fetch("/api/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", page }),
      });
    } catch {
      /* local fallback already set */
    }
  }, [page]);

  if (steps.length === 0) return null;

  return (
    <TourOverlay
      open={open}
      steps={steps}
      stepIndex={stepIndex}
      onNext={() => setStepIndex((i) => Math.min(i + 1, steps.length - 1))}
      onBack={() => setStepIndex((i) => Math.max(i - 1, 0))}
      onExit={() => void persistSeen()}
      onComplete={() => void persistSeen()}
    />
  );
}
