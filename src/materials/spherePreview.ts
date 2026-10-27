// PBR-Materialkugel-Vorschau (CAD/DCC-üblich) für den Ressourcen-Manager.
// Pro Material wird nacheinander eine Kugel auf einem 2D-Canvas gezeichnet und als
// PNG-DataURL gecached. Aufträge laufen seriell über eine Warteschlange.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { MaterialAsset } from "./library";

/** Kantenlänge der gerenderten Vorschau in Pixeln (CSS skaliert die Kachel). */
const PREVIEW_SIZE = 128;

type PreviewStatus = "pending" | "ready" | "error";

interface PreviewEntry {
  status: PreviewStatus;
  url?: string;
  subscribers: Set<(url: string) => void>;
}

/** Fertige/aktive Vorschauen, Schlüssel = stabile Material-Signatur. */
const cache = new Map<string, PreviewEntry>();

/**
 * Stabile Cache-Signatur eines Assets: ändert sich, sobald sich eine Karten-
 * URL ändert (z. B. weil die Bibliothek neu generiert wurde) — dadurch wird
 * eine veraltete Vorschau automatisch verworfen, auch bei gleicher ID.
 */
function signatureOf(asset: MaterialAsset): string {
  const m = asset.maps;
  return [
    asset.id,
    m.color ?? "",
    m.normal ?? "",
    m.roughness ?? "",
    m.metalness ?? "",
    m.ao ?? "",
    m.displacement ?? "",
  ].join("|");
}

// ── Rendering per 2D-Canvas (kein WebGL/three.js) ──────────────────────────
// Die Farbkarte wird auf die Kugel gelegt (Kugel-Abbildung: Pixel → Fläche eines Kugelstücks,
// flächentreu genug für eine Kachel), dazu Licht von links oben als Verlauf. Die Rauheits-/
// Normalkarten gehen nicht ein — die Kachel soll Farbe und Körnung lesbar machen.

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Textur nicht ladbar: ${url}`));
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

/** Rendert die Vorschau-Kugel eines Assets und liefert eine PNG-DataURL. */
async function renderPreview(asset: MaterialAsset): Promise<string> {
  const S = PREVIEW_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D-Canvas nicht verfügbar");

  // Albedo-Textur auf eine Kachel-Fläche (2×2 Wiederholungen, damit die Körnung sichtbar bleibt).
  const tex = document.createElement("canvas");
  tex.width = tex.height = S;
  const tctx = tex.getContext("2d")!;
  tctx.fillStyle = "#cccccc";
  tctx.fillRect(0, 0, S, S);
  const url = asset.maps.color;
  if (url) {
    try {
      const img = await loadImage(url);
      tctx.drawImage(img, 0, 0, S / 2, S / 2);
      tctx.drawImage(img, S / 2, 0, S / 2, S / 2);
      tctx.drawImage(img, 0, S / 2, S / 2, S / 2);
      tctx.drawImage(img, S / 2, S / 2, S / 2, S / 2);
    } catch {
      /* graue Kugel */
    }
  }
  const src = tctx.getImageData(0, 0, S, S).data;
  const out = ctx.createImageData(S, S);
  const r = S / 2 - 1;
  const L = [-0.45, 0.55, 0.7]; // Licht von links oben vorn
  const ll = Math.hypot(L[0], L[1], L[2]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5 - S / 2) / r;
      const ny = -(y + 0.5 - S / 2) / r;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      // Kugel-Abbildung: Längen-/Breitenkoordinate → Textur-Pixel.
      const u = Math.atan2(nx, nz) / Math.PI + 0.5;
      const v = Math.asin(ny) / Math.PI + 0.5;
      const sx = Math.min(S - 1, Math.max(0, Math.floor(u * S)));
      const sy = Math.min(S - 1, Math.max(0, Math.floor((1 - v) * S)));
      const si = (sy * S + sx) * 4;
      const lambert = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
      const shade = 0.28 + 0.85 * lambert;
      const spec = asset.maps.metalness ? 0 : Math.pow(lambert, 24) * 0.25;
      const oi = (y * S + x) * 4;
      out.data[oi] = Math.min(255, src[si] * shade + spec * 255);
      out.data[oi + 1] = Math.min(255, src[si + 1] * shade + spec * 255);
      out.data[oi + 2] = Math.min(255, src[si + 2] * shade + spec * 255);
      // Kantenglättung: weicher Rand über das letzte Pixel.
      out.data[oi + 3] = Math.min(255, Math.max(0, (1 - Math.sqrt(d2)) * r * 255));
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL("image/png");
}

// ── Serielle Warteschlange (ein Render-Auftrag zur Zeit, geteilter Kontext) ─

let queue: Promise<void> = Promise.resolve();

/**
 * Fordert die Kugel-Vorschau eines Bibliotheks-Materials an. Liefert sofort
 * die gecachte DataURL, falls schon fertig gerendert; andernfalls wird der
 * Render-Auftrag (serialisiert über die geteilte Warteschlange) eingereiht und
 * `onReady` genau einmal mit der fertigen URL aufgerufen. Wiederholte Aufrufe
 * mit demselben Material treffen den Cache (kein erneutes Rendern) — außer die
 * Karten-Signatur hat sich geändert (Bibliothek aktualisiert).
 */
export function requestMaterialPreview(
  asset: MaterialAsset,
  onReady: (url: string) => void,
): string | undefined {
  const key = signatureOf(asset);
  let entry = cache.get(key);
  if (!entry) {
    entry = { status: "pending", subscribers: new Set() };
    cache.set(key, entry);
    queue = queue
      .then(() => renderPreview(asset))
      .then((url) => {
        entry!.status = "ready";
        entry!.url = url;
        for (const cb of entry!.subscribers) cb(url);
        entry!.subscribers.clear();
      })
      .catch((err) => {
        entry!.status = "error";
        entry!.subscribers.clear();
        console.error("[spherePreview] Vorschau-Render fehlgeschlagen:", err);
      });
  }
  if (entry.status === "ready" && entry.url) return entry.url;
  entry.subscribers.add(onReady);
  return undefined;
}

/** Meldet einen Abonnenten wieder ab (Aufräumen bei Unmount vor Fertigstellung). */
export function cancelMaterialPreview(
  asset: MaterialAsset,
  onReady: (url: string) => void,
): void {
  cache.get(signatureOf(asset))?.subscribers.delete(onReady);
}
