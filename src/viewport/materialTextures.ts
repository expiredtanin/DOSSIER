/**
 * Dekodiert die Material-Farbkarten eines Projekts für den nativen render3d-
 * Renderer (Stil „Textured"). Der native Renderer bekommt KEINE Bild-Dateien —
 * er kennt weder Datei-Pfade noch einen PNG/JPG-Decoder. Deshalb dekodiert diese
 * Datei die eindeutigen Material-Farb-Maps IM BROWSER (Image/ImageBitmap →
 * Canvas → `getImageData`) zu rohen RGBA8-Pixeln und packt sie zu EINEM Puffer
 * (je Textur eine 256×256-Ebene), den {@link WebModelRenderer.set_material_textures}
 * als Textur-Array hochlädt.
 *
 * REIHENFOLGE-VERTRAG: Die Ebenen liegen exakt in der Reihenfolge von
 * {@link wallMaterialColorMaps} — dieselbe Funktion, aus der `toWalls3d` den
 * `materialIndex` je Wand-Band ableitet (1-basiert; Ebene 0 = Fallback-
 * Schachbrett). So zeigt Band-Index i+1 auf die (i)-te dekodierte Ebene, ohne
 * dass eine explizite Zuordnungstabelle zwischen JS und Rust wandern muss.
 *
 * [212] Etappe 4: Die Ebenen folgen {@link pathtraceMaterials} (= {@link wallMaterialColorMaps}, dahinter evtl. die
 * Wiese des Geländes ohne Material). Dazu je Ebene die Normalen- und Rauigkeitskarte des Bauteils für den Pathtracer
 * (`set_material_detail_textures`; fehlende bleiben schwarz = keine Karte).
 */

import { HostNotAllowedError, OfflineError, netFetch } from "../net/net";
import type { Project } from "../model/types";
import { pathtraceMaterials } from "../core";
import type { MaterialDecodeRequest, MaterialDecodeResponse } from "./materialTextures.worker";

/** Kantenlänge einer Textur-Ebene in Texeln (muss zu render3d `TEXTURE_SIZE`). */
const TEX_SIZE = 256;

/** Ergebnis von {@link decodeMaterialTextures}: gepackte RGBA8-Ebenen + Anzahl. */
export interface DecodedMaterialTextures {
  /** `count * TEX_SIZE * TEX_SIZE * 4` Bytes: je Material eine 256×256-RGBA-Ebene. */
  data: Uint8Array;
  /** Anzahl Material-Ebenen (== `pathtraceMaterials(project).length`). */
  count: number;
  /** [212] Normalenkarten (gleiches Format wie `data`), null ohne jede Karte. */
  normal: Uint8Array | null;
  /** [212] Rauigkeitskarten (gleiches Format wie `data`), null ohne jede Karte. */
  rough: Uint8Array | null;
  /** Signatur (die URL-Liste), um unveränderte Material-Mengen nicht neu zu dekodieren. */
  signature: string;
}

/**
 * Dekodiert die eindeutigen Material-Farbkarten von `project` zu gepackten
 * RGBA8-Ebenen. `null`, wenn das Projekt keine Material-Farbkarten benutzt oder
 * kein Browser-Kontext vorliegt (SSR/Test) — der Aufrufer lädt dann nichts hoch
 * (render3d bleibt beim Schachbrett). Fehlgeschlagene Einzelbilder bleiben als
 * schwarze Ebene erhalten (kein Abbruch der ganzen Menge).
 */
export async function decodeMaterialTextures(
  project: Project,
): Promise<DecodedMaterialTextures | null> {
  if (typeof document === "undefined") return null;
  const entries = pathtraceMaterials(project);
  const urls = entries.map((e) => e.map);
  if (urls.length === 0) return null;

  const bytesPerLayer = TEX_SIZE * TEX_SIZE * 4;
  // [212] Normalen- und Rauigkeitskarten nur, wenn mindestens ein Eintrag sie hat (sonst kein Speicher).
  const hasNormal = entries.some((e) => e.normal);
  const hasRough = entries.some((e) => e.rough);
  const lists: (string | undefined)[][] = [
    urls,
    entries.map((e) => (hasNormal ? e.normal : undefined)),
    entries.map((e) => (hasRough ? e.rough : undefined)),
  ];
  const flat = lists.flat();
  // [333] 1) Alle Bild-Dateien zugleich holen (Hauptthread, `netFetch`: Offline-Modus und Host-Liste gelten).
  //       2) Im Worker dekodieren und auslesen (`materialTextures.worker.ts`; im Hauptthread kostete das beim Öffnen
  //          der 3D-Ansicht rund 0.25 s). 3) Was übrig bleibt (kein Worker/OffscreenCanvas, Fehler, URL, die fetch
  //          nicht mag), wie bisher im Hauptthread. Fehlgeschlagenes Bild: Ebene bleibt schwarz (0); render3d klemmt bei
  //          Bedarf ohnehin auf gültige Ebenen, die übrigen Materialien stimmen.
  const blobs = await Promise.all(flat.map((u) => (u ? fetchBlob(u) : Promise.resolve(null))));
  const decoded = await decodeInWorker(blobs.map((b) => (b instanceof Blob ? b : null)));
  const out = lists.map(() => new Uint8Array(urls.length * bytesPerLayer));
  let ctx: CanvasRenderingContext2D | null | undefined;
  for (let k = 0; k < flat.length; k++) {
    const url = flat[k];
    if (!url) continue;
    const [list, i] = [Math.floor(k / urls.length), k % urls.length];
    const px = decoded?.[k];
    if (px) {
      out[list].set(new Uint8Array(px), i * bytesPerLayer);
      continue;
    }
    if (blobs[k] === BLOCKED) continue;
    if (ctx === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = TEX_SIZE;
      canvas.height = TEX_SIZE;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) continue;
    const img = await loadImage(url).catch(() => null);
    if (!img) continue;
    try {
      ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
      // Auf 256×256 skalieren (die Ebenen eines Arrays müssen gleich groß sein; meist schon so dekodiert).
      ctx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
      out[list].set(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data, i * bytesPerLayer);
    } catch {
      // Ebene bleibt schwarz.
    } finally {
      if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    }
  }
  const [data, normalAll, roughAll] = out;
  const normal = hasNormal ? normalAll : null;
  const rough = hasRough ? roughAll : null;
  const signature = entries.map((e) => `${e.map}|${e.normal ?? ""}|${e.rough ?? ""}`).join("\n");
  return { data, count: urls.length, signature, normal, rough };
}

/** Offline-Modus oder Host nicht erlaubt: kein Rückfall über ein Bild-Element ([262]). */
const BLOCKED = "blocked" as const;

/** Bild-Datei über `netFetch`; `null`, wenn fetch scheitert (Rückfall im Hauptthread), {@link BLOCKED} offline. */
async function fetchBlob(url: string): Promise<Blob | null | typeof BLOCKED> {
  if (typeof fetch !== "function") return null;
  try {
    const res = await netFetch(url);
    return await res.blob();
  } catch (err) {
    return err instanceof OfflineError || err instanceof HostNotAllowedError ? BLOCKED : null;
  }
}

/**
 * [333] Dekodiert die Blobs im Worker (`materialTextures.worker.ts`): je Blob RGBA8 oder `null`. `null` insgesamt, wenn
 * Worker oder OffscreenCanvas fehlen oder der Worker scheitert (dann alles im Hauptthread).
 */
async function decodeInWorker(blobs: (Blob | null)[]): Promise<(ArrayBuffer | null)[] | null> {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || !blobs.some((b) => b)) return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./materialTextures.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const done = (v: (ArrayBuffer | null)[] | null) => {
      worker.terminate();
      resolve(v);
    };
    worker.onmessage = (e: MessageEvent<MaterialDecodeResponse>) => done(e.data.layers.length === blobs.length ? e.data.layers : null);
    worker.onerror = () => done(null);
    const req: MaterialDecodeRequest = { id: 1, size: TEX_SIZE, blobs };
    worker.postMessage(req);
  });
}

/**
 * Lädt eine Bild-URL (Data-URL, Object-URL oder Asset-Pfad) zu einem
 * zeichenbaren Bild. Nutzt `createImageBitmap` (schnell, entkoppelt vom
 * DOM-Layout, gleich auf {@link TEX_SIZE} verkleinert), fällt auf ein `HTMLImageElement` zurück, wo es fehlt.
 */
async function loadImage(url: string): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === "function" && typeof fetch === "function") {
    try {
      const res = await netFetch(url);
      const blob = await res.blob();
      try {
        return await createImageBitmap(blob, { resizeWidth: TEX_SIZE, resizeHeight: TEX_SIZE, resizeQuality: "high" });
      } catch {
        return await createImageBitmap(blob);
      }
    } catch (err) {
      // Offline-Modus und Host-Liste gelten auch für den Bild-Fallback unten ([262]).
      if (err instanceof OfflineError || err instanceof HostNotAllowedError) throw err;
      // Fallback unten (z. B. wenn fetch die URL nicht mag).
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild laden fehlgeschlagen: ${url}`));
    img.src = url;
  });
}
