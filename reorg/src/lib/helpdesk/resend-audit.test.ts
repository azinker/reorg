import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fingerprintSecretForAudit,
  summarizeResendLookup,
} from "./resend-audit";

test("fingerprintSecretForAudit returns a stable non-secret fingerprint", () => {
  const first = fingerprintSecretForAudit("re_secret_key_one");
  const second = fingerprintSecretForAudit("re_secret_key_one");
  const other = fingerprintSecretForAudit("re_secret_key_two");

  assert.equal(first, second);
  assert.equal(first.length, 12);
  assert.notEqual(first, other);
  assert(!first.includes("secret"));
});

test("summarizeResendLookup captures provider state without message content", () => {
  const snapshot = summarizeResendLookup({
    id: "email_123",
    from: "Sales <sales@example.com>",
    to: ["a@example.com"],
    cc: ["b@example.com"],
    bcc: ["c@example.com"],
    created_at: "2026-04-28T17:58:10.000Z",
    last_event: "sent",
  });

  assert.deepEqual(snapshot, {
    lookupOk: true,
    id: "email_123",
    lastEvent: "sent",
    createdAt: "2026-04-28T17:58:10.000Z",
    from: "Sales <sales@example.com>",
    toCount: 1,
    ccCount: 1,
    bccCount: 1,
    error: null,
    statusCode: null,
  });
});

test("summarizeResendLookup records lookup errors safely", () => {
  const snapshot = summarizeResendLookup(null, {
    name: "not_found",
    message: "Email not found",
    statusCode: 404,
  });

  assert.equal(snapshot.lookupOk, false);
  assert.equal(snapshot.error, "not_found: Email not found");
  assert.equal(snapshot.statusCode, 404);
});
