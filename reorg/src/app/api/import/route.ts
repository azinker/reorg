import { NextResponse, type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const mode = formData.get("mode") as string | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    const validTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "application/vnd.ms-excel",
    ];

    if (!validTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Upload XLSX or CSV." },
        { status: 400 }
      );
    }

    // TODO: Wire to real import service when DB is connected
    // Import service will:
    // 1. Parse XLSX/CSV
    // 2. Validate rows (sku required, weight format, etc.)
    // 3. Return preview with validation results
    // 4. On confirm: upsert to MasterRow based on mode (overwrite/fill-blanks)
    // 5. Generate error report for download

    return NextResponse.json({
      data: {
        fileName: file.name,
        size: file.size,
        mode: mode ?? "fill_blanks",
        status: "preview",
        validRows: 0,
        errorRows: 0,
        message: "Connect a database to process real imports.",
      },
    });
  } catch (error) {
    console.error("[import] Failed to process import", error);
    return NextResponse.json(
      { error: "Failed to process import" },
      { status: 500 }
    );
  }
}
