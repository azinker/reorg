import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Per-agent Help Desk preferences that need to live on the server (as
 * opposed to the localStorage-only prefs in HelpdeskSettingsDialog).
 *
 * v1 only persists `defaultSendStatus` — the action the composer's primary
 * "Send" button performs. Stored on `User.helpdeskDefaultSendStatus`
 * (added in the schema_v2 migration).
 *
 * We keep this route deliberately tiny so future server-side prefs (e.g.
 * notification routing, signature) can land here without touching the
 * route shape.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEND_STATUS_VALUES = ["RESOLVED", "WAITING", "NONE"] as const;
type SendStatus = (typeof SEND_STATUS_VALUES)[number];

const patchSchema = z.object({
  defaultSendStatus: z.enum(SEND_STATUS_VALUES).optional(),
});

interface PrefsPayload {
  defaultSendStatus: SendStatus;
}

const DEFAULTS: PrefsPayload = {
  // Per the v2 spec, "Send" is the resolve-and-move-on default. Agents
  // who reply expecting a buyer follow-up flip this to WAITING; agents
  // who don't want any auto-status flip pick NONE.
  defaultSendStatus: "RESOLVED",
};

function normalize(raw: string | null | undefined): SendStatus {
  if (raw === "WAITING" || raw === "NONE" || raw === "RESOLVED") return raw;
  return DEFAULTS.defaultSendStatus;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { helpdeskDefaultSendStatus: true },
  });
  const payload: PrefsPayload = {
    defaultSendStatus: normalize(user?.helpdeskDefaultSendStatus),
  };
  return NextResponse.json({ data: payload });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  // Only fields actually present in the patch are written so a future
  // client that ships a single-field PATCH doesn't accidentally clobber
  // unrelated defaults.
  const data: { helpdeskDefaultSendStatus?: string } = {};
  if (parsed.data.defaultSendStatus !== undefined) {
    data.helpdeskDefaultSendStatus = parsed.data.defaultSendStatus;
  }
  if (Object.keys(data).length === 0) {
    // Treat empty patch as a no-op rather than an error so the client can
    // fire-and-forget without checking diffs.
    return NextResponse.json({ ok: true });
  }
  const user = await db.user.update({
    where: { id: session.user.id },
    data,
    select: { helpdeskDefaultSendStatus: true },
  });
  return NextResponse.json({
    data: {
      defaultSendStatus: normalize(user.helpdeskDefaultSendStatus),
    } satisfies PrefsPayload,
  });
}
