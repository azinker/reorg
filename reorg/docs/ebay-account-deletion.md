# eBay Marketplace Account Deletion Setup

eBay requires production apps to support Marketplace Account Deletion notifications.
For reorG, use the live production URL below once the latest code is deployed:

- Notification endpoint: `https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion`

## What To Put In Vercel

Add these production environment variables:

- `EBAY_MARKETPLACE_ACCOUNT_DELETION_ENDPOINT=https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion`
- `EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN=<your own random secret>`

Keep the verification token exactly the same in:

- Vercel production environment variables
- the eBay Developer Portal field for this notification

## How The Endpoint Works

1. eBay sends a `GET` request with `challenge_code`.
2. reorG hashes `challenge_code + verification_token + endpoint_url`.
3. reorG returns:

```json
{
  "challengeResponse": "<sha256 hash>"
}
```

4. Later, eBay sends account deletion notifications as `POST` requests.
5. reorG accepts the payload and records it in the audit log.

## eBay Developer Portal Values

Use these values for the live app:

- Application URL: `https://reorg.theperfectpart.net`
- Marketplace account deletion notification endpoint:
  `https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion`
- Exempted from Marketplace Account Deletion: `OFF`

## Quick Test After Deploy

Open this URL in the browser after production deploy, replacing `TEST123` with any sample value:

```text
https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion?challenge_code=TEST123
```

Expected result:

- HTTP `200`
- JSON body with `challengeResponse`

If that works, the endpoint is live and ready for eBay verification.
