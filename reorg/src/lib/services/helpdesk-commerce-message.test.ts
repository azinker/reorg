import assert from "node:assert/strict";
import test from "node:test";

import { parseCommerceMessageMedia } from "./helpdesk-commerce-message";

test("parseCommerceMessageMedia extracts eBay messageMedia image URLs", () => {
  const media = parseCommerceMessageMedia({
    messageId: "3401506319018",
    messageBody: "I do have pictures...",
    messageMedia: [
      {
        mediaUrl:
          "https://i.ebayimg.com/images/g/example/s-l64.jpg?set_id=880000500F&amp;foo=1",
        mediaType: "IMAGE",
        thumbnailUrl: "https://i.ebayimg.com/images/g/example/s-l64.jpg",
      },
    ],
  });

  assert.deepEqual(media, [
    {
      url: "https://i.ebayimg.com/images/g/example/s-l64.jpg?set_id=880000500F&foo=1",
      mimeType: "image/jpeg",
      thumbnailUrl: "https://i.ebayimg.com/images/g/example/s-l64.jpg",
    },
  ]);
});

test("parseCommerceMessageMedia handles nested attachment aliases and dedupes", () => {
  const media = parseCommerceMessageMedia({
    attachments: {
      media: [
        "https://i.ebayimg.com/images/g/string/s-l500.jpg",
        {
          URL: "https://i.ebayimg.com/images/g/one/s-l500.png",
          contentType: "image/png",
          fileName: "buyer-photo.png",
        },
        {
          mediaURL: "https://i.ebayimg.com/images/g/one/s-l500.png",
          mediaType: "IMAGE",
        },
      ],
    },
  });

  assert.deepEqual(media, [
    {
      url: "https://i.ebayimg.com/images/g/string/s-l500.jpg",
      mimeType: "image/jpeg",
    },
    {
      url: "https://i.ebayimg.com/images/g/one/s-l500.png",
      mimeType: "image/png",
      name: "buyer-photo.png",
    },
  ]);
});
