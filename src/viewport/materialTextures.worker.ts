/// <reference lib="webworker" />
// [333] Dekodiert Material-Bilder (Farb-, Normalen-, Rauigkeitskarten) ausserhalb des Hauptthreads: Bild-Dateien
// (Blobs, vom Hauptthread über `netFetch` geholt) → `createImageBitmap`, gleich auf 256×256 verkleinert →
// `OffscreenCanvas` → RGBA8. Im Hauptthread kostete das Zeichnen und Auslesen beim Öffnen der 3D-Ansicht rund 0.25 s
// (s. `materialTextures.ts`, der dort auch den Rückfall ohne Worker/OffscreenCanvas hält).

export interface MaterialDecodeRequest {
  id: number;
  size: number;
  blobs: (Blob | null)[];
}

export interface MaterialDecodeResponse {
  id: number;
  /** Je Blob die RGBA8-Pixel (`size² · 4` Byte) oder `null` (fehlt/kaputt). */
  layers: (ArrayBuffer | null)[];
}

self.onmessage = async (e: MessageEvent<MaterialDecodeRequest>) => {
  const { id, size, blobs } = e.data;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const layers: (ArrayBuffer | null)[] = [];
  for (const blob of blobs) {
    if (!blob || !ctx) {
      layers.push(null);
      continue;
    }
    try {
      const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: "high" });
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);
      bmp.close();
      layers.push(ctx.getImageData(0, 0, size, size).data.buffer as ArrayBuffer);
    } catch {
      layers.push(null);
    }
  }
  const msg: MaterialDecodeResponse = { id, layers };
  (self as unknown as Worker).postMessage(msg, layers.filter((b): b is ArrayBuffer => b !== null));
};
