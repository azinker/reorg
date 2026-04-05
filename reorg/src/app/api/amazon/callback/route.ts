/**
 * Amazon SP-API OAuth callback endpoint.
 *
 * After the seller authorizes the app in Seller Central, Amazon redirects here:
 *   ?spapi_oauth_code=<auth code>
 *   &state=<state>
 *   &selling_partner_id=<seller ID>
 *
 * This route exchanges the code for LWA tokens and saves the refresh token
 * to the AMAZON Integration record (upserts if it doesn't exist yet).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { getDefaultSyncProfile, getEmptySyncState, getEmptyWebhookState } from "@/lib/integrations/runtime-config";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("spapi_oauth_code");
  const sellerId = searchParams.get("selling_partner_id");
  const error = searchParams.get("error");

  const baseUrl =
    process.env.AUTH_URL?.replace(/\/$/, "") || request.nextUrl.origin;

  if (error) {
    return NextResponse.redirect(
      new URL(
        `/integrations?amazon=error&message=${encodeURIComponent(error)}`,
        baseUrl,
      ),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(
        "/integrations?amazon=error&message=Missing+authorization+code",
        baseUrl,
      ),
    );
  }

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("[amazon/callback] Missing AMAZON_LWA_CLIENT_ID or AMAZON_LWA_CLIENT_SECRET");
    return NextResponse.redirect(
      new URL(
        "/integrations?amazon=error&message=Server+config+missing+for+Amazon",
        baseUrl,
      ),
    );
  }

  try {
    const callbackUrl = `${baseUrl}/api/amazon/callback`;

    const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[amazon/callback] Token exchange failed", tokenRes.status, text);
      return NextResponse.redirect(
        new URL(
          `/integrations?amazon=error&message=${encodeURIComponent("Token exchange failed")}`,
          baseUrl,
        ),
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokenData.refresh_token) {
      return NextResponse.redirect(
        new URL(
          "/integrations?amazon=error&message=No+refresh+token+in+response",
          baseUrl,
        ),
      );
    }

    // Upsert the AMAZON integration record
    const existing = await db.integration.findUnique({
      where: { platform: Platform.AMAZON },
      select: { id: true, config: true },
    });

    const baseConfig =
      existing?.config &&
      typeof existing.config === "object" &&
      !Array.isArray(existing.config)
        ? (existing.config as Record<string, unknown>)
        : {
            syncProfile: getDefaultSyncProfile(Platform.AMAZON),
            syncState: getEmptySyncState(),
            webhookState: getEmptyWebhookState(),
          };

    const updatedConfig = {
      ...baseConfig,
      refreshToken: tokenData.refresh_token,
      sellerId: sellerId ?? null,
    };

    if (existing) {
      await db.integration.update({
        where: { platform: Platform.AMAZON },
        data: {
          enabled: true,
          config: updatedConfig as object,
        },
      });
    } else {
      await db.integration.create({
        data: {
          platform: Platform.AMAZON,
          label: "Amazon",
          enabled: true,
          writeLocked: false,
          config: updatedConfig as object,
        },
      });
    }

    console.log(`[amazon/callback] Connected Amazon SP-API for seller ${sellerId ?? "unknown"}`);

    return NextResponse.redirect(
      new URL("/integrations?amazon=connected", baseUrl),
    );
  } catch (err) {
    console.error("[amazon/callback]", err);
    return NextResponse.redirect(
      new URL(
        "/integrations?amazon=error&message=Connection+failed",
        baseUrl,
      ),
    );
  }
}
