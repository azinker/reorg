import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const skipAuth = process.env.SKIP_AUTH === "true";

  if (!skipAuth) {
    const session = await auth();
    if (!session?.user) {
      redirect("/login");
    }
  }

  return <AppShell>{children}</AppShell>;
}
