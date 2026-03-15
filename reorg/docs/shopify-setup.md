# Shopify Setup Guide

This guide walks you through creating Admin API access for reorG so it can read and update your Shopify products and inventory.

---

## Why These Steps Matter

Shopify uses custom apps with scoped API access. You create an app, assign the right permissions (scopes), install it, and then copy the access token into reorG.

---

## Step 1: Open Shopify Admin

1. Log in to your Shopify store
2. Go to **Settings** (gear icon in the bottom-left)

---

## Step 2: Go to Apps and Sales Channels

1. In the left sidebar, click **Apps and sales channels**
2. Click **Develop apps**
3. If you see "Develop apps for your store," click it to enable development

---

## Step 3: Create an App

1. Click **Create an app** → **Create an app manually**
2. Name it (e.g. "reorG")
3. Click **Create app**

---

## Step 4: Configure Admin API Scopes

1. Open the app you just created
2. Click **Configure Admin API scopes**
3. Under **Admin API integration**, add these scopes:

| Scope | Why reorG Needs It |
|-------|---------------------|
| `read_products` | Read product titles, SKUs, prices, and basic info |
| `write_products` | Update prices and other product fields when you push changes |
| `read_inventory` | Read inventory levels |
| `write_inventory` | Update inventory when you push changes |

4. Add only these scopes. Do not enable more than reorG needs.
5. Click **Save**

---

## Step 5: Install the App

1. Click **Install app** (top right)
2. Review the permissions
3. Click **Install** to confirm

---

## Step 6: Get the Access Token

1. After installation, you’ll see **API credentials**
2. Click **Reveal token once** (or similar) to show the **Admin API access token**
3. Copy the token immediately — Shopify may show it only once
4. Put it in your `.env` file as:
   ```
   SHOPIFY_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

---

## Step 7: Set Store Domain

1. Your store domain is in the URL when you’re in Shopify Admin
2. It looks like: `your-store-name.myshopify.com`
3. Put it in `.env` as:
   ```
   SHOPIFY_STORE_DOMAIN="your-store-name.myshopify.com"
   ```
   Do not include `https://` — only the domain.

---

## Step 8: API Version (Optional)

reorG uses a specific API version. In `.env` you should have:

```
SHOPIFY_API_VERSION="2025-01"
```

This is usually set in `.env.example`. Only change it if reorG instructs you to.

---

## Summary Checklist

- [ ] App created in Shopify Admin
- [ ] Scopes added: `read_products`, `write_products`, `read_inventory`, `write_inventory`
- [ ] App installed
- [ ] Access token copied to `SHOPIFY_ACCESS_TOKEN` in `.env`
- [ ] Store domain set as `SHOPIFY_STORE_DOMAIN` in `.env`

---

## Troubleshooting

**"Access token not shown"**  
If you missed copying the token, uninstall the app and install it again. A new token will be shown.

**"401 Unauthorized"**  
- Confirm the token is correct and not expired  
- Ensure the app is still installed  
- Check that all required scopes are enabled  

**"403 Forbidden" on certain actions**  
- Verify you have both read and write scopes for the resources you’re using (products, inventory)
