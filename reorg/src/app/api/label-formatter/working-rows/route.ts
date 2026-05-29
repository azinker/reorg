import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { labelFormatterWorkingRowsSaveSchema } from "@/lib/label-formatter/types";
import {
  listLabelFormatterWorkingRows,
  replaceLabelFormatterWorkingRows,
  type LabelFormatterWorkingRowRecord,
} from "@/lib/label-formatter/working-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

async function getActorUserId() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return session.user.id;
  }
  if (isAuthBypassEnabled()) return (await getSystemUser()).id;
  return null;
}

function serializeRow(row: LabelFormatterWorkingRowRecord) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await listLabelFormatterWorkingRows();
    return NextResponse.json({ data: rows.map(serializeRow) });
  } catch (error) {
    console.error("[label-formatter/working-rows] GET failed", error);
    return NextResponse.json({ error: "Failed to load Label Formatter working rows." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const actorUserId = await getActorUserId();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = labelFormatterWorkingRowsSaveSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid working rows", details: parsed.error.flatten() }, { status: 400 });
    }

    const clientLoadedAt = parsed.data.clientLoadedAt ? new Date(parsed.data.clientLoadedAt) : null;
    const rows = await replaceLabelFormatterWorkingRows(actorUserId, parsed.data.rows, {
      clientLoadedAt: clientLoadedAt && !Number.isNaN(clientLoadedAt.valueOf()) ? clientLoadedAt : null,
      clientKnownRowIds: parsed.data.clientKnownRowIds,
    });
    return NextResponse.json({ data: rows.map(serializeRow) });
  } catch (error) {
    console.error("[label-formatter/working-rows] PUT failed", error);
    return NextResponse.json({ error: "Failed to save Label Formatter working rows." }, { status: 500 });
  }
}
