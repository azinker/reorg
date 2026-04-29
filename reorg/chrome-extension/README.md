# reorG Catalog Link (Chrome extension)

Opens the reorG catalog and scrolls to the row for the marketplace listing you are viewing.

- **Existing reorG tab on `/catalog`:** the extension focuses that tab and scrolls to the row **without reloading** the page (injects a tiny script in the page context so the catalog receives the same `CustomEvent` as a URL deep link; content scripts alone cannot reach the Next.js app).
- **Existing reorG tab on another route** (e.g. Settings): the tab navigates to the catalog with query params (one load).
- **No reorG tab:** a new tab opens on the catalog with query params.

On eBay, Shopify admin, and BigCommerce admin listing pages, a small **floating “Open in reorG”** button appears in the bottom-right corner (same behavior as the popup).

## Install (load unpacked)

1. Open Chrome → **Extensions** (`chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder: `reorg/chrome-extension` (the folder that contains `manifest.json`).
4. Pin the extension if you want quick access.

## Options

Right-click the extension icon → **Options** (or open from the popup link).

| Setting | Purpose |
|--------|---------|
| **reorG base URL** | Production: `https://reorg.theperfectpart.net`. Local dev: e.g. `http://localhost:3000` (no trailing slash). |
| **Default eBay platform hint** | Public eBay URLs do not indicate TPP vs TT. Chooses which `platform` query param is sent: `TPP_EBAY` or `TT_EBAY`. |
| **BigCommerce admin hostname** | Optional. If set, only that host (e.g. `store-xxxxx.mybigcommerce.com`) is used when parsing BC product edit URLs. If empty, any `*.mybigcommerce.com` admin product URL is accepted. |

## Usage

1. Open a supported listing page (see below).
2. Click the extension icon.
3. Click **Open in reorG**.

You must be logged into reorG in the browser session (same as a normal tab).

## Supported pages

| Marketplace | Example URL shape |
|-------------|-------------------|
| eBay | `https://www.ebay.com/itm/123456789012` |
| Shopify admin | `https://admin.shopify.com/store/.../products/123456789` |
| BigCommerce admin | `https://<store>.mybigcommerce.com/manage/products/edit/123` |

## Deep link URL contract (web app)

The extension navigates to:

```text
{reorgBaseUrl}/catalog?itemId={id}&platform={PLATFORM}
```

- `itemId`: marketplace item / product id (digits only for eBay and Shopify admin; BC numeric id — the server adds `SH-` / `BC-` prefixes when matching).
- `platform` (optional but recommended): `TPP_EBAY`, `TT_EBAY`, `BIGCOMMERCE`, or `SHOPIFY`.

Alias: `platformItemId` is accepted by the catalog as a synonym for `itemId`.

The catalog resolves the row (client-side grid match first, then `GET /api/grid/lookup-item` if needed), scrolls and highlights the row, then removes the query string from the URL.

## Permissions

- **tabs**: find or create the reorG tab and focus it.
- **storage**: save options (base URL, eBay default, BC host).
- **scripting**: run a short **MAIN-world** script on the catalog tab so `window.dispatchEvent` reaches the reorG app (required because extension content scripts are isolated from page JavaScript).
- **host_permissions**: reorG origin, localhost, eBay, Shopify admin, BigCommerce `*.mybigcommerce.com`.

## Development

After changing `manifest.json`, reload the extension on `chrome://extensions`. Content scripts and the background service worker reload when you click **Update** or reload the extension.
