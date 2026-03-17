import { NextResponse } from "next/server";

export async function GET() {
  const appId = process.env.EBAY_TPP_APP_ID;
  const certId = process.env.EBAY_TPP_CERT_ID;
  const refreshToken = process.env.EBAY_TPP_REFRESH_TOKEN;

  if (!appId || !certId || !refreshToken) {
    return NextResponse.json({ ok: false, message: "Missing eBay credentials" });
  }

  try {
    const credentials = Buffer.from(`${appId}:${certId}`).toString("base64");

    const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
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

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return NextResponse.json({
        ok: false,
        message: `Token exchange failed: ${tokenRes.status}`,
        details: errText.slice(0, 500),
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userRes = await fetch(
      "https://api.ebay.com/ws/api.dll",
      {
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
      }
    );

    const userXml = await userRes.text();
    const userIdMatch = userXml.match(/<UserID>([^<]+)<\/UserID>/);
    const storeNameMatch = userXml.match(/<StoreName>([^<]+)<\/StoreName>/);
    const sellerLevelMatch = userXml.match(/<SellerLevel>([^<]+)<\/SellerLevel>/);

    const countRes = await fetch(
      "https://api.ebay.com/ws/api.dll",
      {
        method: "POST",
        headers: {
          "X-EBAY-API-IAF-TOKEN": accessToken,
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
          "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
          "Content-Type": "text/xml",
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>1</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`,
      }
    );

    const countXml = await countRes.text();
    const totalMatch = countXml.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);

    return NextResponse.json({
      ok: true,
      seller: {
        userId: userIdMatch?.[1] ?? "unknown",
        storeName: storeNameMatch?.[1] ?? null,
        sellerLevel: sellerLevelMatch?.[1] ?? null,
      },
      activeListings: totalMatch ? parseInt(totalMatch[1]) : null,
      tokenExpiresIn: tokenData.expires_in,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
