export interface EbayReturnErrorParameter {
  name?: string;
  value?: string;
}

export interface EbayReturnErrorLike {
  errorId?: number | string;
  domain?: string;
  category?: string;
  message?: string;
  parameters?: EbayReturnErrorParameter[];
}

export interface ReturnActionTechnicalDetails {
  source: "EBAY" | "APP";
  message: string | null;
  httpStatus?: number | null;
  ebayRequestId?: string | null;
  ebayErrors?: EbayReturnErrorLike[];
}

export interface NormalizedReturnActionError {
  userMessage: string;
  technicalDetails: ReturnActionTechnicalDetails;
}

function stripEbayPrefix(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.replace(/^eBay\s+\d+:\s*/i, "").trim() || message;
}

export function normalizeReturnActionError(args: {
  source?: "EBAY" | "APP";
  message?: string | null;
  httpStatus?: number | null;
  ebayRequestId?: string | null;
  ebayErrors?: EbayReturnErrorLike[] | null;
}): NormalizedReturnActionError {
  const source = args.source ?? (args.ebayErrors?.length ? "EBAY" : "APP");
  const first = args.ebayErrors?.find((e) => e.message || e.errorId);
  const technicalMessage = stripEbayPrefix(first?.message ?? args.message ?? null);
  const haystack = [technicalMessage, first?.errorId].filter(Boolean).join(" ").toLowerCase();

  let userMessage: string;
  if (haystack.includes("deduction not allowed") || haystack.includes("1760")) {
    userMessage =
      "A refund deduction is not available for this return. Check the return case directly on eBay, then refresh reorG before trying again.";
  } else if (source === "EBAY") {
    userMessage =
      "eBay did not accept this return action. Check the return case directly on eBay, then refresh reorG before trying again.";
  } else {
    userMessage =
      technicalMessage ?? "This return action could not be completed. Refresh the page and try again.";
  }

  return {
    userMessage,
    technicalDetails: {
      source,
      message: technicalMessage,
      httpStatus: args.httpStatus ?? null,
      ebayRequestId: args.ebayRequestId ?? null,
      ebayErrors: args.ebayErrors ?? undefined,
    },
  };
}
