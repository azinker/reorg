/**
 * Amazon SP-API OAuth start endpoint.
 *
 * When the user clicks "Authorize" in Amazon Developer Central, Amazon redirects
 * the browser here with:
 *   ?amazon_callback_uri=<Amazon consent URL>
 *   &amazon_state=<opaque state>
 *   &selling_partner_id=<seller ID>
 *   &version=beta
 *
 * This route redirects the browser to Amazon's consent page, passing our
 * callback URI so Amazon knows where to send the auth code.
 */

import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const amazonCallbackUri = searchParams.get("amazon_callback_uri");
  const amazonState = searchParams.get("amazon_state");

  const baseUrl =
    process.env.AUTH_URL?.replace(/\/$/, "") || request.nextUrl.origin;

  if (!amazonCallbackUri || !amazonState) {
    return NextResponse.redirect(
      new URL(
        "/integrations?amazon=error&message=Missing+Amazon+OAuth+parameters",
        baseUrl,
      ),
    );
  }

  const callbackUrl = `${baseUrl}/api/amazon/callback`;

  // Redirect to Amazon's consent page
  const consentUrl = new URL(amazonCallbackUri);
  consentUrl.searchParams.set("amazon_state", amazonState);
  consentUrl.searchParams.set("redirect_uri", callbackUrl);

  return NextResponse.redirect(consentUrl.toString());
}
