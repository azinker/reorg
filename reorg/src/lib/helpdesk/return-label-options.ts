import { z } from "zod";
import type { LabelCrowShippingOptions } from "@/lib/label-formatter/labelcrow-options";
import { defaultLabelCrowShippingSelection } from "@/lib/label-formatter/labelcrow-options";

export type ReturnLabelShippingSelection = {
  serviceClass: string;
  providerKey: string;
  seriesCode: string;
};

export const returnLabelShippingSelectionSchema = z.object({
  serviceClass: z.string().trim().min(1).max(40),
  providerKey: z.string().trim().min(1).max(40),
  seriesCode: z.string().trim().min(1).max(20),
});

export function defaultReturnLabelShippingSelection(
  options: LabelCrowShippingOptions,
): ReturnLabelShippingSelection | null {
  const fallback = defaultLabelCrowShippingSelection(options);
  if (!fallback) return null;

  const serviceClass = options.serviceClasses.some((row) => row.value === "ground")
    ? "ground"
    : fallback.serviceClass;

  const providers = options.providersByServiceClass[serviceClass] ?? [];
  const series = options.seriesByServiceClass[serviceClass] ?? [];

  const providerKey = providers.some((row) => row.value === "api")
    ? "api"
    : providers.find((row) => row.value === fallback.providerKey)?.value ?? providers[0]?.value;

  const seriesCode = series.some((row) => row.value === "9302")
    ? "9302"
    : series.find((row) => row.value === fallback.seriesCode)?.value ?? series[0]?.value;

  if (!providerKey || !seriesCode) return null;
  return { serviceClass, providerKey, seriesCode };
}

export function displayServiceClass(serviceClass: string): string {
  const normalized = serviceClass.trim().toLowerCase();
  if (!normalized) return serviceClass;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
