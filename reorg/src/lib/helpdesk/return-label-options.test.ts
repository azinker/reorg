import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultReturnLabelShippingSelection,
  displayServiceClass,
} from "@/lib/helpdesk/return-label-options";
import type { LabelCrowShippingOptions } from "@/lib/label-formatter/labelcrow-options";

const sampleOptions: LabelCrowShippingOptions = {
  serviceClasses: [
    { value: "ground", label: "Ground" },
    { value: "priority", label: "Priority" },
  ],
  providersByServiceClass: {
    ground: [
      { value: "api", label: "API" },
      { value: "Stamps", label: "Stamps" },
    ],
    priority: [{ value: "api", label: "API" }],
  },
  seriesByServiceClass: {
    ground: [
      { value: "9302", label: "9302 — 9302", seriesId: 13 },
      { value: "9201", label: "9201 — 9201", seriesId: 14 },
    ],
    priority: [{ value: "9302", label: "9302 — 9302", seriesId: 15 }],
  },
};

test("defaultReturnLabelShippingSelection prefers ground, api, and 9302", () => {
  assert.deepEqual(defaultReturnLabelShippingSelection(sampleOptions), {
    serviceClass: "ground",
    providerKey: "api",
    seriesCode: "9302",
  });
});

test("displayServiceClass capitalizes service class", () => {
  assert.equal(displayServiceClass("ground"), "Ground");
});
