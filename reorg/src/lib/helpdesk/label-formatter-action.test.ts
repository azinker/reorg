import test from "node:test";
import assert from "node:assert/strict";
import {
  labelFormatterActionNoteSuffix,
  resolveLabelFormatterActionNote,
} from "@/lib/helpdesk/label-formatter-action";

test("resolveLabelFormatterActionNote maps checkboxes to Label Formatter note", () => {
  assert.equal(resolveLabelFormatterActionNote({ inr: false, postageIssue: false }), "");
  assert.equal(resolveLabelFormatterActionNote({ inr: true, postageIssue: false }), "INR CASE");
  assert.equal(resolveLabelFormatterActionNote({ inr: false, postageIssue: true }), "COUNTERFEIT");
  assert.equal(resolveLabelFormatterActionNote({ inr: true, postageIssue: true }), "COUNTERFEIT");
});

test("labelFormatterActionNoteSuffix formats button suffix", () => {
  assert.equal(labelFormatterActionNoteSuffix({ inr: false, postageIssue: true }), " + COUNTERFEIT");
  assert.equal(labelFormatterActionNoteSuffix({ inr: true, postageIssue: false }), " + INR CASE");
});
