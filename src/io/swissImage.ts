// SWISSIMAGE-Luftbild (swisstopo WMS) für eine LV95-bbox → georeferenziertes
// Rasterbild (Data-URL + Modell-Meter-Bounding-Box). Wird als Hintergrund-
// Ebene in den Grundriss gelegt (Kontext-Schicht, `ContextImage`).
//
// Bezug via WMS 1.1.1 GetMap (EPSG:2056, eindeutige E,N-Achsreihenfolge) auf
// `ch.swisstopo.swissimage` — dieselbe offene geo.admin-Infrastruktur wie die
// übrigen Importe. Das Bild wird als Blob geladen und in eine Data-URL gewandelt,
// damit es (wie die Bild-Schraffuren) ohne externen Host im Projekt/Export lebt.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, makeOrigin } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { viaProxy } from "./geoContext";

const WMS = "https://wms.geo.admin.ch/";
const LAYER = "ch.swisstopo.swissimage";
/** Ziel-Bodenauflösung (Meter/Pixel) — SWISSIMAGE liegt bei ~0.1–0.25 m/px. */
const TARGET_MPP = 0.2;
/** Max. Kantenlänge des angeforderten Bildes (Pixel) — WMS-Server-Limit + Speicher. */
const MAX_PX = 2500;

/** Ergebnis eines SWISSIMAGE-Abrufs. */
export interface FetchSwissImageResult {
  origin: GeoOrigin;
  /** Data-URL (JPEG) oder null (kein Bild / Fehler). */
  dataUrl: string | null;
  /** Modell-Meter-Bounding-Box, die das Bild ausfüllt (aus `origin` abgeleitet). */
  min: { x: number; y: number };
  max: { x: number; y: number };
}

/**
 * Baut die WMS-1.1.1-GetMap-URL für eine LV95-bbox (Reihenfolge E,N) — rein,
 * für Unit-Tests exportiert.
 */
export function buildSwissImageUrl(
  bboxLv95: [number, number, number, number],
  widthPx: number,
  heightPx: number,
): string {
  const [eMin, nMin, eMax, nMax] = bboxLv95;
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetMap",
    LAYERS: LAYER,
    STYLES: "",
    SRS: "EPSG:2056",
    BBOX: `${eMin},${nMin},${eMax},${nMax}`,
    WIDTH: String(widthPx),
    HEIGHT: String(heightPx),
    FORMAT: "image/jpeg",
  });
  return `${WMS}?${params.toString()}`;
}

/** Pixelmaße für eine bbox-Spannweite (Meter) bei {@link TARGET_MPP}, gedeckelt. */
export function imagePixelSize(spanMeters: number): number {
  const px = Math.round(spanMeters / TARGET_MPP);
  return Math.max(64, Math.min(MAX_PX, px));
}

/**
 * Bytes → base64 (chunked `btoa`) — umgeht `FileReader` (nicht in jeder
 * Umgebung vorhanden) und die Argument-Längengrenze von `String.fromCharCode`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** ArrayBuffer → Data-URL des Bildes. */
function bufferToDataUrl(buf: ArrayBuffer, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(buf))}`;
}

/**
 * Sampelt für jeden Mesh-Vertex die Bildfarbe an seiner Lage — die reine
 * (testbare) Kernrechnung des Luftbild-„Drapierens" aufs Gelände-TIN. `positions`
 * ist das flache Modell-Array `[x,y,z, …]` (z = Höhe, ignoriert); `min`/`max` die
 * Modell-Meter-Bounding-Box, die das Bild ausfüllt (Bild-Oben = +Y/Nord). Liefert
 * eine flache Pro-Vertex-Albedo `[r,g,b, …]` (0..1). Vertices ausserhalb der Box
 * klemmen auf den Randpixel.
 */
export function sampleColorsFromImageData(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  positions: readonly number[],
  min: { x: number; y: number },
  max: { x: number; y: number },
): number[] {
  const spanX = max.x - min.x || 1;
  const spanY = max.y - min.y || 1;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const u = clamp01((positions[i] - min.x) / spanX);
    // Bildzeile 0 (oben) entspricht Nord (+Y) -> v=1; daher (1 - v) spiegeln.
    const v = clamp01((positions[i + 1] - min.y) / spanY);
    const px = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const py = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))));
    const idx = (py * width + px) * 4;
    out.push(data[idx] / 255, data[idx + 1] / 255, data[idx + 2] / 255);
  }
  return out;
}

/**
 * Dekodiert eine Bild-Data-URL und sampelt daraus die Pro-Vertex-Albedo für ein
 * Gelände-TIN (siehe {@link sampleColorsFromImageData}). Nutzt `createImageBitmap`
 * + `OffscreenCanvas` (im App-/WebView-Kontext vorhanden; in Node/Tests fehlen sie
 * — dann `null`, kein Wurf). So bleibt der Render-Pfad synchron: gesampelt wird
 * EINMAL beim Import, das Ergebnis lebt auf `TerrainMesh.vertexColors`.
 */
export async function sampleTerrainColors(
  dataUrl: string,
  positions: readonly number[],
  min: { x: number; y: number },
  max: { x: number; y: number },
): Promise<number[] | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return sampleColorsFromImageData(img.data, bmp.width, bmp.height, positions, min, max);
  } catch {
    return null;
  }
}

/** Dekodiertes Bild: dichte RGBA8-Bytes + Maße (zeilenweise von oben). */
export interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Dekodiert eine Bild-Data-URL zu dichten RGBA8-Bytes (für den WASM-Textur-Upload
 * beim 3D-Luftbild-Drapieren, `WebModelRenderer.set_aerial_texture`). Nutzt
 * `createImageBitmap` + `OffscreenCanvas` (App-/WebView-Kontext; in Node/Tests
 * fehlen sie → `null`, kein Wurf).
 */
export async function decodeImageToRgba(dataUrl: string): Promise<DecodedImage | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return {
      data: new Uint8Array(img.data.buffer.slice(0)),
      width: bmp.width,
      height: bmp.height,
    };
  } catch {
    return null;
  }
}

/**
 * Lädt ein SWISSIMAGE-Luftbild für eine LV95-bbox (Zentrum + Radius) und liefert
 * es als Data-URL samt Modell-Meter-Bounding-Box. `originIn` wiederverwenden
 * (wie die übrigen Importe), damit das Bild lagerichtig zu Gebäuden/Terrain
 * liegt. Wirft nicht — bei Netz-/Serverfehler ist `dataUrl` null.
 */
export async function fetchSwissImage(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
): Promise<FetchSwissImageResult> {
  const origin = originIn ?? makeOrigin(center);
  const bboxLv95 = bboxAround(center, radius);
  const px = imagePixelSize(2 * radius);
  const min = { x: bboxLv95[0] - origin.e, y: bboxLv95[1] - origin.n };
  const max = { x: bboxLv95[2] - origin.e, y: bboxLv95[3] - origin.n };

  try {
    const res = await fetch(viaProxy(buildSwissImageUrl(bboxLv95, px, px)));
    if (!res.ok) return { origin, dataUrl: null, min, max };
    // WMS liefert bei Fehlern manchmal eine XML-Fehlermeldung statt eines Bildes.
    const mime = res.headers.get("content-type") ?? "";
    if (!mime.startsWith("image/")) return { origin, dataUrl: null, min, max };
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return { origin, dataUrl: null, min, max };
    return { origin, dataUrl: bufferToDataUrl(buf, mime.split(";")[0]), min, max };
  } catch {
    return { origin, dataUrl: null, min, max };
  }
}
