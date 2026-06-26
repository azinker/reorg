export const LABELCROW_SERVICE_CLASSES = [
  { value: "ground", label: "Ground" },
  { value: "priority", label: "Priority" },
] as const;

export type LabelCrowServiceClass = (typeof LABELCROW_SERVICE_CLASSES)[number]["value"];

export const LABELCROW_PROVIDERS = [
  { value: "stamps", label: "Stamps" },
  { value: "api", label: "API" },
  { value: "pitneybowes", label: "Pitneybowes" },
] as const;

export type LabelCrowProviderKey = (typeof LABELCROW_PROVIDERS)[number]["value"];

/** LabelCrow series dropdown options (code shown in LabelCrow UI). */
export const LABELCROW_SERIES_OPTIONS = [
  { value: "9121", label: "9121 — 9121" },
  { value: "9155", label: "9155 — 9155" },
  { value: "9201", label: "9201 — 9201" },
  { value: "9202", label: "9202 — 9202" },
  { value: "9300", label: "9300 — 9300" },
  { value: "9302", label: "9302 — 9302" },
  { value: "9434S", label: "9434S — 9434S" },
  { value: "9500", label: "9500 — 9500" },
  { value: "preshipment", label: "Preshipment" },
] as const;

export type LabelCrowSeriesCode = (typeof LABELCROW_SERIES_OPTIONS)[number]["value"];

/** Default series_id env override applies to 9302 only; otherwise use series code. */
export function resolveLabelCrowSeriesId(seriesCode: string): string {
  const normalized = seriesCode.trim();
  if (normalized === "9302") {
    return process.env.LABELCROW_USPS_GROUND_SERIES_ID?.trim() || "13";
  }
  return normalized;
}
