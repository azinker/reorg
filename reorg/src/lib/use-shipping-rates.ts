"use client";

import { useSyncExternalStore, useCallback, useEffect } from "react";
import {
  getShippingRates,
  setShippingRates,
  subscribeShippingRates,
  lookupShippingCost,
  hydrateShippingRates,
  type ShippingRateEntry,
} from "@/lib/shipping-rates-store";

export function useShippingRates() {
  const rates = useSyncExternalStore(
    subscribeShippingRates,
    getShippingRates,
    getShippingRates
  );

  useEffect(() => {
    hydrateShippingRates();
  }, []);

  const updateRates = useCallback((newRates: ShippingRateEntry[]) => {
    setShippingRates(newRates);
  }, []);

  return { rates, updateRates, lookupShippingCost };
}
