import assert from "node:assert/strict";
import test from "node:test";
import { extractMentionHandles } from "@/lib/helpdesk/mentions";

test("extractMentionHandles finds a single mention at start of body", () => {
  assert.deepEqual(extractMentionHandles("@adam can you check this?"), ["adam"]);
});

test("extractMentionHandles finds a mention after whitespace", () => {
  assert.deepEqual(
    extractMentionHandles("Hey, ping @cory please"),
    ["cory"],
  );
});

test("extractMentionHandles finds multiple distinct mentions", () => {
  const result = extractMentionHandles("@adam and @cory both look at this");
  assert.deepEqual(result.sort(), ["adam", "cory"]);
});

test("extractMentionHandles dedupes case-insensitively", () => {
  assert.deepEqual(
    extractMentionHandles("@Adam wrote, then @adam followed up"),
    ["adam"],
  );
});

test("extractMentionHandles ignores email addresses (no leading whitespace)", () => {
  // 'foo@bar.com' has no whitespace before @, so should not be a mention.
  assert.deepEqual(extractMentionHandles("Email foo@bar.com today"), []);
});

test("extractMentionHandles requires at least 2 chars after @", () => {
  assert.deepEqual(extractMentionHandles("@a is too short"), []);
});

test("extractMentionHandles allows dot, hyphen, underscore", () => {
  assert.deepEqual(
    extractMentionHandles("ping @user.name and @user-two and @under_score"),
    ["user.name", "user-two", "under_score"],
  );
});

test("extractMentionHandles returns empty for body with no mentions", () => {
  assert.deepEqual(extractMentionHandles("Just a normal note."), []);
});
