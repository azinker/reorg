const PRODUCTION_TRADING_API = "https://api.ebay.com/ws/api.dll";
const SANDBOX_TRADING_API = "https://api.sandbox.ebay.com/ws/api.dll";
const PRODUCTION_IDENTITY_API = "https://api.ebay.com/identity/v1/oauth2/token";
const SANDBOX_IDENTITY_API = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

function matchXmlValue(xml: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTag}>([^<]+)</${escapedTag}>`, "i"));
  return match?.[1] ?? null;
}

export async function fetchEbaySellerProfile(
  accessToken: string,
  environment: "SANDBOX" | "PRODUCTION" = "PRODUCTION",
) {
  const tradingUrl =
    environment === "SANDBOX" ? SANDBOX_TRADING_API : PRODUCTION_TRADING_API;

  const response = await fetch(tradingUrl, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": accessToken,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
      "X-EBAY-API-CALL-NAME": "GetUser",
      "Content-Type": "text/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
</GetUserRequest>`,
  });

  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`GetUser failed: ${response.status} ${xml.slice(0, 300)}`);
  }

  return {
    userId: matchXmlValue(xml, "UserID"),
    storeName: matchXmlValue(xml, "StoreName"),
    sellerLevel: matchXmlValue(xml, "SellerLevel"),
  };
}

export async function refreshEbayAccessToken({
  appId,
  certId,
  refreshToken,
  environment = "PRODUCTION",
}: {
  appId: string;
  certId: string;
  refreshToken: string;
  environment?: "SANDBOX" | "PRODUCTION";
}) {
  const identityUrl =
    environment === "SANDBOX" ? SANDBOX_IDENTITY_API : PRODUCTION_IDENTITY_API;
  const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");

  const response = await fetch(identityUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const payloadText = await response.text();
  if (!response.ok) {
    throw new Error(`eBay token refresh failed: ${response.status} ${payloadText.slice(0, 300)}`);
  }

  const payload = JSON.parse(payloadText) as {
    access_token: string;
    expires_in?: number;
  };

  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in ?? 7200,
  };
}
