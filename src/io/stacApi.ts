// Gemeinsame STAC-API-Bausteine für swisstopo-Datensätze (data.geo.admin.ch,
// offen, kein Auth/Key, CORS `*`) — genutzt von `swissBuildings3d.ts`
// (swissBUILDINGS3D 2.0/3.0) und `swissAlti3d.ts` (Höhenmodell). Referenz-
// Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause portiert):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

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
  const res = await fetch(viaProxy(url));
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
  if (asset.size != null && asset.size > MAX_ASSET_BYTES) return null;
  try {
    const res = await fetch(viaProxy(asset.href));
    if (!res.ok) return null;
    if (asset.href.toLowerCase().endsWith(".zip")) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_ASSET_BYTES) return null;
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find(
        (f) => !f.dir && innerExt.some((ext) => f.name.toLowerCase().endsWith(ext)),
      );
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
