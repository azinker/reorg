# API Token Guide

reorG needs API access to each marketplace you connect. This guide explains how to get the tokens for eBay (TPP and TT), BigCommerce, and general best practices.

---

## General Best Practices

- **Never share** API keys or tokens. Store them only in `.env` (never in code or git).
- **Use separate apps/tokens** for each environment (local, staging, production) when possible.
- **Rotate tokens** if you suspect they've been exposed.

---

## eBay (TPP and TT)

eBay uses OAuth 2.0. You need an app in the eBay Developer Portal and a refresh token for each account (TPP and TT).

### Step 1: Create an eBay Developer Account

1. Go to [developer.ebay.com](https://developer.ebay.com)
2. Sign in with your eBay account or create one
3. Accept the developer terms if prompted

### Step 2: Create an OAuth Application

1. Go to **My Account** → **Application Keys**
2. Click **Create a new application key**
3. Choose **Production** (or **Sandbox** for testing)
4. Fill in:
   - **App Title:** e.g. "reorG - The Perfect Part"
   - **OAuth redirect URI:** Your app's auth callback (e.g. `https://reorg.theperfectpart.net/api/auth/callback/ebay-tpp`)
5. Save. You’ll get:
   - **App ID** (App ID / Client ID)
   - **Cert ID** (Client Secret)
   - **Dev ID**

Put these in `.env` as `EBAY_TPP_APP_ID`, `EBAY_TPP_CERT_ID`, `EBAY_TPP_DEV_ID`.

**For TT (Telitetech):** Create a second OAuth app or use a second set of keys and store them as `EBAY_TT_APP_ID`, `EBAY_TT_CERT_ID`, `EBAY_TT_DEV_ID`.

### Step 3: Generate a Refresh Token

eBay needs a user to authorize the app once to get a refresh token.

1. Open the OAuth consent URL in your browser. For production, it looks like:
   ```
   https://auth.ebay.com/oauth2/authorize?client_id=YOUR_APP_ID&response_type=code&redirect_uri=YOUR_REDIRECT_URI&scope=https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.marketing.readonly https://api.ebay.com/oauth/api_scope/sell.marketing.readwrite
   ```
   Replace `YOUR_APP_ID` and `YOUR_REDIRECT_URI` with your values.

2. Sign in with the eBay account you want to use (TPP or TT).

3. Approve the app. eBay redirects to your redirect URI with a `code` in the URL.

4. Exchange the `code` for access and refresh tokens using eBay’s token endpoint. reorG may provide a built-in flow for this; otherwise use a script or tool (e.g. Postman) that calls:
   ```
   POST https://api.ebay.com/identity/v1/oauth2/token
   ```
   with `grant_type=authorization_code`, your `code`, `redirect_uri`, and Basic auth using App ID and Cert ID.

5. From the response, copy the **refresh_token** and put it in `.env` as `EBAY_TPP_REFRESH_TOKEN` or `EBAY_TT_REFRESH_TOKEN`.

Refresh tokens are long-lived; reorG uses them to get new access tokens as needed.

**Links:**
- [eBay OAuth Documentation](https://developer.ebay.com/docs/static/oauth-tokens.html)
- [eBay Developer Portal](https://developer.ebay.com/my/keys)

---

## BigCommerce

### Step 1: Open API Account Settings

1. Log in to [BigCommerce Admin](https://login.bigcommerce.com)
2. Go to **Settings** → **API accounts** (or **Store Setup** → **API accounts**)

### Step 2: Create an API Account

1. Click **Create API Account**
2. Choose **V2/V3 API** (or the recommended option)
3. Name it (e.g. "reorG Integration")
4. Set **OAuth Scopes** to at least:
   - **Products:** Read, Modify
   - **Orders:** Read
   - **Catalog:** Read, Modify
   - **Inventory:** Read, Modify
   - **Pricing:** Read, Modify
5. Save. You’ll see:
   - **Access Token** — put in `.env` as `BIGCOMMERCE_ACCESS_TOKEN`
   - **API Path** — includes your store hash (e.g. `https://api.bigcommerce.com/stores/abc123/`); use `abc123` as `BIGCOMMERCE_STORE_HASH`

### Step 3: Get Store Hash

The store hash is in your store URL: `https://store-XXXXX.mybigcommerce.com` → `XXXXX` is the store hash.

---

## Summary: Where Each Token Goes

| Marketplace | Env Variable(s) | Where to Get It |
|-------------|------------------|-----------------|
| eBay TPP | `EBAY_TPP_APP_ID`, `EBAY_TPP_CERT_ID`, `EBAY_TPP_DEV_ID`, `EBAY_TPP_REFRESH_TOKEN` | eBay Developer Portal + OAuth flow |
| eBay TT | `EBAY_TT_APP_ID`, `EBAY_TT_CERT_ID`, `EBAY_TT_DEV_ID`, `EBAY_TT_REFRESH_TOKEN` | Same process, different eBay account |
| BigCommerce | `BIGCOMMERCE_STORE_HASH`, `BIGCOMMERCE_ACCESS_TOKEN` | BigCommerce Admin → API accounts |
| Shopify | See `docs/shopify-setup.md` | Shopify Admin → Apps |
