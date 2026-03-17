# Shopify connection (Dev Dashboard app)

Legacy custom apps are deprecated. Use the **reorG** app you created in the [Shopify Partners Dev Dashboard](https://partners.shopify.com) and connect it via OAuth from reorG.

## 1. Add redirect URL in Partners

1. Open your **reorG** app in the [Dev Dashboard](https://partners.shopify.com).
2. Go to **Versions** → open the active version (or create one).
3. Under **Access** → **Redirect URLs**, add:
   - Local: `http://localhost:3000/api/shopify/callback`
   - Production: `https://your-domain.com/api/shopify/callback`
4. Save / release the version.

## 2. Set environment variables

In `.env`:

```env
SHOPIFY_CLIENT_ID="96b4527c9c1ca47eb77b777f535ab1e9"
SHOPIFY_CLIENT_SECRET="shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
SHOPIFY_STORE_DOMAIN="fd7279"
AUTH_URL="http://localhost:3000"
```

- Use your app’s **Client ID** and **Client secret** from the app’s API credentials in the Dev Dashboard.
- `SHOPIFY_STORE_DOMAIN` is your store handle (e.g. `fd7279`) or full domain (`fd7279.myshopify.com`).
- `AUTH_URL` is the base URL of this app (no trailing slash).

## 3. Connect from reorG

1. Run the app and open **Integrations**.
2. On the **Shopify** card, click **Connect Shopify**.
3. You’ll be sent to Shopify to approve the app; after approving, you’re redirected back and the token is stored in the database.

No need to run the Shopify CLI or embed the app in the admin. The “Open app” blank page in the admin is expected; reorG uses the API only.
