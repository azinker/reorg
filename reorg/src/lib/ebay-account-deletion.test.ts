import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEbayChallengeResponse,
  isValidEbayChallengeResponse,
} from "@/lib/ebay-account-deletion";

test("buildEbayChallengeResponse hashes challenge code, token, and endpoint", () => {
  const response = buildEbayChallengeResponse({
    challengeCode: "abc123",
    verificationToken: "token-xyz",
    endpoint: "https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion",
  });

  assert.equal(
    response,
    "08e0576572be8d1952ffd6fe15b9693ad045712c12c596172fd4efd98d5607d3",
  );
});

test("isValidEbayChallengeResponse only accepts exact matches", () => {
  assert.equal(isValidEbayChallengeResponse("abc", "abc"), true);
  assert.equal(isValidEbayChallengeResponse("abc", "abd"), false);
  assert.equal(isValidEbayChallengeResponse("abc", "ab"), false);
});
