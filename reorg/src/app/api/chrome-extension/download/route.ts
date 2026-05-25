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

const EXTENSION_PACKAGES = {
  "catalog-link": {
    root: "chrome-extension",
    filename: "reorg-chrome-extension.zip",
  },
  "sale-history": {
    root: "chrome-extensions/sale-history",
    filename: "tpp-ebay-sold-history-extension.zip",
  },
  skuvault: {
    root: "chrome-extensions/skuvault",
    filename: "skuvault-quick-adjust-extension.zip",
  },
  "tracking-check": {
    root: "chrome-extensions/tracking-check",
    filename: "reorg-tracking-check-helper.zip",
  },
} as const;

type ExtensionPackageId = keyof typeof EXTENSION_PACKAGES;

function getExtensionPackageId(value: string | null): ExtensionPackageId {
  if (value && value in EXTENSION_PACKAGES) {
    return value as ExtensionPackageId;
  }
  return "catalog-link";
}

async function zipExtensionDirectory(packageId: ExtensionPackageId): Promise<Buffer> {
  const root = join(process.cwd(), EXTENSION_PACKAGES[packageId].root);
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

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id && !isAuthBypassEnabled()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const packageId = getExtensionPackageId(url.searchParams.get("extension"));
  const filename = EXTENSION_PACKAGES[packageId].filename;

  try {
    const buffer = await zipExtensionDirectory(packageId);
    queueCurrentRequestBinaryResponseSample({
      bytesEstimate: buffer.length,
      metadata: { contentType: "application/zip", extensionPackage: packageId },
    });
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[chrome-extension download]", { packageId, error });
    return NextResponse.json(
      { error: "Extension package could not be built. Contact an administrator." },
      { status: 500 },
    );
  }
}
