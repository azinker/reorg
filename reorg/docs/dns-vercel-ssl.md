# DNS, Vercel, and SSL Setup

This guide walks you through connecting reorG to your domain using GoDaddy and Vercel. By the end, you’ll have:

- **reorg.theperfectpart.net** — production
- **stage.reorg.theperfectpart.net** — staging

Both will use HTTPS (SSL) automatically via Vercel.

---

## Prerequisites

- A GoDaddy account with the domain `theperfectpart.net`
- A Vercel account
- reorG project deployed (or ready to deploy) to Vercel

---

## Part 1: Create Subdomains in GoDaddy

### Step 1: Open DNS Management

1. Log in to [GoDaddy](https://www.godaddy.com)
2. Go to **My Products**
3. Find `theperfectpart.net` and click **DNS**

### Step 2: Add reorg Subdomain (Production)

1. In the DNS records, click **Add** (or **Add Record**)
2. Set:
   - **Type:** `CNAME`
   - **Name:** `reorg`
   - **Value:** `cname.vercel-dns.com`
   - **TTL:** 600 (or default)
3. Save

**Result:** `reorg.theperfectpart.net` will point to Vercel.

### Step 3: Add stage.reorg Subdomain (Staging)

1. Click **Add** again
2. Set:
   - **Type:** `CNAME`
   - **Name:** `stage.reorg` (GoDaddy may also accept `stage.reorg.theperfectpart.net` — use what your DNS panel expects)
   - **Value:** `cname.vercel-dns.com`
   - **TTL:** 600 (or default)
3. Save

**Note:** Some GoDaddy setups require the name as `stage.reorg` (two levels). If that doesn’t work, try `stage` and a host of `reorg.theperfectpart.net`, or check GoDaddy’s subdomain documentation. The goal is for `stage.reorg.theperfectpart.net` to resolve.

---

## Part 2: Connect Domains in Vercel

### Step 1: Import or Select the Project

1. Log in to [Vercel](https://vercel.com)
2. If reorG isn’t deployed yet:
   - Click **Add New** → **Project**
   - Import from Git (GitHub/GitLab) or upload
3. If it’s already deployed, open the reorG project

### Step 2: Add Production Domain

1. Open the project, then **Settings** → **Domains**
2. Click **Add** (or **Add Domain**)
3. Enter: `reorg.theperfectpart.net`
4. Click **Add**
5. Vercel will show the DNS configuration. You’ve already added the CNAME, so it should detect it soon.

### Step 3: Add Staging Domain

1. Click **Add** again
2. Enter: `stage.reorg.theperfectpart.net`
3. Click **Add**
4. Vercel will verify the DNS. If you used the correct CNAME, it will validate.

---

## Part 3: DNS Record Reference

Use this when adding records in GoDaddy:

| Subdomain | Record Type | Name | Value | Purpose |
|-----------|-------------|------|-------|---------|
| reorg | CNAME | reorg | cname.vercel-dns.com | Production |
| stage.reorg | CNAME | stage.reorg | cname.vercel-dns.com | Staging |

**Exact values:**
- **Production CNAME:** Name = `reorg`, Value = `cname.vercel-dns.com`
- **Staging CNAME:** Name = `stage.reorg`, Value = `cname.vercel-dns.com`

---

## Part 4: SSL (HTTPS)

1. Vercel issues SSL certificates automatically for domains added in the project
2. After DNS propagation (often 5–30 minutes), Vercel will show the domain as **Valid**
3. When valid, both `https://reorg.theperfectpart.net` and `https://stage.reorg.theperfectpart.net` will use HTTPS

---

## Visual Summary

```
GoDaddy DNS:
  reorg.theperfectpart.net     → CNAME → cname.vercel-dns.com
  stage.reorg.theperfectpart.net → CNAME → cname.vercel-dns.com

Vercel:
  Project "reorg" → Domains: reorg.theperfectpart.net, stage.reorg.theperfectpart.net
  SSL: Automatic
```

---

## Troubleshooting

**"Domain not configured" or "CNAME not found"**
- Wait 15–30 minutes for DNS propagation
- Confirm the CNAME name and value exactly match the table above
- Use a tool like [whatsmydns.net](https://www.whatsmydns.net) to check if the CNAME is visible globally

**"stage.reorg" doesn’t work as a subdomain**
- GoDaddy sometimes requires `stage.reorg` as a single label. If your panel uses "subdomain" and "domain" separately, enter `stage.reorg` in the subdomain field and leave domain as `theperfectpart.net`

**SSL certificate pending**
- SSL is issued after DNS is correct. Wait until the domain shows as Valid in Vercel

**Wrong project serving the domain**
- In Vercel Domains, make sure each domain is assigned to the correct project (reorG production vs. staging)
