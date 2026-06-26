import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { labelCrowSeriesOptionsForService } from "@/lib/label-formatter/labelcrow-options";
import type { LabelCrowServiceClass } from "@/lib/label-formatter/labelcrow-options";
import { fetchLabelCrowAccountSeries } from "@/lib/services/labelcrow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAllowed() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) return true;
  if (isAuthBypassEnabled()) return Boolean(await db.user.findFirst({ where: { role: "ADMIN" } }));
  return false;
}

export async function GET(request: Request) {
  if (!(await isAllowed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const serviceClass = (new URL(request.url).searchParams.get("serviceClass") ?? "ground") as LabelCrowServiceClass;
    const accountSeries = await fetchLabelCrowAccountSeries();
    const options = labelCrowSeriesOptionsForService(accountSeries, serviceClass);
    return NextResponse.json({ data: { options, serviceClass } });
  } catch (error) {
    console.error("[label-formatter/series] failed", error);
    const message = error instanceof Error ? error.message : "Failed to load LabelCrow series.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
