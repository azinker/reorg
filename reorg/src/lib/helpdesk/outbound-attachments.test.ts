import assert from "node:assert/strict";
import test from "node:test";

import {
  inferEbayImageMimeType,
  normalizeAttachmentFileName,
  readQueuedHelpdeskAttachments,
  validateEbayImageAttachment,
} from "./outbound-attachments";

test("validateEbayImageAttachment accepts eBay-supported image formats by extension", () => {
  assert.equal(
    validateEbayImageAttachment({
      fileName: "buyer-photo.HEIC",
      mimeType: "application/octet-stream",
      sizeBytes: 1024,
    }),
    null,
  );
  assert.equal(inferEbayImageMimeType("buyer-photo.jpg", "image/jpg"), "image/jpeg");
});

test("validateEbayImageAttachment rejects non-image and oversize files", () => {
  assert.match(
    validateEbayImageAttachment({
      fileName: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    }) ?? "",
    /not an eBay-supported image type/,
  );
  assert.match(
    validateEbayImageAttachment({
      fileName: "huge.png",
      mimeType: "image/png",
      sizeBytes: 13 * 1024 * 1024,
    }) ?? "",
    /too large/,
  );
});

test("attachment helpers sanitize names and parse queued metadata", () => {
  assert.equal(normalizeAttachmentFileName(" bad:/name?.png "), "bad-name-.png");
  assert.deepEqual(
    readQueuedHelpdeskAttachments({
      attachments: [
        {
          storageKey: "helpdesk/outbound/a.png",
          fileName: "a.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
        { storageKey: "", fileName: "bad.png", mimeType: "image/png", sizeBytes: 10 },
      ],
    }),
    [
      {
        storageKey: "helpdesk/outbound/a.png",
        fileName: "a.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
    ],
  );
});
