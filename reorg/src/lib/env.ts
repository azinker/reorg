export type AppEnv = "local" | "staging" | "production";

export function getAppEnv(): AppEnv {
  const env = process.env.NEXT_PUBLIC_APP_ENV;
  if (env === "staging" || env === "production") return env;
  return "local";
}

export function isProduction(): boolean {
  return getAppEnv() === "production";
}

export function isStaging(): boolean {
  return getAppEnv() === "staging";
}

export function isStagingWriteBlocked(): boolean {
  return isStaging();
}
