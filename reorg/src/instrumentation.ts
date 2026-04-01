import { NextResponse } from "next/server";
import { queueCurrentRequestJsonResponseSample } from "@/lib/services/network-transfer-samples";

let networkTransferInstrumentationRegistered = false;

export async function register() {
  if (networkTransferInstrumentationRegistered) {
    return;
  }

  networkTransferInstrumentationRegistered = true;

  const originalJson = NextResponse.json.bind(NextResponse) as typeof NextResponse.json;

  NextResponse.json = ((body: unknown, init?: ResponseInit) => {
    const response = originalJson(body, init);
    queueCurrentRequestJsonResponseSample({
      body,
      status: response.status,
    });
    return response;
  }) as typeof NextResponse.json;
}
