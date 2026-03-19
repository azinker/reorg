"use client";

async function writeBlobToClipboard(blob: Blob) {
  if (typeof window === "undefined" || !("ClipboardItem" in window) || !navigator.clipboard?.write) {
    throw new Error("Image clipboard is not supported in this browser.");
  }

  const item = new window.ClipboardItem({
    [blob.type]: blob,
  });

  await navigator.clipboard.write([item]);
}

async function svgToPngBlob(svgText: string) {
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unable to render SVG for clipboard copy."));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(image.width, 1);
    canvas.height = Math.max(image.height, 1);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create canvas context.");

    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Unable to convert image for clipboard copy."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copySvgElementImage(svg: SVGSVGElement) {
  const serializer = new XMLSerializer();
  const svgText = serializer.serializeToString(svg);

  try {
    const pngBlob = await svgToPngBlob(svgText);
    await writeBlobToClipboard(pngBlob);
  } catch {
    const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    await writeBlobToClipboard(svgBlob);
  }
}

export async function copyImageFromUrl(imageUrl: string) {
  const proxyUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;

  let response = await fetch(proxyUrl, { cache: "no-store" });
  if (!response.ok) {
    response = await fetch(imageUrl, { cache: "force-cache" });
  }

  if (!response.ok) {
    throw new Error(`Unable to fetch image (${response.status}).`);
  }

  const blob = await response.blob();
  await writeBlobToClipboard(blob);
}
