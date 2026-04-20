"use client";

import { useEffect, useState } from "react";

function getIsVisible() {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

/**
 * Tracks whether the document is currently visible.
 *
 * Important: we listen ONLY to `visibilitychange`, not to `window.focus` /
 * `window.blur`. Chrome fires `blur` + `focus` on tab switches in addition to
 * `visibilitychange`, which used to flap our state and cause callers (e.g.
 * useHelpdesk's polling effect) to re-fire their visibility-resumed work two
 * or three times per tab switch. That's the root cause of the "Help Desk
 * feels heavy when I come back to the tab" complaint — every flap triggered
 * a full inbox + selected-ticket refetch.
 *
 * One source of truth (visibilitychange) → one transition → one refresh.
 */
export function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(getIsVisible);

  useEffect(() => {
    function handleVisibilityChange() {
      const next = getIsVisible();
      setIsVisible((prev) => (prev === next ? prev : next));
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
