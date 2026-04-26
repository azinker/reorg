import assert from "node:assert/strict";
import test from "node:test";

import { extractEnvelopePreviewImages } from "./html-clean";

test("extractEnvelopePreviewImages reads previewImageCont blocks", () => {
  const images = extractEnvelopePreviewImages(`
    <td id="previewImageCont0">
      <a href="#"><span>
        <img id="previewimage0" src="https://i.ebayimg.com/images/g/abc/s-l64.jpg?set_id=880000500F&amp;v=1" />
      </span></a>
    </td>
  `);

  assert.deepEqual(images, [
    {
      url: "https://i.ebayimg.com/images/g/abc/s-l64.jpg?set_id=880000500F&v=1",
      mimeType: "image/jpeg",
    },
  ]);
});

test("extractEnvelopePreviewImages supports preview image attributes in either order", () => {
  const images = extractEnvelopePreviewImages(`
    <img src="https://i.ebayimg.com/images/g/abc/s-l64.png" id="previewimage1" />
    <img id="previewimage2" src="https://i.ebayimg.com/images/g/def/s-l64.gif" />
  `);

  assert.deepEqual(images, [
    {
      url: "https://i.ebayimg.com/images/g/abc/s-l64.png",
      mimeType: "image/png",
    },
    {
      url: "https://i.ebayimg.com/images/g/def/s-l64.gif",
      mimeType: "image/gif",
    },
  ]);
});
