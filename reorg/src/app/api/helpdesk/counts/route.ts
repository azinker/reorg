import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildFolderWhere, type HelpdeskFolderKey } from "@/lib/helpdesk/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOLDERS: HelpdeskFolderKey[] = [
  "pre_sales",
  "my_tickets",
  "all_tickets",
  "all_new",
  "all_to_do",
  "all_waiting",
  "buyer_cancellation",
  "from_ebay",
  "snoozed",
  "resolved",
  "unassigned",
  "mentioned",
  "favorites",
  "spam",
  "archived",
];

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ctx = { userId: session.user.id };
  const counts = await Promise.all(
    FOLDERS.map((folder) =>
      db.helpdeskTicket
        .count({ where: buildFolderWhere(folder, ctx) })
        .then((count) => [folder, count] as const),
    ),
  );

  return NextResponse.json({
    data: Object.fromEntries(counts) as Record<HelpdeskFolderKey, number>,
  });
}
