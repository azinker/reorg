import assert from "node:assert/strict";
import test from "node:test";
import { helpdeskFlagsSnapshot } from "@/lib/helpdesk/flags";

const ENV_KEYS = [
  "HELPDESK_SAFE_MODE",
  "HELPDESK_ENABLE_EBAY_SEND",
  "HELPDESK_ENABLE_RESEND_EXTERNAL",
  "HELPDESK_ENABLE_ATTACHMENTS",
];

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("helpdeskFlagsSnapshot defaults are SAFE", () => {
  withEnv(
    {
      HELPDESK_SAFE_MODE: undefined,
      HELPDESK_ENABLE_EBAY_SEND: undefined,
      HELPDESK_ENABLE_RESEND_EXTERNAL: undefined,
      HELPDESK_ENABLE_ATTACHMENTS: undefined,
    },
    () => {
      const snap = helpdeskFlagsSnapshot();
      assert.equal(snap.safeMode, true);
      assert.equal(snap.enableEbaySend, false);
      assert.equal(snap.enableResendExternal, false);
      assert.equal(snap.enableAttachments, false);
      assert.equal(snap.effectiveCanSendEbay, false);
      assert.equal(snap.effectiveCanSendEmail, false);
    },
  );
});

test("safe mode blocks sends even when individual flags are on", () => {
  withEnv(
    {
      HELPDESK_SAFE_MODE: "true",
      HELPDESK_ENABLE_EBAY_SEND: "true",
      HELPDESK_ENABLE_RESEND_EXTERNAL: "true",
    },
    () => {
      const snap = helpdeskFlagsSnapshot();
      assert.equal(snap.effectiveCanSendEbay, false);
      assert.equal(snap.effectiveCanSendEmail, false);
    },
  );
});

test("disabling safe mode + enabling eBay enables eBay sends only", () => {
  withEnv(
    {
      HELPDESK_SAFE_MODE: "false",
      HELPDESK_ENABLE_EBAY_SEND: "true",
      HELPDESK_ENABLE_RESEND_EXTERNAL: "false",
    },
    () => {
      const snap = helpdeskFlagsSnapshot();
      assert.equal(snap.effectiveCanSendEbay, true);
      assert.equal(snap.effectiveCanSendEmail, false);
    },
  );
});

test("readBool accepts common truthy/falsy strings", () => {
  for (const truthy of ["1", "yes", "on", "TRUE", "True"]) {
    withEnv({ HELPDESK_SAFE_MODE: "false", HELPDESK_ENABLE_EBAY_SEND: truthy }, () => {
      assert.equal(helpdeskFlagsSnapshot().enableEbaySend, true, `expected ${truthy} truthy`);
    });
  }
  for (const falsy of ["0", "no", "off", "FALSE", "False"]) {
    withEnv({ HELPDESK_SAFE_MODE: "false", HELPDESK_ENABLE_EBAY_SEND: falsy }, () => {
      assert.equal(helpdeskFlagsSnapshot().enableEbaySend, false, `expected ${falsy} falsy`);
    });
  }
});

test("invalid string falls back to default", () => {
  withEnv({ HELPDESK_SAFE_MODE: "maybe" }, () => {
    assert.equal(helpdeskFlagsSnapshot().safeMode, true); // fallback default true
  });
});
