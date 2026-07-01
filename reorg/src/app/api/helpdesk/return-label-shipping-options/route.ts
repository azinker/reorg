import { NextResponse } from "next/server";
import { buildLabelCrowShippingOptions } from "@/lib/label-formatter/labelcrow-options";
import { canUseHelpdeskOrderActionsPermission } from "@/lib/helpdesk/order-actions-permission";
import { getActor } from "@/lib/impersonation";
import {
  fetchLabelCrowAccountProviders,
  fetchLabelCrowAccountSeries,
} from "@/lib/services/labelcrow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canUseHelpdeskOrderActionsPermission(actor)) {
    return NextResponse.json(
      { error: "Return label generation is not enabled for your user." },
      { status: 403 },
    );
  }

  try {
    const [providers, accountSeries] = await Promise.all([
      fetchLabelCrowAccountProviders(),
      fetchLabelCrowAccountSeries(),
    ]);
    const options = buildLabelCrowShippingOptions(providers, accountSeries);
    return NextResponse.json({ data: options });
  } catch (error) {
    console.error("[helpdesk/return-label-shipping-options] failed", error);
    const message = error instanceof Error ? error.message : "Failed to load LabelCrow shipping options.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
