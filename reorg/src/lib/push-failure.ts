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
};

function normalizeError(error: string | null | undefined) {
  return (error ?? "").trim();
}

export function classifyPushFailure(
  error: string | null | undefined,
  platformLabel?: string | null,
): PushFailureHelp {
  const normalized = normalizeError(error);
  const lower = normalized.toLowerCase();
  const platform = platformLabel ?? "the marketplace";

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
    return {
      category: "rate-limit",
      summary: `${platform} throttled the push because too many requests were sent too quickly.`,
      recommendedAction: "Wait for the cooldown window, then retry only the failed changes.",
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
      recommendedAction: "Review the field value and marketplace rules, then retry with a valid value.",
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
