# Environment Variables Checklist

Use this reference when configuring reorG. Copy `.env.example` to `.env` and fill in the values. **Never commit `.env` to git** — it contains secrets.

---

## Quick Reference Table

| Variable | What It's For | Where to Get It | Required | Example |
|----------|---------------|-----------------|----------|---------|
| **Environment** |
| `NEXT_PUBLIC_APP_ENV` | Tells reorG which environment it's in (affects write locks, staging protection) | You set it | Yes | `local` or `staging` or `production` |
| **Database** |
| `DATABASE_URL` | PostgreSQL connection string for reorG's database | Your PostgreSQL setup | Yes | `postgresql://user:password@localhost:5432/reorg?schema=public` |
| **Auth** |
| `AUTH_SECRET` | Secret key for encrypting sessions and tokens | Run `npx auth secret` in project folder | Yes | Long random string |
| `AUTH_URL` | Base URL of the app (for auth callbacks) | Your deployment URL | Yes | `http://localhost:3000` (local) or `https://reorg.theperfectpart.net` |
| **Email (Resend)** |
| `RESEND_API_KEY` | API key for sending emails (login links, alerts) | [Resend.com](https://resend.com) dashboard | Yes (for magic links) | `re_xxxxxxxxxxxxx` |
| `EMAIL_FROM` | Sender address for reorG emails | Your domain / Resend verified address | Yes (if using email) | `reorG <noreply@theperfectpart.net>` |
| `HELPDESK_RESEND_API_KEY` | Optional dedicated Resend API key for Help Desk External emails. Falls back to `RESEND_API_KEY` if blank. | Resend dashboard -> API Keys | Yes (for Help Desk External email) | `re_xxxxxxxxxxxxx` |
| `HELPDESK_RESEND_FROM` | Sender address for Help Desk External emails | A verified domain in Resend | Yes (for Help Desk External email) | `Sales@theperfectpart.net` |
| **eBay – TPP (The Perfect Part)** |
| `EBAY_TPP_APP_ID` | eBay app ID for TPP account | [eBay Developer Portal](https://developer.ebay.com) | Yes (if using TPP) | Alphanumeric string |
| `EBAY_TPP_CERT_ID` | eBay certificate ID for TPP | eBay Developer Portal | Yes (if using TPP) | Alphanumeric string |
| `EBAY_TPP_DEV_ID` | eBay developer ID for TPP | eBay Developer Portal | Yes (if using TPP) | Alphanumeric string |
| `EBAY_TPP_REFRESH_TOKEN` | OAuth refresh token for TPP | Generated via eBay OAuth flow | Yes (if using TPP) | Long token string |
| `EBAY_TPP_ENVIRONMENT` | Sandbox or production | You choose | Yes | `PRODUCTION` or `SANDBOX` |
| **eBay – TT (Telitetech)** |
| `EBAY_TT_APP_ID` | eBay app ID for TT account | eBay Developer Portal | Yes (if using TT) | Alphanumeric string |
| `EBAY_TT_CERT_ID` | eBay certificate ID for TT | eBay Developer Portal | Yes (if using TT) | Alphanumeric string |
| `EBAY_TT_DEV_ID` | eBay developer ID for TT | eBay Developer Portal | Yes (if using TT) | Alphanumeric string |
| `EBAY_TT_REFRESH_TOKEN` | OAuth refresh token for TT | Generated via eBay OAuth flow | Yes (if using TT) | Long token string |
| `EBAY_TT_ENVIRONMENT` | Sandbox or production | You choose | Yes | `PRODUCTION` or `SANDBOX` |
| **BigCommerce** |
| `BIGCOMMERCE_STORE_HASH` | Your store's unique hash (from URL) | BigCommerce Admin → Store settings | Yes (if using BC) | e.g. `abc123` from `store-abc123.mybigcommerce.com` |
| `BIGCOMMERCE_ACCESS_TOKEN` | API access token | BigCommerce Admin → API accounts | Yes (if using BC) | Long token string |
| `BIGCOMMERCE_WEBHOOK_SECRET` | Shared secret header value for BigCommerce webhooks | You generate it | Yes (for early webhook-triggered pulls) | Long random string |
| **Shopify** |
| `SHOPIFY_STORE_DOMAIN` | Your store's myshopify domain | Shopify Admin URL | Yes (if using Shopify) | `your-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Admin API access token | Shopify Admin → Apps → Create app | Yes (if using Shopify) | Long token string |
| `SHOPIFY_API_VERSION` | Shopify API version to use | [Shopify docs](https://shopify.dev/docs/api/usage/versioning) | Yes (if using Shopify) | `2025-01` |
| `SHOPIFY_WEBHOOK_SECRET` | Secret used to validate Shopify webhook signatures | Shopify app webhook settings | Recommended | Reuse app client secret or set an explicit secret |
| **Cloudflare R2 (Backups)** |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Cloudflare dashboard | Yes (for backups) | 32-character hex string |
| `R2_ACCESS_KEY_ID` | R2 API access key | Cloudflare R2 → Manage R2 API Tokens | Yes (for backups) | Alphanumeric string |
| `R2_SECRET_ACCESS_KEY` | R2 API secret | Created with the access key | Yes (for backups) | Long secret string |
| `R2_BUCKET_NAME` | Name of the backup bucket | You create it in R2 | Yes (for backups) | `reorg-backups` |
| `R2_ENDPOINT` | R2 endpoint URL | Cloudflare R2 bucket settings | Yes (for backups) | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| **Scheduler / Cron** |
| `CRON_SECRET` | Shared secret that authorizes scheduled auto-sync ticks | You generate it | Yes (before auto-sync goes live) | Long random string |
| **Write Safety** |
| `GLOBAL_WRITE_LOCK` | When `true`, all marketplace writes are blocked | You set it | Yes | `true` (safer) or `false` |

---

## Notes

- **Required (Yes)** = The app will fail or that feature won't work without it.
- **Required (Yes – if using X)** = Only needed if you enable that integration.
- Keep `GLOBAL_WRITE_LOCK=true` until you're ready to push changes. See `docs/write-safety-checklist.md`.
- Keep `CRON_SECRET` private. Scheduled calls to `/api/scheduler/tick` must send it in `Authorization: Bearer ...` or `x-cron-secret`.
- BigCommerce webhook callbacks should include `Authorization: Bearer <BIGCOMMERCE_WEBHOOK_SECRET>` or `x-reorg-webhook-secret: <BIGCOMMERCE_WEBHOOK_SECRET>`.
- Shopify webhook callbacks post to `/api/webhooks/shopify` and are validated with Shopify's HMAC signature.
