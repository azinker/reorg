import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { getActor } from "@/lib/impersonation";
import { isPageKey, resolveAllowedPageKeys } from "@/lib/nav-pages";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const skipAuth = isAuthBypassEnabled();
  const actor = skipAuth ? null : await getActor();

  if (!skipAuth && !actor) {
    redirect("/login");
  }

  const allowedPageKeys = actor
    ? Array.from(
        resolveAllowedPageKeys({
          role: actor.role,
          pagePermissions: actor.pagePermissions,
        }),
      )
    : null;

  if (actor?.isImpersonating && allowedPageKeys) {
    const hdrs = await headers();
    const requestedKey = hdrs.get("x-reorg-page-key");
    if (requestedKey && isPageKey(requestedKey)) {
      const allowedSet = new Set(allowedPageKeys);
      if (!allowedSet.has(requestedKey)) {
        redirect(`/dashboard?denied=${encodeURIComponent(requestedKey)}`);
      }
    }
  }

  return (
    <AppShell
      user={
        actor
          ? {
              id: actor.userId,
              email: actor.email,
              name: actor.name,
              role: actor.role,
            }
          : null
      }
      allowedPageKeys={allowedPageKeys}
      impersonation={
        actor?.isImpersonating
          ? {
              realName: actor.realName,
              realEmail: actor.realEmail,
            }
          : null
      }
    >
      {children}
    </AppShell>
  );
}
