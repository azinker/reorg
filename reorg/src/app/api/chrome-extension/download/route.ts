import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import archiver from "archiver";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function zipExtensionDirectory(): Promise<Buffer> {
  const root = join(process.cwd(), "chrome-extension");
  if (!existsSync(root)) {
    throw new Error("Extension directory missing");
  }

  const archive = archiver("zip", { zlib: { level: 9 } });
  const pass = new PassThrough();
  const chunks: Buffer[] = [];
  pass.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  archive.on("error", (err: Error) => {
    pass.destroy(err);
  });
  archive.pipe(pass);

  // Put files at the zip root so after "Extract here" / "Extract all", the chosen folder
  // always contains manifest.json (avoids users selecting a parent folder that only wraps
  // `reorg-chrome-extension/` and triggers "Manifest file is missing or unreadable").
  archive.directory(root, false);
  await archive.finalize();
  await finished(pass);
  return Buffer.concat(chunks);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id && !isAuthBypassEnabled()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const buffer = await zipExtensionDirectory();
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: buffer.length,
      metadata: { contentType: "application/zip" },
    });
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="reorg-chrome-extension.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[chrome-extension download]", error);
    return NextResponse.json(
      { error: "Extension package could not be built. Contact an administrator." },
      { status: 500 },
    );
  }
}
