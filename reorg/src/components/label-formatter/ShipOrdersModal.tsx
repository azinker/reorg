"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Truck, X } from "lucide-react";
import {
  defaultLabelCrowShippingSelection,
  type LabelCrowSelectOption,
  type LabelCrowSeriesOption,
  type LabelCrowShippingOptions,
} from "@/lib/label-formatter/labelcrow-options";
import type { LabelFormatterRow, LabelFormatterShipFrom } from "@/lib/label-formatter/types";

const SHIP_FROM_STORAGE_KEY = "reorg.labelFormatter.shipFrom.v1";

export type ShipOrdersFormValues = {
  serviceClass: string;
  providerKey: string;
  seriesCode: string;
  fromAddress: LabelFormatterShipFrom;
};

const DEFAULT_FROM: LabelFormatterShipFrom = {
  name: "",
  street: "",
  aptSuite: "",
  city: "",
  state: "",
  zip: "",
};

function loadStoredFromAddress(): LabelFormatterShipFrom {
  try {
    const raw = window.localStorage.getItem(SHIP_FROM_STORAGE_KEY);
    if (!raw) return DEFAULT_FROM;
    const parsed = JSON.parse(raw) as Partial<LabelFormatterShipFrom>;
    return {
      name: parsed.name ?? "",
      street: parsed.street ?? "",
      aptSuite: parsed.aptSuite ?? "",
      city: parsed.city ?? "",
      state: parsed.state ?? "",
      zip: parsed.zip ?? "",
    };
  } catch {
    return DEFAULT_FROM;
  }
}

function validateForm(form: ShipOrdersFormValues): string | null {
  if (!form.fromAddress.name.trim()) return "Shipper name is required.";
  if (!form.fromAddress.street.trim()) return "Street address is required.";
  if (!form.fromAddress.city.trim()) return "City is required.";
  if (!form.fromAddress.state.trim()) return "State is required.";
  if (!form.fromAddress.zip.trim()) return "Zip is required.";
  if (!form.serviceClass.trim()) return "Service class is required.";
  if (!form.providerKey.trim()) return "Provider is required.";
  if (!form.seriesCode.trim()) return "Series is required.";
  return null;
}

function pickProvider(
  providers: LabelCrowSelectOption[],
  current: string,
): string {
  if (providers.some((option) => option.value === current)) return current;
  return providers[0]?.value ?? "";
}

function pickSeries(
  seriesOptions: LabelCrowSeriesOption[],
  current: string,
): string {
  if (seriesOptions.some((option) => option.value === current)) return current;
  return seriesOptions[0]?.value ?? "";
}

export function ShipOrdersModal({
  rows,
  loading,
  onClose,
  onConfirm,
  marketplacePushTracking,
}: {
  rows: LabelFormatterRow[];
  loading: boolean;
  onClose: () => void;
  onConfirm: (
    values: ShipOrdersFormValues,
    options?: { pushMarketplaceTracking?: boolean },
  ) => void;
  marketplacePushTracking?: {
    label: string;
    defaultChecked?: boolean;
    confirmHint?: string;
  };
}) {
  const [form, setForm] = useState<ShipOrdersFormValues>({
    serviceClass: "",
    providerKey: "",
    seriesCode: "",
    fromAddress: DEFAULT_FROM,
  });
  const [shippingOptions, setShippingOptions] = useState<LabelCrowShippingOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushMarketplaceTracking, setPushMarketplaceTracking] = useState(
    marketplacePushTracking?.defaultChecked ?? false,
  );

  useEffect(() => {
    setForm((current) => ({
      ...current,
      fromAddress: loadStoredFromAddress(),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      setOptionsLoading(true);
      try {
        const res = await fetch("/api/label-formatter/shipping-options", { cache: "no-store" });
        const json = (await res.json()) as {
          data?: LabelCrowShippingOptions;
          error?: string;
        };
        if (!res.ok || !json.data) {
          throw new Error(json.error ?? "Could not load LabelCrow shipping options.");
        }
        if (cancelled) return;

        setShippingOptions(json.data);
        setForm((current) => {
          const defaults = defaultLabelCrowShippingSelection(json.data!);
          if (!defaults) return current;
          return {
            ...current,
            serviceClass: defaults.serviceClass,
            providerKey: defaults.providerKey,
            seriesCode: defaults.seriesCode,
          };
        });
      } catch (loadError) {
        if (!cancelled) {
          setShippingOptions(null);
          setError(loadError instanceof Error ? loadError.message : "Could not load LabelCrow shipping options.");
        }
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    }

    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  const providerOptions = useMemo(
    () => shippingOptions?.providersByServiceClass[form.serviceClass] ?? [],
    [form.serviceClass, shippingOptions],
  );

  const seriesOptions = useMemo(
    () => shippingOptions?.seriesByServiceClass[form.serviceClass] ?? [],
    [form.serviceClass, shippingOptions],
  );

  function updateFromAddress(patch: Partial<LabelFormatterShipFrom>) {
    setForm((current) => ({
      ...current,
      fromAddress: { ...current.fromAddress, ...patch },
    }));
  }

  function handleServiceClassChange(serviceClass: string) {
    setForm((current) => {
      const providers = shippingOptions?.providersByServiceClass[serviceClass] ?? [];
      const series = shippingOptions?.seriesByServiceClass[serviceClass] ?? [];
      return {
        ...current,
        serviceClass,
        providerKey: pickProvider(providers, current.providerKey),
        seriesCode: pickSeries(series, current.seriesCode),
      };
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    try {
      window.localStorage.setItem(SHIP_FROM_STORAGE_KEY, JSON.stringify(form.fromAddress));
    } catch {
      // Non-blocking if storage is unavailable.
    }
    onConfirm(form, marketplacePushTracking
      ? { pushMarketplaceTracking }
      : undefined);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ship-orders-title"
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 id="ship-orders-title" className="text-lg font-semibold">
              Ship Orders via LabelCrow
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create USPS labels for {rows.length} selected order{rows.length === 1 ? "" : "s"}. Downloads a ZIP with one merged labels + packing slips PDF and a data sheet.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Carrier</span>
              <input
                value="USPS"
                readOnly
                className="h-10 w-full cursor-not-allowed rounded-md border border-input bg-muted/40 px-3 text-sm"
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Service Class</span>
              <select
                value={form.serviceClass}
                onChange={(event) => handleServiceClassChange(event.target.value)}
                disabled={optionsLoading || !shippingOptions?.serviceClasses.length}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading service classes…</option>
                ) : shippingOptions?.serviceClasses.length ? (
                  shippingOptions.serviceClasses.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No service classes available</option>
                )}
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Provider</span>
              <select
                value={form.providerKey}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    providerKey: event.target.value,
                  }))
                }
                disabled={optionsLoading || providerOptions.length === 0}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading providers…</option>
                ) : providerOptions.length ? (
                  providerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No providers for this service class</option>
                )}
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Series</span>
              <select
                value={form.seriesCode}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    seriesCode: event.target.value,
                  }))
                }
                disabled={optionsLoading || seriesOptions.length === 0}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading series…</option>
                ) : seriesOptions.length ? (
                  seriesOptions.map((option) => (
                    <option key={`${option.seriesId}-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No series available</option>
                )}
              </select>
            </label>
          </div>

          <fieldset className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-medium">Ship From (Return Address)</legend>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Shipper Name</span>
              <input
                value={form.fromAddress.name}
                onChange={(event) => updateFromAddress({ name: event.target.value })}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Street Address</span>
              <input
                value={form.fromAddress.street}
                onChange={(event) => updateFromAddress({ street: event.target.value })}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Apt / Suite</span>
              <input
                value={form.fromAddress.aptSuite ?? ""}
                onChange={(event) => updateFromAddress({ aptSuite: event.target.value })}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-sm sm:col-span-1">
                <span className="font-medium">City</span>
                <input
                  value={form.fromAddress.city}
                  onChange={(event) => updateFromAddress({ city: event.target.value })}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">State</span>
                <input
                  value={form.fromAddress.state}
                  onChange={(event) => updateFromAddress({ state: event.target.value })}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Zip</span>
                <input
                  value={form.fromAddress.zip}
                  onChange={(event) => updateFromAddress({ zip: event.target.value })}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
            </div>
          </fieldset>

          {error ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : null}

          {marketplacePushTracking ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={pushMarketplaceTracking}
                onChange={(event) => setPushMarketplaceTracking(event.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <span>
                <span className="font-medium">{marketplacePushTracking.label}</span>
                {marketplacePushTracking.confirmHint ? (
                  <span className="mt-1 block text-white/50">{marketplacePushTracking.confirmHint}</span>
                ) : null}
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="inline-flex h-10 cursor-pointer items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || optionsLoading || !form.seriesCode || !form.providerKey}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
              Produce Labels
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
