import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExternalEmailDraft,
  parseExternalEmailList,
  readExternalEmailDraftFromMetadata,
} from "./external-email-fields";

describe("external email fields", () => {
  it("parses comma, semicolon, newline, and display-name email lists", () => {
    const parsed = parseExternalEmailList(
      "buyer@example.com; Sales Lead <lead@example.com>\nsecond@example.com",
    );

    assert.deepEqual(parsed.emails, [
      "buyer@example.com",
      "lead@example.com",
      "second@example.com",
    ]);
    assert.deepEqual(parsed.invalid, []);
  });

  it("requires at least one To recipient", () => {
    const result = normalizeExternalEmailDraft({
      to: "",
      cc: "cc@example.com",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /To recipient/);
    }
  });

  it("returns normalized draft fields", () => {
    const result = normalizeExternalEmailDraft({
      to: "buyer@example.com",
      cc: "copy@example.com",
      bcc: "hidden@example.com",
      subject: "  Hello  ",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.draft, {
        to: ["buyer@example.com"],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Hello",
      });
    }
  });

  it("reads persisted outbound job metadata", () => {
    const draft = readExternalEmailDraftFromMetadata({
      externalEmail: {
        to: ["buyer@example.com"],
        cc: [],
        bcc: ["hidden@example.com"],
        subject: "Ticket follow-up",
      },
    });

    assert.deepEqual(draft, {
      to: ["buyer@example.com"],
      cc: [],
      bcc: ["hidden@example.com"],
      subject: "Ticket follow-up",
    });
  });
});
