import { NextRequest, NextResponse } from "next/server";

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  // Needed for the Help Desk read/unread mirror against the modern web UI
  // "From members" / "Unread from members" store. The legacy Trading API
  // ReviseMyMessages only flips a separate flag that doesn't always drive
  // the web UI badge for modern buyer Q&A threads — so we use the Commerce
  // Message API (updateConversation) to flip what agents actually see on
  // ebay.com/mesg. Integrations must be re-authorized once for their
  // refresh tokens to carry this scope; older tokens keep working for every
  // other call but will 403 against /commerce/message/v1 until re-auth.
  "https://api.ebay.com/oauth/api_scope/commerce.message",
].join(" ");

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
    scope: SCOPES,
    state: store,
  });

  const authUrl = `https://auth.ebay.com/oauth2/authorize?${params.toString()}`;

  return NextResponse.redirect(authUrl);
}
