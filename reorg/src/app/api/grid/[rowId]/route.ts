import { NextResponse } from "next/server";
import { getGridRowById } from "@/lib/grid-query";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ rowId: string }> },
) {
  try {
    const { rowId } = await params;
    const row = await getGridRowById(rowId);

    if (!row) {
      return NextResponse.json({ error: `Row "${rowId}" not found` }, { status: 404 });
    }

    return NextResponse.json({ data: { row } });
  } catch (error) {
    console.error("[grid-row] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load row" },
      { status: 500 },
    );
  }
}
