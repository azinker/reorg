import { requirePageAccess } from "@/lib/page-access";
import { LabelFormatterClient } from "@/app/(app)/label-formatter/LabelFormatterClient";

export default async function LabelFormatterPage() {
  await requirePageAccess("label-formatter");
  return <LabelFormatterClient />;
}
