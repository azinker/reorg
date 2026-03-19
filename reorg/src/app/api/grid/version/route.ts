import { NextResponse } from "next/server";
import { getGridVersion } from "@/lib/grid-version";
import { getServerCachedValue } from "@/lib/server-cache";

export async function GET() {
  try {
    const version = await getServerCachedValue({
      key: "api:grid-version",
      ttlMs: 5_000,
      loader: () => getGridVersion(),
    });

    return NextResponse.json({
      data: {
        version,
      },
    });
  } catch (error) {
    console.error("[grid/version] Failed to fetch grid version", error);
    return NextResponse.json(
      { error: "Failed to fetch grid version" },
      { status: 500 },
    );
  }
}
