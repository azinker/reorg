import assert from "node:assert/strict";
import test from "node:test";
import { parseMedia, truncateMid } from "@/lib/helpdesk/attachments";

test("parseMedia returns [] for non-array input", () => {
  assert.deepEqual(parseMedia(null), []);
  assert.deepEqual(parseMedia(undefined), []);
  assert.deepEqual(parseMedia({}), []);
  assert.deepEqual(parseMedia("https://x.com/a.png"), []);
  assert.deepEqual(parseMedia(42), []);
});

test("parseMedia accepts string entries", () => {
  const out = parseMedia([
    "https://i.ebayimg.com/foo.jpg",
    "http://example.com/page.html",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].isImage, true);
  assert.equal(out[1].isImage, false);
});

test("parseMedia accepts {url}/{URL}/{MediaURL} object shapes", () => {
  const out = parseMedia([
    { url: "https://example.com/a.png" },
    { URL: "https://example.com/b.gif" },
    { MediaURL: "https://example.com/c.webp" },
  ]);
  assert.equal(out.length, 3);
  for (const a of out) assert.equal(a.isImage, true);
});

test("parseMedia accepts outbound eBay messageMedia objects", () => {
  const out = parseMedia([
    {
      mediaUrl:
        "https://i.ebayimg.com/00/s/NTg2WDQzMw==/z/BqAAAeSwh5lp880K/$_1.PNG?set_id=8800005007",
      mediaName: "return-label.png",
      mediaType: "IMAGE",
    },
  ]);
  assert.deepEqual(out, [
    {
      url: "https://i.ebayimg.com/00/s/NTg2WDQzMw==/z/BqAAAeSwh5lp880K/$_1.PNG?set_id=8800005007",
      isImage: true,
    },
  ]);
});

test("parseMedia drops non-http(s) protocols", () => {
  const out = parseMedia([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "ftp://example.com/x.png",
    "https://example.com/ok.png",
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://example.com/ok.png");
});

test("parseMedia drops malformed URLs", () => {
  const out = parseMedia(["not a url", "://broken", { url: 12345 }, null]);
  assert.deepEqual(out, []);
});

test("parseMedia detects images via extension (case-insensitive)", () => {
  const out = parseMedia([
    "https://x.com/A.PNG",
    "https://x.com/b.JPEG",
    "https://x.com/c.svg",
    "https://x.com/d.bmp",
    "https://x.com/e.txt",
  ]);
  assert.equal(out.filter((o) => o.isImage).length, 4);
  assert.equal(out.filter((o) => !o.isImage).length, 1);
});

test("parseMedia handles image URLs with querystring", () => {
  const out = parseMedia(["https://cdn.com/a.jpg?x=1"]);
  assert.equal(out[0].isImage, true);
});

test("truncateMid leaves short strings alone", () => {
  assert.equal(truncateMid("hello", 60), "hello");
});

test("truncateMid shortens long strings preserving both ends", () => {
  const url = "https://example.com/some/very/long/path/to/an/asset.jpg";
  const out = truncateMid(url, 30);
  assert.ok(out.length <= 30);
  assert.ok(out.startsWith("https://"));
  assert.ok(out.endsWith(".jpg"));
  assert.ok(out.includes("..."));
});
