import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state") || "tpp";
  const error = searchParams.get("error");

  const baseUrl = process.env.AUTH_URL || "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      new URL(`/integrations?ebay=error&message=${encodeURIComponent(error)}`, baseUrl)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/integrations?ebay=error&message=Missing+authorization+code", baseUrl)
    );
  }

  const isTPP = state === "tpp";
  const clientId = isTPP
    ? process.env.EBAY_TPP_APP_ID
    : process.env.EBAY_TT_APP_ID ?? process.env.EBAY_TPP_APP_ID;
  const clientSecret = isTPP
    ? process.env.EBAY_TPP_CERT_ID
    : process.env.EBAY_TT_CERT_ID ?? process.env.EBAY_TPP_CERT_ID;
  const ruName = isTPP
    ? process.env.EBAY_TPP_RUNAME
    : process.env.EBAY_TT_RUNAME ?? process.env.EBAY_TPP_RUNAME;
  const platform = isTPP ? Platform.TPP_EBAY : Platform.TT_EBAY;
  const label = isTPP ? "tpp" : "tt";
  const devId = isTPP
    ? process.env.EBAY_TPP_DEV_ID
    : process.env.EBAY_TT_DEV_ID ?? process.env.EBAY_TPP_DEV_ID;

  if (!clientId || !clientSecret || !ruName) {
    return NextResponse.redirect(
      new URL(`/integrations?ebay=error&message=Server+config+missing+for+${label}`, baseUrl)
    );
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ruName,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error(`[ebay/callback] Token exchange failed for ${label}`, tokenRes.status, text);
      return NextResponse.redirect(
        new URL(`/integrations?ebay=error&message=${encodeURIComponent("Token exchange failed")}`, baseUrl)
      );
    }

    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string = tokenData.refresh_token;
    const expiresIn: number = tokenData.expires_in;
    const refreshExpiresIn: number = tokenData.refresh_token_expires_in;

    if (!accessToken || !refreshToken) {
      return NextResponse.redirect(
        new URL("/integrations?ebay=error&message=No+tokens+in+response", baseUrl)
      );
    }

    await db.integration.update({
      where: { platform },
      data: {
        enabled: true,
        config: {
          appId: clientId,
          certId: clientSecret,
          devId,
          accessToken,
          refreshToken,
          accessTokenExpiresAt: Date.now() + expiresIn * 1000,
          refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
          environment: "PRODUCTION",
        },
      },
    });

    return NextResponse.redirect(
      new URL(`/integrations?ebay=connected&store=${label}`, baseUrl)
    );
  } catch (err) {
    console.error(`[ebay/callback] ${label}`, err);
    return NextResponse.redirect(
      new URL(`/integrations?ebay=error&message=Connection+failed`, baseUrl)
    );
  }
}
