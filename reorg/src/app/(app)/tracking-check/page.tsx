import { redirect } from "next/navigation";
import { getActor } from "@/lib/impersonation";
import { canUseTrackingCheck } from "@/lib/services/tracking-check";
import { TrackingCheckClient } from "./TrackingCheckClient";

export default async function TrackingCheckPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (!canUseTrackingCheck(actor.email)) {
    redirect("/dashboard?denied=tracking-check");
  }

  return <TrackingCheckClient />;
}
