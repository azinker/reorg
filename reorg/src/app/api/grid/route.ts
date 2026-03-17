import { NextResponse } from "next/server";
import { getGridData } from "@/lib/grid-query";

export async function GET() {
  try {
    const rows = await getGridData();
    return NextResponse.json({ data: { rows, total: rows.length } });
  } catch (error) {
    console.error("[grid] Failed to fetch grid data", error);
    return NextResponse.json(
      { error: "Failed to fetch grid data", details: String(error) },
      { status: 500 }
    );
  }
}
