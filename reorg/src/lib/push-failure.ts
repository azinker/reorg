export type PushFailureCategory =
  | "write-safety"
  | "auth"
  | "rate-limit"
  | "timeout"
  | "validation"
  | "marketplace"
  | "unknown";

export type PushFailureHelp = {
  category: PushFailureCategory;
  summary: string;
  recommendedAction: string;
  /** True when the pushed value is pre-validated as invalid format (e.g. bad UPC digit count). */
  isFormatInvalid?: boolean;
};

function normalizeError(error: string | null | undefined) {
  return (error ?? "").trim();
}

/**
 * Validate UPC format locally without calling eBay.
 * Valid formats: 12-digit UPC-A or 13-digit EAN-13, digits only.
 * Returns null if valid, or a human-readable reason if invalid.
 */
export function validateUpcFormat(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return "No UPC value provided.";
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return `"${str}" contains non-digit characters — UPCs must be numbers only.`;
  if (str.length === 12) return null; // valid UPC-A
  if (str.length === 13) return null; // valid EAN-13
  if (str.length < 12) return `"${str}" is only ${str.length} digit${str.length === 1 ? "" : "s"} — UPCs must be 12 digits (UPC-A) or 13 digits (EAN-13). This value is too short and will be rejected by eBay.`;
  return `"${str}" is ${str.length} digits — UPCs must be 12 digits (UPC-A) or 13 digits (EAN-13). This value is too long and will be rejected by eBay.`;
}

export function classifyPushFailure(
  error: string | null | undefined,
  platformLabel?: string | null,
  options?: { field?: string; newValue?: string | number | null },
): PushFailureHelp {
  const normalized = normalizeError(error);
  const lower = normalized.toLowerCase();
  const platform = platformLabel ?? "the marketplace";

  // Pre-validate UPC format locally — if invalid, classify as validation regardless
  // of what eBay returned (e.g. rate-limit errors still hide the real rejection cause).
  if (options?.field === "upc") {
    const formatError = validateUpcFormat(options.newValue);
    if (formatError) {
      return {
        category: "validation",
        summary: `Invalid UPC format — ${platform} will reject this value even after the rate limit resets.`,
        recommendedAction: `${formatError} Use "Save Locally" to store it on the dashboard without pushing to ${platform}.`,
        isFormatInvalid: true,
      };
    }
  }

  if (!normalized) {
    return {
      category: "unknown",
      summary: "The marketplace push failed without a detailed error.",
      recommendedAction: `Open Engine Room and retry after checking ${platform} connectivity and write safety.`,
    };
  }

  if (
    lower.includes("write lock") ||
    lower.includes("live push disabled") ||
    lower.includes("blocked")
  ) {
    return {
      category: "write-safety",
      summary: "Write safety blocked this push before it reached the marketplace.",
      recommendedAction: "Check Global Write Lock, store write lock, and Live Push Enabled before retrying.",
    };
  }

  if (
    lower.includes("not the seller") ||
    lower.includes("only sellers allowed")
  ) {
    return {
      category: "auth",
      summary: `${platform} says you are not the seller of this item.`,
      recommendedAction: `This item ID may belong to a different eBay account. Verify the item is listed under the correct store and that you are pushing via the right integration token.`,
    };
  }

  if (
    lower.includes("auth") ||
    lower.includes("token") ||
    lower.includes("credential") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      category: "auth",
      summary: `${platform} rejected the push credentials.`,
      recommendedAction: `Check the ${platform} integration credentials and reconnect or retest the integration before retrying.`,
    };
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("usage limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    const upcNote = options?.field === "upc"
      ? " If the UPC value is valid format (12 or 13 digits), it will push once the limit resets. If the format is wrong, use Save Locally instead."
      : "";
    return {
      category: "rate-limit",
      summary: `${platform} throttled the push because the daily API call limit was reached.`,
      recommendedAction: `Wait for the eBay API quota to reset (typically daily), then retry.${upcNote}`,
    };
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      category: "timeout",
      summary: `${platform} did not answer before the push timed out.`,
      recommendedAction: "Retry the failed change. If it repeats, check marketplace/API responsiveness in Integrations or Engine Room.",
    };
  }

  if (
    lower.includes("invalid") ||
    lower.includes("must be") ||
    lower.includes("required") ||
    lower.includes("unprocessable") ||
    lower.includes("validation")
  ) {
    return {
      category: "validation",
      summary: `${platform} rejected the pushed value.`,
      recommendedAction: "Review the field value and marketplace rules, then retry with a valid value or use Save Locally.",
    };
  }

  if (
    lower.includes("rejected") ||
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("bad request")
  ) {
    return {
      category: "marketplace",
      summary: `${platform} rejected the push request.`,
      recommendedAction: "Review the marketplace response and retry after correcting the issue shown below.",
    };
  }

  return {
    category: "unknown",
    summary: "The push failed for an uncategorized reason.",
    recommendedAction: `Review the raw ${platform} error and retry once the cause is clear.`,
  };
}
