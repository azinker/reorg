import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLabelCrowShippingOptions,
  defaultLabelCrowShippingSelection,
  isValidLabelCrowProviderCombo,
  labelCrowProviderDisplayLabel,
  labelCrowSeriesOptionsForService,
} from "./labelcrow-options";

const SAMPLE_PROVIDERS = [
  { carrier: "usps", service_class: "ground", provider_key: "API" },
  { carrier: "usps", service_class: "ground", provider_key: "Stamps" },
  { carrier: "usps", service_class: "priority", provider_key: "Stamps" },
  { carrier: "usps", service_class: "priority", provider_key: "Pitneybowes" },
  { carrier: "usps", service_class: "priority", provider_key: "Basic" },
] as const;

const SAMPLE_SERIES = [
  { id: 13, series_code: "9302", display_name: null, carrier: "usps", service_class: "ground", provider_key: "" },
  { id: 16, series_code: "9302", display_name: null, carrier: "usps", service_class: "priority", provider_key: "" },
  { id: 1, series_code: "9201", display_name: null, carrier: "usps", service_class: "priority", provider_key: "" },
] as const;

describe("labelcrow-options", () => {
  it("builds service classes and providers from LabelCrow account providers", () => {
    const options = buildLabelCrowShippingOptions([...SAMPLE_PROVIDERS], [...SAMPLE_SERIES]);

    assert.deepEqual(options.serviceClasses.map((row) => row.value), ["ground", "priority"]);
    assert.deepEqual(
      options.providersByServiceClass.ground?.map((row) => row.value),
      ["API", "Stamps"],
    );
    assert.deepEqual(
      options.providersByServiceClass.priority?.map((row) => row.value),
      ["Basic", "Pitneybowes", "Stamps"],
    );
    assert.equal(options.seriesByServiceClass.ground?.[0]?.value, "9302");
    assert.deepEqual(
      options.seriesByServiceClass.priority?.map((row) => row.value),
      ["9201", "9302"],
    );
  });

  it("validates provider combos exactly as returned by LabelCrow", () => {
    assert.equal(
      isValidLabelCrowProviderCombo([...SAMPLE_PROVIDERS], {
        serviceClass: "priority",
        providerKey: "Pitneybowes",
      }),
      true,
    );
    assert.equal(
      isValidLabelCrowProviderCombo([...SAMPLE_PROVIDERS], {
        serviceClass: "priority",
        providerKey: "API",
      }),
      false,
    );
    assert.equal(
      isValidLabelCrowProviderCombo([...SAMPLE_PROVIDERS], {
        serviceClass: "ground",
        providerKey: "api",
      }),
      false,
    );
  });

  it("defaults to the first valid shipping selection", () => {
    const options = buildLabelCrowShippingOptions([...SAMPLE_PROVIDERS], [...SAMPLE_SERIES]);
    assert.deepEqual(defaultLabelCrowShippingSelection(options), {
      serviceClass: "ground",
      providerKey: "API",
      seriesCode: "9302",
    });
  });

  it("formats provider labels for the UI", () => {
    assert.equal(labelCrowProviderDisplayLabel("click_n_ship"), "Click N Ship");
    assert.equal(labelCrowProviderDisplayLabel("API"), "API");
  });

  it("lists series per service class", () => {
    const options = labelCrowSeriesOptionsForService([...SAMPLE_SERIES], "priority");
    assert.deepEqual(options.map((row) => row.value), ["9201", "9302"]);
  });
});
