// swissALTI3D-Import (STAC-API) — echtes Höhenraster (0.5 m oder 2 m native
// Punktdichte) statt der groben `profile.json`-Näherung (s.
// `swissTopo.ts::fetchTerrain`, ~20 m Rasterweite über wenige Profillinien).
// Referenz-Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause genutzt):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py
// (`fetch_terrain_xyz`/`xyz_to_grid`).
//
// swissALTI3D-Kacheln liegen als ASCII-XYZ vor ("E N Z" je Zeile, LV95),
// bereits in einem regulären, LV95-ausgerichteten Raster bei der gewählten
// Auflösung (Dateiname trägt `_0.5_` bzw. `_2_`) — kein Downsampling nötig,
// die Punkte werden direkt in ein `TerrainGrid` (model/terrain.ts) übernommen.
// Bei sehr grossem Radius (viele Zellen) wird das Achsenraster gleichmässig
// dezimiert (s. {@link MAX_GRID_CELLS}).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, lv95BboxToWgs84, makeOrigin } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { stacQuery, downloadAssetText } from "./stacApi";
import type { TerrainGrid } from "../model/terrain";

const COLLECTION = "ch.swisstopo.swissalti3d";

/** Native swissALTI3D-Auflösungen (Dateiname-Tag `_0.5_`/`_2_`). */
export type TerrainResolution = "0.5" | "2";

/** Max. Rasterzellen im finalen Grid — schützt vor Speicherexplosion bei
 *  grossem Radius + 0.5-m-Auflösung (z. B. 2000 m Radius ⇒ sonst 8000×8000). */
const MAX_GRID_CELLS = 400_000;

interface XyzTile {
  points: Map<string, number>;
  es: number[];
  ns: number[];
}

/** Parst rohe swissALTI3D-XYZ-ASCII-Zeilen ("E N Z", LV95) in eine Punkt-Map +
 *  sortierte Achsen. Exportiert (pur, kein Netzwerk) für Unit-Tests. */
export function parseXyzPoints(text: string): XyzTile {
  const points = new Map<string, number>();
  const esSet = new Set<number>();
  const nsSet = new Set<number>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const e = Number(parts[0]);
    const n = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(z)) continue;
    // Auf 2 Nachkommastellen runden (swissALTI3D-XYZ hat begrenzte Präzision) —
    // vermeidet Float-Drift-Duplikate am Kachel-Rand.
    const eR = Math.round(e * 100) / 100;
    const nR = Math.round(n * 100) / 100;
    points.set(`${eR},${nR}`, z);
    esSet.add(eR);
    nsSet.add(nR);
  }
  return { points, es: [...esSet].sort((a, b) => a - b), ns: [...nsSet].sort((a, b) => a - b) };
}

/**
 * Baut ein {@link TerrainGrid} aus mehreren geparsten Kacheln (Punkte werden
 * vereinigt, auf `clipBbox` beschnitten, Achsen aus der Vereinigung aller
 * verbleibenden Punkte). Dezimiert die Achsen gleichmässig, falls die
 * Zellenzahl {@link MAX_GRID_CELLS} überschritten würde. Exportiert (pur,
 * kein Netzwerk) für Unit-Tests. `null` bei leerem Ergebnis.
 */
export function buildTerrainGrid(
  tiles: XyzTile[],
  origin: GeoOrigin,
  clipBbox: [number, number, number, number],
): TerrainGrid | null {
  const merged = new Map<string, number>();
  const esSet = new Set<number>();
  const nsSet = new Set<number>();
  const [eMin, nMin, eMax, nMax] = clipBbox;
  for (const tile of tiles) {
    for (const [key, z] of tile.points) {
      const sep = key.indexOf(",");
      const e = Number(key.slice(0, sep));
      const n = Number(key.slice(sep + 1));
      if (e < eMin || e > eMax || n < nMin || n > nMax) continue;
      merged.set(key, z);
      esSet.add(e);
      nsSet.add(n);
    }
  }
  let es = [...esSet].sort((a, b) => a - b);
  let ns = [...nsSet].sort((a, b) => a - b);
  if (es.length === 0 || ns.length === 0) return null;

  const totalCells = es.length * ns.length;
  if (totalCells > MAX_GRID_CELLS) {
    const factor = Math.ceil(Math.sqrt(totalCells / MAX_GRID_CELLS));
    es = es.filter((_, i) => i % factor === 0);
    ns = ns.filter((_, i) => i % factor === 0);
  }

  const z: (number | null)[][] = ns.map((n) =>
    es.map((e) => merged.get(`${e},${n}`) ?? null),
  );
  return {
    xs: es.map((e) => e - origin.e),
    ys: ns.map((n) => n - origin.n),
    z,
    name: "Gelände (swissALTI3D)",
  };
}

export interface FetchTerrainXyzResult {
  origin: GeoOrigin;
  grid: TerrainGrid | null;
}

/**
 * Echtes swissALTI3D-Höhenraster (0.5 m oder 2 m native Punktdichte, je nach
 * `resolution`) für eine LV95-bbox — ersetzt die grobe `profile.json`-
 * Näherung (`swissTopo.ts::fetchTerrain`, ~20 m Rasterweite). Mehrere
 * überdeckte 1-km-Kacheln werden zu einem gemeinsamen Grid vereinigt.
 */
export async function fetchTerrainXyz(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
  resolution: TerrainResolution = "2",
): Promise<FetchTerrainXyzResult> {
  const origin = originIn ?? makeOrigin(center);
  const bboxLv95 = bboxAround(center, radius);
  const bboxWgs = lv95BboxToWgs84(bboxLv95);

  const items = await stacQuery(COLLECTION, bboxWgs, [".xyz", ".xyz.zip"]);
  const tag = `_${resolution}_`;
  const tiles: XyzTile[] = [];
  for (const item of items) {
    // Asset mit passendem Auflösungs-Tag bevorzugen, sonst irgendeines nehmen
    // (bessere Teilabdeckung als gar nichts).
    const asset = item.assets.find((a) => a.href.includes(tag)) ?? item.assets[0];
    if (!asset) continue;
    const text = await downloadAssetText(asset, [".xyz"]);
    if (!text) continue;
    tiles.push(parseXyzPoints(text));
  }
  if (tiles.length === 0) return { origin, grid: null };
  return { origin, grid: buildTerrainGrid(tiles, origin, bboxLv95) };
}
