import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatHelpdeskFromAddress,
  renderExternalEmailHtml,
} from "./external-email-render";

test("formatHelpdeskFromAddress adds a display name to a bare address", () => {
  assert.equal(
    formatHelpdeskFromAddress("Sales@theperfectpart.net"),
    "The Perfect Part Help Desk <Sales@theperfectpart.net>",
  );
});

test("formatHelpdeskFromAddress preserves an already formatted mailbox", () => {
  assert.equal(
    formatHelpdeskFromAddress("Sales <Sales@theperfectpart.net>"),
    "Sales <Sales@theperfectpart.net>",
  );
});

test("renderExternalEmailHtml escapes body text and includes reply guidance", () => {
  const html = renderExternalEmailHtml("Hello <Adam>\nThanks");

  assert.match(html, /Hello &lt;Adam&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /Reply directly to this email/);
});
