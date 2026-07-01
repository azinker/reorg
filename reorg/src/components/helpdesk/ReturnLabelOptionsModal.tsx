"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import {
  defaultReturnLabelShippingSelection,
  type ReturnLabelShippingSelection,
} from "@/lib/helpdesk/return-label-options";
import {
  defaultLabelCrowShippingSelection,
  labelCrowServiceClassLabel,
  type LabelCrowSelectOption,
  type LabelCrowSeriesOption,
  type LabelCrowShippingOptions,
} from "@/lib/label-formatter/labelcrow-options";

function pickProvider(providers: LabelCrowSelectOption[], current: string): string {
  if (providers.some((option) => option.value === current)) return current;
  return providers[0]?.value ?? "";
}

function pickSeries(seriesOptions: LabelCrowSeriesOption[], current: string): string {
  if (seriesOptions.some((option) => option.value === current)) return current;
  return seriesOptions[0]?.value ?? "";
}

export function ReturnLabelOptionsModal({
  loading,
  onClose,
  onConfirm,
}: {
  loading: boolean;
  onClose: () => void;
  onConfirm: (values: ReturnLabelShippingSelection) => void;
}) {
  const [form, setForm] = useState<ReturnLabelShippingSelection>({
    serviceClass: "",
    providerKey: "",
    seriesCode: "",
  });
  const [shippingOptions, setShippingOptions] = useState<LabelCrowShippingOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      setOptionsLoading(true);
      try {
        const res = await fetch("/api/helpdesk/return-label-shipping-options", { cache: "no-store" });
        const json = (await res.json()) as {
          data?: LabelCrowShippingOptions;
          error?: string;
        };
        if (!res.ok || !json.data) {
          throw new Error(json.error ?? "Could not load LabelCrow shipping options.");
        }
        if (cancelled) return;

        setShippingOptions(json.data);
        setForm(() => {
          const defaults =
            defaultReturnLabelShippingSelection(json.data!)
            ?? defaultLabelCrowShippingSelection(json.data!);
          if (!defaults) {
            return { serviceClass: "", providerKey: "", seriesCode: "" };
          }
          return defaults;
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

  function handleServiceClassChange(serviceClass: string) {
    setForm((current) => {
      const providers = shippingOptions?.providersByServiceClass[serviceClass] ?? [];
      const series = shippingOptions?.seriesByServiceClass[serviceClass] ?? [];
      return {
        serviceClass,
        providerKey: pickProvider(providers, current.providerKey),
        seriesCode: pickSeries(series, current.seriesCode),
      };
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.serviceClass.trim()) {
      setError("Service class is required.");
      return;
    }
    if (!form.providerKey.trim()) {
      setError("Provider is required.");
      return;
    }
    if (!form.seriesCode.trim()) {
      setError("Series is required.");
      return;
    }
    setError(null);
    onConfirm(form);
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-label-options-title"
        className="w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 id="return-label-options-title" className="text-lg font-semibold">
              Generate Return Label
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose LabelCrow USPS options. The label ships from the buyer&apos;s address to our returns department.
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

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Service class</span>
              <select
                value={form.serviceClass}
                onChange={(event) => handleServiceClassChange(event.target.value)}
                disabled={optionsLoading || !shippingOptions?.serviceClasses.length}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading…</option>
                ) : shippingOptions?.serviceClasses.length ? (
                  shippingOptions.serviceClasses.map((option) => (
                    <option key={option.value} value={option.value}>
                      {labelCrowServiceClassLabel(option.value)}
                    </option>
                  ))
                ) : (
                  <option value="">No service classes</option>
                )}
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Provider</span>
              <select
                value={form.providerKey}
                onChange={(event) =>
                  setForm((current) => ({ ...current, providerKey: event.target.value }))
                }
                disabled={optionsLoading || providerOptions.length === 0}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading…</option>
                ) : providerOptions.length ? (
                  providerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No providers</option>
                )}
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Series</span>
              <select
                value={form.seriesCode}
                onChange={(event) =>
                  setForm((current) => ({ ...current, seriesCode: event.target.value }))
                }
                disabled={optionsLoading || seriesOptions.length === 0}
                className="h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-45"
              >
                {optionsLoading ? (
                  <option value="">Loading…</option>
                ) : seriesOptions.length ? (
                  seriesOptions.map((option) => (
                    <option key={`${option.seriesId}-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value="">No series</option>
                )}
              </select>
            </label>
          </div>

          {error ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
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
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Generate Label
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
