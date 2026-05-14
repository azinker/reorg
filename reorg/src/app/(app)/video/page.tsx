import { requirePageAccess } from "@/lib/page-access";
import { VideoPageClient } from "./VideoPageClient";

export default async function VideoPage() {
  await requirePageAccess("video");
  return <VideoPageClient />;
}
