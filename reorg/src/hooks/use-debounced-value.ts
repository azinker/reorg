"use client";

import { useEffect, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delay` ms of
 * no further changes. Used to keep typed input snappy while throttling the
 * downstream effects (network requests, expensive recomputes).
 *
 * Why a hook and not a callback wrapper:
 *   - The consuming component still re-renders on every keystroke (so the
 *     <input value={...} /> stays controlled and feels instant).
 *   - But effects that depend on the *debounced* value only re-fire after
 *     the user stops typing — which is what we want for /api/.../tickets?search=.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}
