import type {
  LabelCrowAccountProvider,
  LabelCrowAccountSeries,
} from "@/lib/services/labelcrow";

export type LabelCrowServiceClass = string;

export type LabelCrowProviderKey = string;

export type LabelCrowSelectOption = {
  value: string;
  label: string;
};

export type LabelCrowSeriesOption = {
  value: string;
  label: string;
  seriesId: number;
};

export type LabelCrowShippingOptions = {
  serviceClasses: LabelCrowSelectOption[];
  providersByServiceClass: Record<string, LabelCrowSelectOption[]>;
  seriesByServiceClass: Record<string, LabelCrowSeriesOption[]>;
};

/** UI label for a LabelCrow series code (92019 displays as 9201). */
export function labelCrowSeriesDisplayCode(seriesCode: string): string {
  if (seriesCode === "92019") return "9201";
  return seriesCode;
}

export function labelCrowServiceClassLabel(serviceClass: string): string {
  const normalized = serviceClass.trim().toLowerCase();
  if (!normalized) return serviceClass;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function labelCrowProviderDisplayLabel(providerKey: string): string {
  const known: Record<string, string> = {
    API: "API",
    Stamps: "Stamps",
    Pitneybowes: "Pitneybowes",
    Basic: "Basic",
    click_n_ship: "Click N Ship",
    EVS_EasyPost: "EVS EasyPost",
    evs_easypost: "EVS EasyPost",
    shopify_epostage: "Shopify ePostage",
  };
  if (known[providerKey]) return known[providerKey];
  return providerKey
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  input: { seriesCode: string; serviceClass: string },
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

/** Build dropdown options for a service class from live LabelCrow account series. */
export function labelCrowSeriesOptionsForService(
  accountSeries: LabelCrowAccountSeries[],
  serviceClass: string,
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

export function buildLabelCrowShippingOptions(
  providers: LabelCrowAccountProvider[],
  accountSeries: LabelCrowAccountSeries[],
  carrier = "usps",
): LabelCrowShippingOptions {
  const carrierKey = carrier.toLowerCase();
  const uspsProviders = providers.filter((row) => row.carrier.toLowerCase() === carrierKey);

  const serviceClassValues = [...new Set(
    uspsProviders.map((row) => row.service_class.trim().toLowerCase()).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));

  const serviceClasses = serviceClassValues.map((value) => ({
    value,
    label: labelCrowServiceClassLabel(value),
  }));

  const providersByServiceClass: Record<string, LabelCrowSelectOption[]> = {};
  for (const serviceClass of serviceClassValues) {
    const seen = new Set<string>();
    providersByServiceClass[serviceClass] = uspsProviders
      .filter((row) => row.service_class.trim().toLowerCase() === serviceClass)
      .flatMap((row) => {
        if (seen.has(row.provider_key)) return [];
        seen.add(row.provider_key);
        return [{
          value: row.provider_key,
          label: labelCrowProviderDisplayLabel(row.provider_key),
        }];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  const seriesByServiceClass: Record<string, LabelCrowSeriesOption[]> = {};
  for (const serviceClass of serviceClassValues) {
    seriesByServiceClass[serviceClass] = labelCrowSeriesOptionsForService(
      accountSeries,
      serviceClass,
    );
  }

  return {
    serviceClasses,
    providersByServiceClass,
    seriesByServiceClass,
  };
}

export function isValidLabelCrowProviderCombo(
  providers: LabelCrowAccountProvider[],
  input: { carrier?: string; serviceClass: string; providerKey: string },
): boolean {
  const carrier = (input.carrier ?? "usps").toLowerCase();
  const service = input.serviceClass.trim().toLowerCase();
  return providers.some(
    (row) =>
      row.carrier.toLowerCase() === carrier
      && row.service_class.trim().toLowerCase() === service
      && row.provider_key === input.providerKey,
  );
}

export function resolveLabelCrowSeriesId(
  accountSeries: LabelCrowAccountSeries[],
  input: { seriesCode: string; serviceClass: string },
): string {
  const match = findLabelCrowSeries(accountSeries, input);
  if (!match) {
    throw new Error(
      `No LabelCrow series for ${input.seriesCode} (${input.serviceClass}). Pick a different series or service class.`,
    );
  }
  return String(match.id);
}

export function defaultLabelCrowShippingSelection(
  options: LabelCrowShippingOptions,
): { serviceClass: string; providerKey: string; seriesCode: string } | null {
  const serviceClass = options.serviceClasses[0]?.value;
  if (!serviceClass) return null;
  const providerKey = options.providersByServiceClass[serviceClass]?.[0]?.value;
  const seriesCode = options.seriesByServiceClass[serviceClass]?.[0]?.value;
  if (!providerKey || !seriesCode) return null;
  return { serviceClass, providerKey, seriesCode };
}
