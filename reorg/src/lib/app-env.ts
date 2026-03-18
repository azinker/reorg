const ADMIN_EMAILS = [
  "adam@theperfectpart.net",
  "coryzz@live.com",
  "cory@theperfectpart.net",
];

export function getAppEnv() {
  return process.env.NEXT_PUBLIC_APP_ENV ?? "local";
}

export function isAuthBypassEnabled() {
  return process.env.SKIP_AUTH === "true" && getAppEnv() === "local";
}

export function isAdminEmail(email?: string | null) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
