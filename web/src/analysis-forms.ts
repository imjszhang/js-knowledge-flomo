import { useEffect, useState } from "react";

/** Inputs are scoped to a workspace so a refresh or failed request never clears them. */
export function useAnalysisInput<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? initial; }
    catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Navigation guards still protect in-memory input if storage is unavailable. */ }
  }, [key, value]);
  return [value, setValue] as const;
}

export function splitDiscoveryTerms(value: string) {
  return [...new Set(value.split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))];
}
