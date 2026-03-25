const ADMIN_EMAILS = [
  "adam@theperfectpart.net",
  "coryzz@live.com",
];

export function getAppEnv() {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "staging";

  const authUrl = process.env.AUTH_URL?.toLowerCase();
  if (authUrl?.includes("reorg.theperfectpart.net")) return "production";

  const appEnv = process.env.NEXT_PUBLIC_APP_ENV;
  if (appEnv === "production" || appEnv === "staging") return appEnv;

  return "local";
}

export function isAuthBypassEnabled() {
  if (process.env.SKIP_AUTH !== "true") {
    return false;
  }

  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
    return false;
  }

  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  return getAppEnv() === "local";
}

export function isAdminEmail(email?: string | null) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
