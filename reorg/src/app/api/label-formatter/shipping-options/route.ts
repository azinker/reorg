import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { buildLabelCrowShippingOptions } from "@/lib/label-formatter/labelcrow-options";
import {
  fetchLabelCrowAccountProviders,
  fetchLabelCrowAccountSeries,
} from "@/lib/services/labelcrow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) return true;
  if (isAuthBypassEnabled()) return Boolean(await db.user.findFirst({ where: { role: "ADMIN" } }));
  return false;
}

export async function GET() {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [providers, accountSeries] = await Promise.all([
      fetchLabelCrowAccountProviders(),
      fetchLabelCrowAccountSeries(),
    ]);
    const options = buildLabelCrowShippingOptions(providers, accountSeries);
    return NextResponse.json({ data: options });
  } catch (error) {
    console.error("[label-formatter/shipping-options] failed", error);
    const message = error instanceof Error ? error.message : "Failed to load LabelCrow shipping options.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
