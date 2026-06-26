import type { LabelCrowAccountSeries } from "@/lib/services/labelcrow";

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

/** UI label for a LabelCrow series code (92019 displays as 9201). */
export function labelCrowSeriesDisplayCode(seriesCode: string): string {
  if (seriesCode === "92019") return "9201";
  return seriesCode;
}

function normalizeSeriesCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Ground-only alias: LabelCrow uses 92019 for what the UI shows as 9201. */
function seriesCodesForLookup(seriesCode: string): string[] {
  const normalized = normalizeSeriesCode(seriesCode);
  if (normalized === "9201") return ["9201", "92019"];
  return [normalized];
}

export function findLabelCrowSeries(
  accountSeries: LabelCrowAccountSeries[],
  input: { seriesCode: string; serviceClass: LabelCrowServiceClass },
): LabelCrowAccountSeries | null {
  const service = input.serviceClass.trim().toLowerCase();
  const lookupCodes = new Set(seriesCodesForLookup(input.seriesCode));

  return (
    accountSeries.find((row) => {
      if (row.service_class.toLowerCase() !== service) return false;
      return lookupCodes.has(normalizeSeriesCode(row.series_code));
    }) ?? null
  );
}

export type LabelCrowSeriesOption = {
  value: string;
  label: string;
  seriesId: number;
};

/** Build dropdown options for a service class from live LabelCrow account series. */
export function labelCrowSeriesOptionsForService(
  accountSeries: LabelCrowAccountSeries[],
  serviceClass: LabelCrowServiceClass,
): LabelCrowSeriesOption[] {
  const service = serviceClass.toLowerCase();
  const seen = new Set<string>();

  return accountSeries
    .filter((row) => row.service_class.toLowerCase() === service)
    .flatMap((row) => {
      const displayCode = labelCrowSeriesDisplayCode(row.series_code);
      const key = `${service}:${displayCode}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        value: displayCode,
        seriesId: row.id,
        label: `${displayCode} — ${displayCode}`,
      }];
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function resolveLabelCrowSeriesId(
  accountSeries: LabelCrowAccountSeries[],
  input: { seriesCode: string; serviceClass: LabelCrowServiceClass },
): string {
  const match = findLabelCrowSeries(accountSeries, input);
  if (!match) {
    throw new Error(
      `No LabelCrow series for ${input.seriesCode} (${input.serviceClass}). Pick a different series or service class.`,
    );
  }
  return String(match.id);
}
