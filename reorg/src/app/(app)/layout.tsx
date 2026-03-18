import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { isAuthBypassEnabled } from "@/lib/app-env";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const skipAuth = isAuthBypassEnabled();
  const session = skipAuth ? null : await auth();

  if (!skipAuth && !session?.user) {
    redirect("/login");
  }

  return (
    <AppShell
      user={
        session?.user
          ? {
              id: session.user.id,
              email: session.user.email ?? "",
              name: session.user.name ?? session.user.email ?? "Admin User",
              role: session.user.role,
            }
          : null
      }
    >
      {children}
    </AppShell>
  );
}
