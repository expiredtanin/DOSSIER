// swissBUILDINGS3D-Import (STAC-API) — echte Gebäude-3D-Geometrie (Wände +
// Dachformen) statt der pauschal auf DEFAULT_BUILDING_HEIGHT extrudierten
// VEC25-Footprints (s. `swissTopo.ts::fetchBuildings`). Zwei Datensatz-
// Generationen, beide über dieselbe offene STAC-API (`stacApi.ts`):
//   • v2 ("ch.swisstopo.swissbuildings3d_2")   — stabil, 1-km-Tiles, ~50 MB,
//     liefert `.dxf`/`.dxf.zip` → `parseDxf`.
//   • v3 ("ch.swisstopo.swissbuildings3d_3_0") — Beta, liefert NUR noch
//     `.dwg.zip`/`.gdb.zip` (kein `.dxf` mehr), in Städten teils >150 MB/Tile
//     (nicht 1-km-strukturiert) → wir fallen bei leeren/zu grossen v3-Treffern
//     automatisch auf v2 zurück. Das Zip bündelt ZWEI DWG-Varianten
//     („…_separated_….dwg" + „…_solid_….dwg"); wir lesen „separated"
//     (`downloadAssetBinary(..., "separated")` wählt sie gezielt aus) — „solid"
//     enthält vermutlich ACIS-Volumenkörper statt Polyface-Mesh (mit dem
//     früheren LibreDWG an echten Kacheln: 0 Entities). Die Geometrie selbst ist
//     ein normales AutoCAD-Polyface-Mesh in per INSERT platzierten Blöcken; der
//     Import (Rust/acadrust, `dwgParser.ts`) liefert die Meshes NACH DXF-LAYER
//     GRUPPIERT: „Roof"/„Wall"/„Floor" je Gebäudefläche.
// Referenz-Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause genutzt):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py.
//
// Assets liegen als DXF/DWG/OBJ/IFC vor (teils `.zip`) — wir wählen bevorzugt
// DXF: `parseDxf` (dxfParser.ts) liest 3DFACE/MESH/Polyface-Entities bereits
// verlustfrei zu `ImportedMesh` (positions/indices, echtes Z); fehlt DXF (v3),
// liest `parseDwg` (dwgParser.ts, Rust-Format-Modul, lazy geladen) dieselbe
// Geometrie aus dem DWG. „Roof"-Layer-Meshes bekommen die Dächer-Kategorie
// ({@link IMPORTED_ROOF_CATEGORY}), alle übrigen (Wand/Boden/ungruppiert) die
// normale Gebäude-Kategorie — VOR dem Zuschnitt zusammengeführt, damit
// Wand+Boden EINES Gebäudes weiterhin ein einziges, löschbares Objekt bleiben
// (nur das Dach wird als eigenes Objekt/Ebene abgespalten, s. Nutzer-Wunsch
// „Dach als eigene, ausblendbare Sub-Ebene").
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, lv95BboxToWgs84, makeOrigin } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { stacQuery, pickAsset, downloadAssetText, downloadAssetBinary } from "./stacApi";
import { parseDxfAsync } from "./dxfParserAsync";
import { importMeshes } from "./importSource";
import { core } from "../engine/coreWasm";
import type { ImportedMesh } from "../model/types";
import { GEO_CATEGORY_DEFS, IMPORTED_ROOF_CATEGORY } from "../model/contextCategories";

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

/** Kern-Ergebnis `[nPos, pos…, idx…]` ab Offset → Positionen/Indizes. */
function decodeMesh(r: Float64Array, at: number): { mesh: { positions: number[]; indices: number[] } } {
  const nPos = r[at] * 3;
  return { mesh: { positions: Array.from(r.subarray(at + 1, at + 1 + nPos)), indices: Array.from(r.subarray(at + 1 + nPos)) } };
}

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
 * weil eine swissBUILDINGS3D-Kachel alle Gebäude der GANZEN Kachel als EIN
 * Mesh liefert. `positions` wird KOMPAKTIERT (nicht referenzierte Ecken entfernt,
 * Indizes neu vergeben). Rechnet der Kern (`core/src/geo_mesh.rs`); rein (kein Netzwerk).
 */
export function clipMeshToBbox(
  mesh: ImportedMesh,
  bboxLocal: [number, number, number, number],
): ImportedMesh {
  const r = core().geo_mesh_clip(Float64Array.from(mesh.positions), Float64Array.from(mesh.indices), Float64Array.from(bboxLocal));
  return r.length === 0 ? { ...mesh, positions: [], indices: [] } : { ...mesh, ...decodeMesh(r, 0).mesh };
}

/** Sichtbarer Ebenen-/Gruppierungsname der importierten Gebäude (SitePanel). */
export const BUILDING_LAYER = "Gebäude";

/**
 * Zerlegt ein Mesh in seine räumlich ZUSAMMENHÄNGENDEN Komponenten (Union-Find
 * über verschweisste Vertices, `weldMm`) — je Komponente ein eigenes {@link ImportedMesh}.
 * So wird eine swissBUILDINGS3D-Kachel in EINZELNE, getrennt anwähl-/löschbare
 * Gebäude aufgeteilt. Jede Komponente bekommt eine eigene Id + fortlaufenden Namen
 * + `layer`. Die Zerlegung rechnet der Kern (`core/src/geo_mesh.rs`); rein (kein Netzwerk).
 */
export function splitMeshComponents(mesh: ImportedMesh, weldMm = 1): ImportedMesh[] {
  const vcount = Math.floor(mesh.positions.length / 3);
  if (vcount < 3 || mesh.indices.length < 3) return mesh.indices.length >= 3 ? [mesh] : [];
  const defaults = {
    layer: mesh.layer ?? BUILDING_LAYER,
    categoryCode: mesh.categoryCode ?? GEO_CATEGORY_DEFS.building.code,
  };
  const r = core().geo_mesh_split(Float64Array.from(mesh.positions), Float64Array.from(mesh.indices), weldMm);
  if (r.length === 0) return [{ ...mesh, ...defaults }];
  const out: ImportedMesh[] = [];
  let at = 1;
  for (let n = 0; n < r[0]; n++) {
    const nPos = r[at] * 3;
    const nIdx = r[at + 1];
    const positions = Array.from(r.subarray(at + 2, at + 2 + nPos));
    const indices = Array.from(r.subarray(at + 2 + nPos, at + 2 + nPos + nIdx));
    at += 2 + nPos + nIdx;
    out.push({ ...mesh, id: `${mesh.id}-b${n}`, name: `${mesh.name} #${n + 1}`, ...defaults, positions, indices });
  }
  return out;
}

/**
 * Führt mehrere Meshes zu einem zusammen (Positions/Indizes je Teil versetzt
 * angehängt) — leere Teile (kein Dreieck) werden übersprungen. `null` bei
 * ausschliesslich leeren Teilen, das EINE übrige Mesh unverändert bei genau
 * einem nicht-leeren Teil (kein unnötiges Kopieren). Metadaten (`layer` etc.)
 * kommen vom ersten nicht-leeren Teil — wird vom Aufrufer ohnehin überschrieben
 * (`categoryCode`), s. `fetchBuildings3d`. Rein, exportiert für Unit-Tests.
 */
export function concatMeshes(parts: ImportedMesh[]): ImportedMesh | null {
  const withGeom = parts.filter((p) => p.indices.length >= 3);
  if (withGeom.length === 0) return null;
  if (withGeom.length === 1) return withGeom[0];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of withGeom) {
    const base = positions.length / 3;
    // KEIN `push(...p.positions)`: bei grossen Kacheln sprengt der Spread-
    // Operator die Argumentzahl-Grenze von `push` (RangeError, s. dwgParser.ts
    // an derselben Stelle — an einer echten 2000-Gebäude-v3-Kachel verifiziert).
    for (const v of p.positions) positions.push(v);
    for (const i of p.indices) indices.push(base + i);
  }
  return { ...withGeom[0], positions, indices };
}

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
 * `positions` wird KOMPAKTIERT (analog `clipMeshToBbox`). Rechnet der Kern
 * (`core/src/geo_mesh.rs`); rein (kein Netzwerk).
 */
export function stripOverhangSoffits(mesh: ImportedMesh): ImportedMesh {
  const r = core().geo_mesh_strip_soffits(Float64Array.from(mesh.positions), Float64Array.from(mesh.indices));
  return r.length === 0 ? mesh : { ...mesh, ...decodeMesh(r, 0).mesh };
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
      // v3 liefert kein `.dxf` mehr (nur `.dwg.zip`/`.gdb.zip`, s. Moduldoc) —
      // Asset-Endung entscheidet, welcher Parser läuft.
      const isDwg = /\.dwg(\.zip)?$/i.test(asset.href);
      let rawMeshes: ImportedMesh[];
      try {
        if (isDwg) {
          // Zip bündelt „separated" + „solid"-DWG; nur „separated" ist lesbar
          // (s. Moduldoc) — gezielt auswählen statt der Zip-internen
          // Reihenfolge zu vertrauen.
          const buf = await downloadAssetBinary(asset, [".dwg"], "separated");
          if (!buf) {
            skipped++;
            continue;
          }
          const { parseDwg } = await import("./dwgParser");
          rawMeshes = importMeshes((await parseDwg(buf)).src);
        } else {
          const text = await downloadAssetText(asset, [".dxf"]);
          if (!text) {
            skipped++;
            continue;
          }
          rawMeshes = importMeshes((await parseDxfAsync(text)).src);
        }
      } catch (err) {
        // `parseDwg`/`parseDxf` werfen bei fatalen Parse-Fehlern BEWUSST (s.
        // deren Moduldoc) — richtig für einen einzelnen Nutzer-Import, aber
        // hier iterieren wir über MEHRERE STAC-Kacheln: eine einzelne kaputte/
        // nicht lesbare Kachel darf nicht den gesamten Mehr-Kachel-Import
        // abbrechen (mit dem früheren LibreDWG-WASM an einer echten v3-Kachel
        // reproduziert: „RuntimeError: function signature mismatch").
        console.warn(`[swissBuildings3d] Kachel ${item.id} übersprungen (Parse-Fehler):`, err);
        skipped++;
        continue;
      }
      // „Roof"-Layer-Meshes (v3 „separated") getrennt von allen übrigen
      // (Wand/Boden/ungruppiert, inkl. dem einzelnen v2-Mesh ohne Layer) —
      // je Gruppe VOR dem Zuschnitt zusammengeführt, damit Wand+Boden EINES
      // Gebäudes ein Objekt bleiben und nur das Dach separat abgespalten wird
      // (s. Moduldoc).
      const roofRaw: ImportedMesh[] = [];
      const bodyRaw: ImportedMesh[] = [];
      for (const m of rawMeshes) {
        ((m.layer ?? "").toLowerCase() === "roof" ? roofRaw : bodyRaw).push(m);
      }
      for (const [group, isRoof] of [
        [bodyRaw, false],
        [roofRaw, true],
      ] as const) {
        const merged = concatMeshes(group);
        if (!merged) continue;
        const clipped = clipMeshToBbox(shiftMeshToOrigin(merged, origin, item.id), clipBoxLocal);
        if (clipped.indices.length < 3) continue;
        // In EINZELNE Gebäude aufteilen (eine Kachel = ein Mesh mit allen
        // Häusern) — so ist jedes Haus getrennt anwähl-/löschbar. Je Gebäude
        // die Dachüberstand-Untersichten (Soffiten) entfernen (Gipsmodell-Look,
        // s. stripOverhangSoffits-Moduldoc).
        for (const b of splitMeshComponents(clipped)) {
          meshes.push({
            ...stripOverhangSoffits(b),
            categoryCode: isRoof ? IMPORTED_ROOF_CATEGORY.code : GEO_CATEGORY_DEFS.building.code,
            // `.layer` (kosmetischer SitePanel-Gruppierungs-String, s.
            // SitePanel.tsx::layerOf/groupByLayer) explizit setzen — sonst
            // trägt er den rohen DXF-Layernamen aus dwgParser.ts ("Wall"/
            // "Floor"/"Roof") weiter, den `splitMeshComponents`s Fallback
            // `mesh.layer ?? BUILDING_LAYER` NICHT ersetzt (nur bei leerem
            // `.layer`, nicht bei einem bereits vorhandenen Wert). Ohne diesen
            // Fix zerfällt die SitePanel-Gruppierung eines v3-Imports in
            // „Wall"/„Floor"/„Roof" statt „Gebäude"/„Dächer".
            layer: isRoof ? IMPORTED_ROOF_CATEGORY.name : BUILDING_LAYER,
          });
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
