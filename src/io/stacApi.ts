// Gemeinsame STAC-API-Bausteine für swisstopo-Datensätze (data.geo.admin.ch,
// offen, kein Auth/Key, CORS `*`) — genutzt von `swissBuildings3d.ts`
// (swissBUILDINGS3D 2.0/3.0) und `swissAlti3d.ts` (Höhenmodell). Referenz-
// Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause portiert):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { netFetch } from "../net/net";
import JSZip from "jszip";
import { viaProxy } from "./geoContext";

export const STAC_BASE = "https://data.geo.admin.ch/api/stac/v1";

/** Asset-Grössenlimit (Bytes) — schützt vor riesigen Kacheln (v3-Stadt-Tiles,
 *  0.5-m-Terrain über einen grossen Radius). Grosszügig, aber endlich. */
export const MAX_ASSET_BYTES = 150 * 1024 * 1024;

export interface StacAsset {
  href: string;
  size?: number;
}
export interface StacItem {
  id: string;
  assets: StacAsset[];
}

/** STAC-Items einer Collection in einer WGS84-bbox, gefiltert nach Datei-Endung. */
export async function stacQuery(
  collectionId: string,
  bbox: { south: number; west: number; north: number; east: number },
  assetExtensions: string[],
  limit = 100,
): Promise<StacItem[]> {
  const url =
    `${STAC_BASE}/collections/${collectionId}/items` +
    `?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}&limit=${limit}`;
  const res = await netFetch(viaProxy(url));
  if (!res.ok) throw new Error(`STAC-Abfrage fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as {
    features?: {
      id?: string;
      assets?: Record<string, { href?: string; "file:size"?: number }>;
    }[];
  };
  const out: StacItem[] = [];
  for (const f of data.features ?? []) {
    if (!f.id) continue;
    const assets: StacAsset[] = [];
    for (const v of Object.values(f.assets ?? {})) {
      if (!v.href) continue;
      const low = v.href.toLowerCase();
      if (!assetExtensions.some((ext) => low.endsWith(ext))) continue;
      assets.push({ href: v.href, size: v["file:size"] });
    }
    if (assets.length === 0) continue;
    out.push({ id: f.id, assets });
  }
  return out;
}

// Tile-Coord-Marker im Dateinamen (z. B. "_1150-23_") — filtert versehentliche
// gesamt-CH-Assets aus (Python-Pendant: `_TILE_FILE_PAT`).
const TILE_FILE_PAT = /_\d{3,4}-\d{2,4}[_.]/;

/** Bevorzugtes Kachel-Asset EINES STAC-Items wählen: `priority`-Endungen zuerst
 *  (in Reihenfolge), nur Per-Tile-Assets (kein versehentlicher CH-Komplett-
 *  datensatz). Exportiert (pur, kein Netzwerk) für Unit-Tests der Auswahllogik. */
export function pickAsset(item: StacItem, priority: string[]): StacAsset | null {
  const perTile = item.assets.filter((a) => TILE_FILE_PAT.test(a.href));
  const pool = perTile.length > 0 ? perTile : item.assets;
  for (const ext of priority) {
    const hit = pool.find((a) => a.href.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return pool[0] ?? null;
}

/** Grobe jszip-interne Schätzung der UNKOMPRIMIERTEN Grösse eines Zip-Eintrags
 *  (Bytes), falls verfügbar — `_data.uncompressedSize` ist kein offiziell
 *  typisiertes API, aber ein stabiles, verbreitet genutztes internes Feld
 *  (siehe `jszip/lib/compressedObject.js`). `null`, wenn nicht auslesbar. */
function estimateUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : null;
}

/** Wählt den passenden ZIP-Eintrag: eine der `innerExt`-Endungen, optional
 *  bevorzugt nach `preferNameIncludes` (Teilstring, klein geschrieben) —
 *  swissBUILDINGS3D-v3-Kacheln bündeln z. B. „…_separated_….dwg" UND
 *  „…_solid_….dwg" im selben Zip; nur `separated` lässt sich mit LibreDWG
 *  lesen (`solid` liefert 0 Entities, vermutlich ACIS-Volumenkörper statt
 *  Polyface-Mesh). Ohne Treffer auf den Präferenz-Teilstring fällt es auf den
 *  ersten `innerExt`-Treffer zurück (unverändertes Verhalten). */
function pickZipEntry(
  zip: JSZip,
  innerExt: string[],
  preferNameIncludes?: string,
): JSZip.JSZipObject | null {
  const candidates = Object.values(zip.files).filter(
    (f) => !f.dir && innerExt.some((ext) => f.name.toLowerCase().endsWith(ext)),
  );
  if (candidates.length === 0) return null;
  if (preferNameIncludes) {
    const preferred = candidates.find((f) =>
      f.name.toLowerCase().includes(preferNameIncludes),
    );
    if (preferred) return preferred;
  }
  return candidates[0];
}

/** Lädt ein Asset als `Response`, sofern es unter {@link MAX_ASSET_BYTES}
 *  bleibt (STAC-`size` UND — falls vorhanden — `Content-Length`-Header
 *  VOR dem Body-Download geprüft, s. Doc bei den Aufrufern). `null` bei
 *  Netzwerkfehler oder Grössenüberschreitung; wirft nie. */
async function fetchAssetWithinLimit(asset: StacAsset): Promise<Response | null> {
  if (asset.size != null && asset.size > MAX_ASSET_BYTES) return null;
  const res = await netFetch(viaProxy(asset.href));
  if (!res.ok) return null;
  // STAC-Metadaten (`file:size`) fehlen manchmal (leeres `file:size`-Feld,
  // z. B. bei swissBUILDINGS3D v3) — dann greift die Prüfung oben NICHT, und
  // ohne diesen zweiten, `Content-Length`-basierten Check würde eine riesige
  // Kachel (in Städten teils >150 MB, im Extremfall >800 MB) komplett
  // heruntergeladen, bevor der spätere `byteLength`-Check sie verwirft —
  // unnötiger Bandbreiten-/Zeitverbrauch für ein Ergebnis, das ohnehin
  // verworfen wird. `Content-Length` selbst kann fehlen (chunked transfer) —
  // dann bleibt es beim (späteren) Grössen-Check nach dem Download.
  const contentLength = res.headers.get("content-length");
  if (contentLength != null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isFinite(len) && len > MAX_ASSET_BYTES) return null;
  }
  return res;
}

/** Lädt ein Asset als Text; entpackt automatisch, wenn es ein `.zip` ist
 *  (liefert den Inhalt der ERSTEN enthaltenen Datei mit einer der `innerExt`-
 *  Endungen). `null` bei Fehler, fehlendem Inhalt im ZIP, oder wenn das Asset
 *  {@link MAX_ASSET_BYTES} überschreitet (komprimiert ODER — DXF/Text
 *  komprimiert stark — unkomprimiert, s. u.). Wirft NIE (fängt Netzwerk-/
 *  ZIP-/String-Längen-Fehler ab und liefert `null`), damit eine einzelne
 *  kaputte/überdimensionierte Kachel nicht den ganzen Import abbricht. */
export async function downloadAssetText(
  asset: StacAsset,
  innerExt: string[],
): Promise<string | null> {
  try {
    const res = await fetchAssetWithinLimit(asset);
    if (!res) return null;
    if (asset.href.toLowerCase().endsWith(".zip")) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_ASSET_BYTES) return null;
      const zip = await JSZip.loadAsync(buf);
      const entry = pickZipEntry(zip, innerExt);
      if (!entry) return null;
      // Proaktiv prüfen: DXF/Text komprimiert stark, ein Zip unter dem Limit
      // kann trotzdem eine Text-Datei enthalten, die die max. JS-String-Länge
      // sprengt (führte zu einem harten Absturz statt einem übersprungenen
      // Tile). Bekannte, aber unschätzbare Grösse (`null`) lässt es zu — der
      // äussere try/catch fängt den Fall dann trotzdem sicher ab.
      const uncompressed = estimateUncompressedSize(entry);
      if (uncompressed != null && uncompressed > MAX_ASSET_BYTES) return null;
      return await entry.async("text");
    }
    return await res.text();
  } catch {
    return null;
  }
}

/** Wie {@link downloadAssetText}, aber liefert den rohen Binärinhalt (für
 *  DWG-Assets, die als `ArrayBuffer` an `parseDwg`/LibreDWG-WASM gehen —
 *  ein binäres Format als Text zu lesen würde die Daten korrumpieren).
 *  `preferNameIncludes` wählt bei mehreren Zip-Treffern gezielt einen aus
 *  (s. {@link pickZipEntry}). */
export async function downloadAssetBinary(
  asset: StacAsset,
  innerExt: string[],
  preferNameIncludes?: string,
): Promise<ArrayBuffer | null> {
  try {
    const res = await fetchAssetWithinLimit(asset);
    if (!res) return null;
    if (asset.href.toLowerCase().endsWith(".zip")) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_ASSET_BYTES) return null;
      const zip = await JSZip.loadAsync(buf);
      const entry = pickZipEntry(zip, innerExt, preferNameIncludes);
      if (!entry) return null;
      const uncompressed = estimateUncompressedSize(entry);
      if (uncompressed != null && uncompressed > MAX_ASSET_BYTES) return null;
      const arrBuf = await entry.async("arraybuffer");
      if (arrBuf.byteLength > MAX_ASSET_BYTES) return null;
      return arrBuf;
    }
    const arrBuf = await res.arrayBuffer();
    if (arrBuf.byteLength > MAX_ASSET_BYTES) return null;
    return arrBuf;
  } catch {
    return null;
  }
}
