import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const translateSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
  target: z.literal("en").default("en"),
});

interface TranslatePayload {
  translatedText: string;
  detectedLanguage: string | null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = translateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const result = process.env.GOOGLE_TRANSLATE_API_KEY
      ? await translateWithCloudApi(parsed.data.text, parsed.data.target)
      : await translateWithPublicEndpoint(parsed.data.text, parsed.data.target);
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Translation request failed",
      },
      { status: 502 },
    );
  }
}

async function translateWithCloudApi(
  text: string,
  target: "en",
): Promise<TranslatePayload> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error("Google Translate API key is not configured");
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: text, target, format: "text" }),
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`Google Translate failed (${res.status})`);
  const json = (await res.json()) as {
    data?: {
      translations?: Array<{
        translatedText?: string;
        detectedSourceLanguage?: string;
      }>;
    };
  };
  const translation = json.data?.translations?.[0];
  return {
    translatedText: decodeHtmlEntities(translation?.translatedText ?? ""),
    detectedLanguage: translation?.detectedSourceLanguage ?? null,
  };
}

async function translateWithPublicEndpoint(
  text: string,
  target: "en",
): Promise<TranslatePayload> {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Google Translate failed (${res.status})`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error("Unexpected translation response");
  const segments = Array.isArray(json[0]) ? json[0] : [];
  const translatedText = segments
    .map((segment) =>
      Array.isArray(segment) && typeof segment[0] === "string"
        ? segment[0]
        : "",
    )
    .join("");
  const detectedLanguage = typeof json[2] === "string" ? json[2] : null;
  return {
    translatedText: decodeHtmlEntities(translatedText),
    detectedLanguage,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .trim();
}
