"use client";

import { useSyncExternalStore, useCallback, useEffect } from "react";
import {
  getPlatformFeeRate,
  setPlatformFeeRate,
  subscribePlatformFeeRate,
  hydratePlatformFeeRate,
} from "@/lib/platform-fee-store";

export function usePlatformFee() {
  const rate = useSyncExternalStore(
    subscribePlatformFeeRate,
    getPlatformFeeRate,
    getPlatformFeeRate
  );

  useEffect(() => {
    hydratePlatformFeeRate();
  }, []);

  const setRate = useCallback((newRate: number) => {
    setPlatformFeeRate(newRate);
  }, []);

  return { feeRate: rate, setFeeRate: setRate };
}
