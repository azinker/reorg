"use client";

import { useEffect, useState } from "react";

function getIsVisible() {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

export function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(getIsVisible);

  useEffect(() => {
    function handleVisibilityChange() {
      setIsVisible(getIsVisible());
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);
    window.addEventListener("blur", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
      window.removeEventListener("blur", handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
