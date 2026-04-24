import { NextRequest, NextResponse } from "next/server";

// Base scopes always requested. These are the scopes the app has been
// approved for at the eBay Developer Portal level across every
// environment (keyset), so they never fail the initial consent validation.
const BASE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

// Optional scopes. Each entry here must be enabled on the application's
// User Token consent settings in the eBay Developer Portal before it
// will pass eBay's initial OAuth validation — otherwise the consent
// screen redirects to auth.ebay.com/.../error?errorId=invalid_request
// with "Input request parameters are invalid.". Gate each optional
// scope behind an env flag so we can flip it on once the app keyset has
// been granted the scope without touching code.
//
// commerce.message: drives the modern eBay web UI "Unread from members"
// badge for buyer Q&A. Without it the Commerce Message API wrappers in
// helpdesk-commerce-message.ts return needsReauth=true and we fall
// back to the legacy Trading API ReviseMyMessages path.
const OPTIONAL_SCOPES: Array<{ scope: string; envFlag: string }> = [
  {
    scope: "https://api.ebay.com/oauth/api_scope/commerce.message",
    envFlag: "EBAY_ENABLE_COMMERCE_MESSAGE_SCOPE",
  },
];

function buildScopeList(): string {
  const extras = OPTIONAL_SCOPES.filter(
    (entry) => process.env[entry.envFlag] === "true",
  ).map((entry) => entry.scope);
  return [...BASE_SCOPES, ...extras].join(" ");
}

export async function GET(request: NextRequest) {
  const store = request.nextUrl.searchParams.get("store") || "tpp";
  const isTt = store === "tt";

  const clientId = isTt
    ? process.env.EBAY_TT_APP_ID ?? process.env.EBAY_TPP_APP_ID
    : process.env.EBAY_TPP_APP_ID;

  const ruName = isTt
    ? process.env.EBAY_TT_RUNAME ?? process.env.EBAY_TPP_RUNAME
    : process.env.EBAY_TPP_RUNAME;

  if (!clientId || !ruName) {
    return NextResponse.json(
      {
        error: isTt
          ? "Missing TT eBay app ID or RuName. Add TT-specific values or rely on the shared TPP eBay app fallback."
          : "Missing TPP eBay app ID or RuName in environment",
      },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: "code",
    scope: buildScopeList(),
    state: store,
  });

  const authUrl = `https://auth.ebay.com/oauth2/authorize?${params.toString()}`;

  // Debug mode: append ?debug=1 to see the exact URL + env values being
  // used instead of redirecting. Auth-gated via the surrounding route
  // group so only signed-in users can hit it. Remove once OAuth is
  // confirmed stable again.
  if (request.nextUrl.searchParams.get("debug") === "1") {
    const clientIdFingerprint = clientId
      ? `${clientId.slice(0, 8)}…${clientId.slice(-4)} (len=${clientId.length})`
      : "(missing)";
    const ruNameFingerprint = ruName
      ? `${ruName.slice(0, 20)}${ruName.length > 20 ? "…" : ""} (len=${ruName.length})`
      : "(missing)";
    return NextResponse.json(
      {
        store,
        isTt,
        envVarsUsed: {
          clientIdSource: isTt
            ? process.env.EBAY_TT_APP_ID
              ? "EBAY_TT_APP_ID"
              : "EBAY_TPP_APP_ID (fallback)"
            : "EBAY_TPP_APP_ID",
          ruNameSource: isTt
            ? process.env.EBAY_TT_RUNAME
              ? "EBAY_TT_RUNAME"
              : "EBAY_TPP_RUNAME (fallback)"
            : "EBAY_TPP_RUNAME",
          clientId: clientIdFingerprint,
          ruName: ruNameFingerprint,
        },
        scopesRequested: buildScopeList().split(" "),
        scopeCount: buildScopeList().split(" ").length,
        commerceMessageEnabled:
          process.env.EBAY_ENABLE_COMMERCE_MESSAGE_SCOPE === "true",
        authUrl,
      },
      { status: 200 },
    );
  }

  return NextResponse.redirect(authUrl);
}
