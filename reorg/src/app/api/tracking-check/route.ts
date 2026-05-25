import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";
import {
  canUseTrackingCheck,
  runTrackingCheck,
  type TrackingCheckCurlFile,
  type TrackingCheckSourceFile,
} from "@/lib/services/tracking-check";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function asFile(value: FormDataEntryValue): File | null {
  return typeof value === "object" && "arrayBuffer" in value ? value : null;
}

function safeFilename(name: string) {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "tracking-check";
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !canUseTrackingCheck(session.user.email)) {
    return NextResponse.json({ error: "Tracking Check is enabled only for Adam." }, { status: 403 });
  }

  try {
    const form = await request.formData();
    const sourceFiles: TrackingCheckSourceFile[] = [];
    const curlFiles: TrackingCheckCurlFile[] = [];

    for (const entry of form.getAll("files")) {
      const file = asFile(entry);
      if (!file) continue;
      if (!file.name.toLowerCase().endsWith(".xlsx")) continue;
      sourceFiles.push({
        filename: file.name,
        buffer: Buffer.from(await file.arrayBuffer()),
      });
    }

    for (const entry of form.getAll("curlFiles")) {
      const file = asFile(entry);
      if (!file) continue;
      curlFiles.push({
        filename: file.name,
        text: Buffer.from(await file.arrayBuffer()).toString("utf8"),
      });
    }

    const { workbookBuffer, summary } = await runTrackingCheck({
      files: sourceFiles,
      curlFiles,
    });

    const filename = safeFilename(
      `tracking-check-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`,
    );
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: workbookBuffer.length,
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        feature: "tracking-check",
        summary,
      },
    });

    return new NextResponse(new Uint8Array(workbookBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Tracking-Check-Summary": encodeURIComponent(JSON.stringify(summary)),
      },
    });
  } catch (error) {
    console.error("[tracking-check]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tracking Check failed." },
      { status: 500 },
    );
  }
}
