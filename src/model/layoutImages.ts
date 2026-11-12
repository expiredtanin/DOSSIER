// Bilder auf Layout-Blättern ([208]): Renderings, Fotos, Luftbilder als PNG/JPEG. Im Projekt liegt das Bild als
// Data-URL (`LayoutImage.src`) — derselbe Weg wie bei `ContextImage` (Luftbild als Unterlage). Rechnung
// (Dateikopf lesen, Seitenverhältnis, Zeichen-/Klipp-Rechteck mit Zuschnitt, Startgrösse) im Kern
// (`src-tauri/core/src/layout_image.rs`); hier nur die dünne Fassade, Listen-Änderungen am Layout und das Einlesen.
//
// Bezeichner englisch, Kommentare deutsch.

import type { Layout, LayoutImage } from "./types";
import { core } from "../engine/coreWasm";

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
}

/** Rechteck in Papier-mm. */
export interface RectXYWH {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mehr als 40 MB Bild in einem Projekt sprengt Speichern und Autosave. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function call<T>(name: string, arg: unknown): T | null {
  const out = core().layout_call(name, JSON.stringify(arg));
  return out === "" ? null : (JSON.parse(out) as T);
}

/** Format und Pixelgrösse einer PNG-/JPEG-Data-URL; `null` bei anderen Formaten oder kaputten Daten. */
export function imageInfo(src: string): ImageInfo | null {
  return call<ImageInfo>("imageInfo", { src });
}

/** Seitenverhältnis (Breite/Höhe) des gezeigten Ausschnitts, Zuschnitt eingerechnet. */
export function imageAspect(img: Pick<LayoutImage, "pixelWidth" | "pixelHeight" | "crop">): number {
  return call<number>("imageAspect", img) ?? 1;
}

/** Klipp-Rahmen, Zeichen-Rechteck des GANZEN Originals und Auflösung (dpi) des Bilds auf dem Blatt. */
export function imageGeometry(img: LayoutImage): { clip: RectXYWH; draw: RectXYWH; dpi: number } {
  const g = call<{ clip: RectXYWH; draw: RectXYWH; dpi: number }>("imageGeometry", img);
  const r = { x: img.xMm, y: img.yMm, w: img.widthMm, h: img.heightMm };
  return g ?? { clip: r, draw: r, dpi: 0 };
}

/** Startrahmen eines neuen Bilds auf einem Blatt `sheetW`×`sheetH` mm: Seitenverhältnis gehalten, mittig. */
export function initialImageFrame(pixelWidth: number, pixelHeight: number, sheetW: number, sheetH: number): RectXYWH {
  return call<RectXYWH>("imageInitial", { pixelWidth, pixelHeight, sheetW, sheetH }) ?? { x: 0, y: 0, w: sheetW / 2, h: sheetH / 2 };
}

/** Bytes → Data-URL (in Stücken, damit grosse Bilder keinen Stapel sprengen). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Data-URL → Bytes (für den PDF-Export und „Speichern unter"). */
export function dataUrlToBytes(src: string): Uint8Array {
  const bin = atob(src.slice(src.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Neues Blatt-Bild aus Dateibytes: erkennt PNG/JPEG am Kopf (nicht am Dateinamen), legt es mittig und im
 * Seitenverhältnis auf das Blatt. `null`, wenn es weder PNG noch JPEG ist oder zu gross.
 */
export function createLayoutImage(
  id: string,
  name: string,
  bytes: Uint8Array,
  sheet: { w: number; h: number },
  mimeHint = "image/png",
): LayoutImage | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const src = bytesToDataUrl(bytes, mimeHint);
  const info = imageInfo(src);
  if (!info) return null;
  // Der Kopf entscheidet über das Format, nicht der Hinweis (umbenannte Dateien).
  const real = info.mime === mimeHint ? src : bytesToDataUrl(bytes, info.mime);
  const f = initialImageFrame(info.width, info.height, sheet.w, sheet.h);
  return {
    id,
    name,
    src: real,
    xMm: round1(f.x),
    yMm: round1(f.y),
    widthMm: round1(f.w),
    heightMm: round1(f.h),
    pixelWidth: info.width,
    pixelHeight: info.height,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Breite ändern, Höhe folgt dem Seitenverhältnis des Ausschnitts. */
export function resizeImageWidth(img: LayoutImage, widthMm: number): Pick<LayoutImage, "widthMm" | "heightMm"> {
  const w = Math.max(5, widthMm);
  return { widthMm: round1(w), heightMm: round1(w / imageAspect(img)) };
}

/** Neuer Zuschnitt (Anteile 0..1): der Rahmen behält seine Breite, die Höhe folgt dem neuen Seitenverhältnis. */
export function cropImage(img: LayoutImage, crop: LayoutImage["crop"]): Pick<LayoutImage, "crop" | "widthMm" | "heightMm"> {
  const next = { ...img, crop };
  return { crop, widthMm: img.widthMm, heightMm: round1(img.widthMm / imageAspect(next)) };
}

/** Bild an das Blatt anhängen. */
export function addImage(layout: Layout, image: LayoutImage): Layout {
  return { ...layout, images: [...(layout.images ?? []), image] };
}

export function removeImage(layout: Layout, imageId: string): Layout {
  return { ...layout, images: (layout.images ?? []).filter((i) => i.id !== imageId) };
}

export function patchImage(layout: Layout, imageId: string, patch: Partial<Omit<LayoutImage, "id">>): Layout {
  return {
    ...layout,
    images: (layout.images ?? []).map((i) => {
      if (i.id !== imageId) return i;
      const next = { ...i, ...patch };
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete (next as Record<string, unknown>)[k];
      return next;
    }),
  };
}
