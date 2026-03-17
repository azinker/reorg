"use client";

import { useSyncExternalStore, useCallback, useEffect } from "react";
import {
  getSettings,
  updateSettings,
  subscribeSettings,
  hydrateSettings,
  type AppSettings,
} from "@/lib/settings-store";

export function useSettings() {
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettings,
    getSettings
  );

  useEffect(() => {
    hydrateSettings();
  }, []);

  const update = useCallback((partial: Partial<AppSettings>) => {
    updateSettings(partial);
  }, []);

  return { settings, update };
}
