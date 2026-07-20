// swissBUILDINGS3D-Import (STAC-API) — echte Gebäude-3D-Geometrie (Wände +
// Dachformen) statt der pauschal auf DEFAULT_BUILDING_HEIGHT extrudierten
// VEC25-Footprints (s. `swissTopo.ts::fetchBuildings`). Zwei Datensatz-
// Generationen, beide über dieselbe offene STAC-API (`stacApi.ts`):
//   • v2 ("ch.swisstopo.swissbuildings3d_2")   — stabil, 1-km-Tiles, ~50 MB.
//   • v3 ("ch.swisstopo.swissbuildings3d_3_0") — Beta, Solid/Separated-
//     Varianten, in Städten teils >150 MB/Tile (nicht 1-km-strukturiert) →
//     wir fallen bei leeren/zu grossen v3-Treffern automatisch auf v2 zurück.
// Referenz-Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause genutzt):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py.
//
// Assets liegen als DXF/DWG/OBJ/IFC vor (teils `.zip`) — wir wählen bevorzugt
// DXF: `parseDxf` (dxfParser.ts) liest 3DFACE/MESH/Polyface-Entities bereits
// verlustfrei zu `ImportedMesh` (positions/indices, echtes Z) — kein neuer
// Parser nötig.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, lv95BboxToWgs84, makeOrigin } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { stacQuery, pickAsset, downloadAssetText } from "./stacApi";
import { parseDxf } from "./dxfParser";
import type { ImportedMesh } from "../model/types";

const COLLECTION_V2 = "ch.swisstopo.swissbuildings3d_2";
const COLLECTION_V3 = "ch.swisstopo.swissbuildings3d_3_0";

/** Bevorzugte Asset-Endungen, in Prioritätsreihenfolge (DXF am stabilsten,
 *  da `parseDxf` ihn direkt zu `ImportedMesh` verarbeitet). */
const ASSET_PRIORITY = [
  ".dxf",
  ".dwg",
  ".obj",
  ".ifc",
  ".dxf.zip",
  ".dwg.zip",
  ".obj.zip",
  ".ifc.zip",
];

export type BuildingsVersion = "v2" | "v3";

/** Verschiebt ein DXF-geparstes Mesh (rohe LV95-Koordinaten) um die Origin in
 *  lokale Modell-Meter — dieselbe Konvention wie `swissTopo.ts::fetchBuildings`.
 *  Exportiert (pur, kein Netzwerk) für Unit-Tests der Koordinaten-Verschiebung. */
export function shiftMeshToOrigin(
  mesh: ImportedMesh,
  origin: GeoOrigin,
  sourceId: string,
): ImportedMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= origin.e;
    positions[i + 1] -= origin.n;
  }
  return { ...mesh, positions, name: `swissBUILDINGS3D ${sourceId}` };
}

/**
 * Schneidet ein Mesh auf eine (bereits origin-verschobene, lokale) Bounding-Box
 * zurecht: ein Dreieck bleibt, sobald MINDESTENS EIN Eckpunkt innerhalb der Box
 * liegt (grosszügig — schneidet Gebäude am Rand nicht mittendurch ab). Nötig,
 * weil eine einzelne swissBUILDINGS3D-DXF-Kachel (STAC-Tile) alle Gebäude der
 * GANZEN Kachel als EIN gemeinsames Mesh liefert (s. `dxfParser.ts::parseDxf`
 * — alle 3DFACE/Polyface-Entities eines Files landen im selben Positions-/
 * Indexpuffer) — ohne diesen Zuschnitt liefert ein einzelner Import ALLES in
 * der Kachel, auch weit ausserhalb des gesuchten Radius (bis zu mehreren km,
 * je nach Kachelgrösse). `positions` wird dabei KOMPAKTIERT (nicht referenzierte
 * Ecken entfernt, Indizes neu gemappt) — sonst sähe jeder Verbraucher, der roh
 * über `positions` statt über `indices` iteriert (z. B. eine Bounding-Box/
 * Kamera-Fit-Berechnung), weiterhin die volle, ungeschnittene Ausdehnung. Rein
 * (kein Netzwerk), exportiert für Unit-Tests.
 */
export function clipMeshToBbox(
  mesh: ImportedMesh,
  bboxLocal: [number, number, number, number],
): ImportedMesh {
  const [xMin, yMin, xMax, yMax] = bboxLocal;
  const pos = mesh.positions;
  const inBox = (idx: number): boolean => {
    const x = pos[idx * 3];
    const y = pos[idx * 3 + 1];
    return x >= xMin && x <= xMax && y >= yMin && y <= yMax;
  };
  const keptTris: [number, number, number][] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    if (inBox(a) || inBox(b) || inBox(c)) keptTris.push([a, b, c]);
  }
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const mapVertex = (old: number): number => {
    let ni = remap.get(old);
    if (ni === undefined) {
      ni = positions.length / 3;
      positions.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
      remap.set(old, ni);
    }
    return ni;
  };
  for (const [a, b, c] of keptTris) indices.push(mapVertex(a), mapVertex(b), mapVertex(c));
  return { ...mesh, positions, indices };
}

/** Sichtbarer Ebenen-/Gruppierungsname der importierten Gebäude (SitePanel). */
export const BUILDING_LAYER = "Gebäude";

/**
 * Zerlegt ein Mesh in seine räumlich ZUSAMMENHÄNGENDEN Komponenten (Union-Find
 * über verschweisste Vertices) — je Komponente ein eigenes {@link ImportedMesh}.
 * So wird eine swissBUILDINGS3D-Kachel (ein Mesh mit ALLEN Gebäuden, s.
 * `dxfParser.ts::parseDxf`) in EINZELNE, getrennt anwähl-/löschbare Gebäude
 * aufgeteilt (Nutzer-Wunsch). Vertices werden per quantisierter Position
 * (`weldMm`) verschweisst, damit Dreiecke, die sich einen Eckpunkt teilen, aber
 * getrennte Indizes tragen (typisch für 3DFACE-DXF), als verbunden gelten. Jede
 * Komponente bekommt eine eigene Id + fortlaufenden Namen + `layer`. Rein (kein
 * Netzwerk), exportiert für Unit-Tests.
 */
export function splitMeshComponents(mesh: ImportedMesh, weldMm = 1): ImportedMesh[] {
  const pos = mesh.positions;
  const vcount = Math.floor(pos.length / 3);
  const idx = mesh.indices;
  if (vcount < 3 || idx.length < 3) return idx.length >= 3 ? [mesh] : [];

  // 1) Weld: gleiche (quantisierte) Position -> gemeinsamer kanonischer Index.
  const q = weldMm / 1000; // Meter
  const weldMap = new Map<string, number>();
  const canonical = new Int32Array(vcount);
  for (let i = 0; i < vcount; i++) {
    const key = `${Math.round(pos[i * 3] / q)},${Math.round(pos[i * 3 + 1] / q)},${Math.round(pos[i * 3 + 2] / q)}`;
    let c = weldMap.get(key);
    if (c === undefined) {
      c = i;
      weldMap.set(key, i);
    }
    canonical[i] = c;
  }

  // 2) Union-Find über die kanonischen Vertices via Dreieckskanten.
  const parent = new Int32Array(vcount);
  for (let i = 0; i < vcount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a >= vcount || b >= vcount || c >= vcount) continue;
    union(canonical[a], canonical[b]);
    union(canonical[b], canonical[c]);
  }

  // 3) Dreiecke nach Komponenten-Wurzel gruppieren.
  const groups = new Map<number, number[]>();
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a >= vcount || b >= vcount || c >= vcount) continue;
    const root = find(canonical[a]);
    let g = groups.get(root);
    if (!g) {
      g = [];
      groups.set(root, g);
    }
    g.push(a, b, c);
  }
  if (groups.size <= 1) return [{ ...mesh, layer: mesh.layer ?? BUILDING_LAYER }];

  // 4) Je Komponente ein eigenes Mesh (Positions kompaktiert, Indizes neu gemappt).
  const out: ImportedMesh[] = [];
  let n = 0;
  for (const tri of groups.values()) {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const old of tri) {
      let ni = remap.get(old);
      if (ni === undefined) {
        ni = positions.length / 3;
        positions.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
        remap.set(old, ni);
      }
      indices.push(ni);
    }
    out.push({
      ...mesh,
      id: `${mesh.id}-b${n}`,
      name: `${mesh.name} #${n + 1}`,
      layer: mesh.layer ?? BUILDING_LAYER,
      positions,
      indices,
    });
    n++;
  }
  return out;
}

/** Ab welcher Höhe (Meter) über der Grundmauer ein Dreieck NICHT mehr als
 *  Boden-/Sockel-Deckel gilt (siehe {@link stripOverhangSoffits}). */
const BASE_CAP_TOL = 0.05;
/** Normalen-Höhenkomponente (z, Modell-Hoch-Achse): darunter gilt ein Dreieck
 *  als „zeigt deutlich nach unten" (Soffit-Kandidat). cos(70°) ≈ 0.34 — nur
 *  weitgehend WAAGRECHTE Unterseiten, keine steilen Dachflächen. */
const SOFFIT_DOWN_THRESHOLD = -0.35;

/**
 * Entfernt Dachüberstand-Untersichten (Soffiten) aus einem swissBUILDINGS3D-
 * Mesh: Dreiecke, deren Fläche deutlich nach UNTEN zeigt UND nicht auf
 * Grundmauer-Höhe liegt (kein Boden-/Sockel-Deckel). Solche Flächen sind reine
 * LOD2-Detailtreue (die Untersicht eines Dachüberstands) — im Konturen-
 * Anzeigemodus fallen sie als zusätzliche „man sieht die Wand von unten"-
 * Silhouettenkanten auf (Nutzer-Report), für den gewünschten Gipsmodell-/
 * Massenmodell-Look unerwünscht.
 *
 * ANNAHME: die DXF-Quelle liefert pro Gebäude ein KONSISTENT (aussen = positive
 * Hoch-Komponente) gewundenes Solid (Standard bei swisstopo-LOD2 — die
 * doppelseitige Darstellung in render3d ist eine reine GPU-Vorsichtsmassnahme
 * gegen Einzelfälle, keine Aussage über zufällige Windung). Bei inkonsistenter
 * Windung könnte dies vereinzelt eine echte Dachfläche statt einer Soffite
 * entfernen — visuell in Tauri zu verifizieren.
 *
 * `positions` wird KOMPAKTIERT (analog `clipMeshToBbox`). Rein (kein Netzwerk),
 * exportiert für Unit-Tests.
 */
export function stripOverhangSoffits(mesh: ImportedMesh): ImportedMesh {
  const pos = mesh.positions;
  const idx = mesh.indices;
  if (idx.length < 3 || pos.length < 9) return mesh;

  let minZ = Infinity;
  for (let i = 2; i < pos.length; i += 3) {
    if (pos[i] < minZ) minZ = pos[i];
  }

  const keptTris: [number, number, number][] = [];
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    // Boden-/Sockel-Deckel (alle drei Ecken nahe der Grundmauer-Höhe) bleibt
    // in jedem Fall erhalten — kein Soffit-Kandidat.
    const isBaseCap =
      az <= minZ + BASE_CAP_TOL && bz <= minZ + BASE_CAP_TOL && cz <= minZ + BASE_CAP_TOL;
    if (isBaseCap) {
      keptTris.push([a, b, c]);
      continue;
    }
    // Flächennormale (Modell x,y,z=Höhe): z-Komponente = "nach oben/unten".
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-9 && nz / len < SOFFIT_DOWN_THRESHOLD) continue; // Soffit: weg
    keptTris.push([a, b, c]);
  }

  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const mapVertex = (old: number): number => {
    let ni = remap.get(old);
    if (ni === undefined) {
      ni = positions.length / 3;
      positions.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
      remap.set(old, ni);
    }
    return ni;
  };
  for (const [a, b, c] of keptTris) indices.push(mapVertex(a), mapVertex(b), mapVertex(c));
  return { ...mesh, positions, indices };
}

export interface FetchBuildings3dResult {
  origin: GeoOrigin;
  meshes: ImportedMesh[];
  /** Tatsächlich gelieferte Version (nach evtl. v3→v2-Fallback). */
  versionUsed: BuildingsVersion;
  /**
   * Anzahl STAC-Kacheln, die NICHT geladen werden konnten (zu gross — DXF
   * komprimiert stark, eine Kachel unter {@link MAX_ASSET_BYTES} kann
   * entpackt trotzdem die max. Textlänge sprengen —, Netzwerkfehler oder
   * fehlender Inhalt). Dient der UI, „0 Gebäude" von „X Kacheln übersprungen,
   * zu gross" zu unterscheiden statt eines stummen Leer-Ergebnisses.
   */
  skippedTiles: number;
}

/**
 * Echte swissBUILDINGS3D-Gebäude (Wände + Dachformen, keine Box-Extrusion) für
 * eine LV95-bbox. `version="v3"` versucht zuerst die Beta-Generation und fällt
 * bei leeren/unbrauchbaren Treffern automatisch auf v2 zurück (analog zum
 * Rhino-Referenz-Plugin — v3-Tiles können in Städten riesig sein).
 *
 * `originIn` fehlt ⇒ neue Origin aus `center` (wie `swissTopo.ts::fetchBuildings`) —
 * so teilen sich mehrere Importquellen eines Laufs dieselbe Origin, wenn der
 * Aufrufer die erste zurückgelieferte `origin` an die nächste Quelle reicht.
 */
export async function fetchBuildings3d(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
  version: BuildingsVersion = "v2",
): Promise<FetchBuildings3dResult> {
  const origin = originIn ?? makeOrigin(center);
  const bboxLv95 = bboxAround(center, radius);
  const bboxWgs = lv95BboxToWgs84(bboxLv95);
  // Lokale (origin-verschobene) Zuschnitt-Box — s. clipMeshToBbox: eine STAC-
  // Kachel liefert ALLE Gebäude der Kachel als EIN Mesh, nicht nur die im
  // gesuchten Radius (kann mehrere km ausserhalb des Suchpunkts umfassen).
  const clipBoxLocal: [number, number, number, number] = [
    bboxLv95[0] - origin.e,
    bboxLv95[1] - origin.n,
    bboxLv95[2] - origin.e,
    bboxLv95[3] - origin.n,
  ];

  const tryCollection = async (
    collectionId: string,
  ): Promise<{ meshes: ImportedMesh[]; skipped: number }> => {
    const items = await stacQuery(collectionId, bboxWgs, ASSET_PRIORITY);
    const meshes: ImportedMesh[] = [];
    let skipped = 0;
    for (const item of items) {
      const asset = pickAsset(item, ASSET_PRIORITY);
      if (!asset) {
        skipped++;
        continue;
      }
      const text = await downloadAssetText(asset, [".dxf"]);
      if (!text) {
        skipped++;
        continue;
      }
      const parsed = parseDxf(text);
      for (const m of parsed.meshes) {
        const clipped = clipMeshToBbox(shiftMeshToOrigin(m, origin, item.id), clipBoxLocal);
        if (clipped.indices.length < 3) continue;
        // In EINZELNE Gebäude aufteilen (eine Kachel = ein Mesh mit allen
        // Häusern) — so ist jedes Haus getrennt anwähl-/löschbar. Je Gebäude
        // die Dachüberstand-Untersichten (Soffiten) entfernen (Gipsmodell-Look,
        // s. stripOverhangSoffits-Moduldoc).
        for (const b of splitMeshComponents(clipped)) {
          meshes.push(stripOverhangSoffits(b));
        }
      }
    }
    return { meshes, skipped };
  };

  if (version === "v3") {
    const v3 = await tryCollection(COLLECTION_V3);
    if (v3.meshes.length > 0) {
      return { origin, meshes: v3.meshes, versionUsed: "v3", skippedTiles: v3.skipped };
    }
  }
  const v2 = await tryCollection(COLLECTION_V2);
  return { origin, meshes: v2.meshes, versionUsed: "v2", skippedTiles: v2.skipped };
}
