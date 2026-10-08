// Leitet aus den Wänden eines Projekts die serialisierbaren WallInput-Records
// für den nativen render3d-Renderer ab. Matcht 1:1 render3d::types::WallInput
// { start:[x,y], end:[x,y], thickness, height, baseElevation, color:[r,g,b] }
// mit Modell-Metern und Y-up-Extrusion (Rust-Seite: plan liegt in XZ, +Y hoch).
//
// Alle Geschosse werden einbezogen und über wallVerticalExtent korrekt
// gestapelt (EG baseElevation 0, OG 2.6 …), sodass das 3D-Fenster das ganze
// Gebäude zeigt.
//
// ÖFFNUNGEN (Türen/Fenster): eine Wand mit Öffnungen wird NICHT als ein Quader
// emittiert, sondern in Teilquader entlang der Achse zerlegt:
//   • volle Wandhöhe links/rechts der Öffnung (Pfeiler),
//   • unter dem Fenster die Brüstung (UK..Sill),
//   • über Tür/Fenster der Sturz (OpeningTop..Wandkopf).
// So entstehen sichtbare Aussparungen ohne dass render3d etwas davon wissen muss.
//
// DECKEN (Slabs): geschossgebundene Flächenbauteile werden als extrudierte
// Polygon-Platten (SlabInput) mitgegeben — render3d trianguliert den Umriss und
// zieht ihn über die Deckendicke hoch.
//
// SCHICHTEN (Putz/Dämmung/Mauerwerk/…): der aufgelöste Schichtaufbau des
// WallType wird HIER (TS-seitig) in echte 3D-Substanz zerlegt — statt EINES
// Vollkörpers in der repräsentativen Farbe emittiert jede Achsen-Teilquader-
// Position je Materiallage eine EIGENE Box, quer zur Wanddicke entlang der
// Wand-Normalen gestapelt und in der Materialfarbe ihres Components eingefärbt
// (Option B). Schicht i belegt entlang der Normalen das Intervall
//   [−T/2 + Σ_{k<i} t_k,  −T/2 + Σ_{k≤i} t_k],  T = Σ t_k (Summe der Lagen),
// zentriert um die Wandachse. Alle Schicht-Boxen einer Wand tragen dieselbe
// `wallId` (Klick/Highlight selektieren die GANZE Wand). Jede Box ist ein
// Vollkörper (`layers: []`), den render3d in ihrer `color` zeichnet — die
// Schicht-Aufteilung passiert also komplett hier, render3d bleibt unverändert.
// Ohne auflösbaren WallType/ohne Schichten: EIN Vollkörper über die volle
// Dicke im neutralen Grundton (heutiges Fallback-Verhalten).
//
// Diese Datei ist nur noch der ORCHESTRATOR: `projectToWalls3d()`/
// `projectToModel3d()`/`pickGeometry()`/`selectionHighlightLines()`. Das
// gemeinsame Serde-Vokabular (`RWall`/`RSlab`/`RMesh`/…) und die Farb-/
// Schraffur-/Material-Auflösung leben in `toWalls3d/shared.ts`; jede
// Bauteil-Domäne (Wand-Bänder, Decken, Öffnungen, Treppen, Dächer, Stützen,
// truck-Extrusionen, freie 2D-Geometrie) hat ihre eigene Datei unter
// `toWalls3d/` — siehe dort für die konkrete Emissions-Logik je Bauteil.

import type { Project, Vec2, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import type { ToolDraft } from "../tools/types";
import { stairVerticalExtent } from "../model/wall";
import { openingJambs, openingVerticalExtent } from "../geometry/opening";
import type { DetailLevel } from "../ui/TopBar";
import { stairBBox, stairGeometry } from "../geometry/stair";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import type { Vec3 as RoofVec3 } from "../geometry/roof";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";
import type { PickOpening, PickRoof, PickStair, PickContextMesh, PickDrawingSeg } from "../viewport/raycast3d";
import {
  EPS,
  IMPORTED_RGB,
  TERRAIN_RGB,
  wallMaterialColorMaps,
  type RMesh,
  type RModel3d,
  type RRgb,
  type RSlab,
  type RVec2,
  type RWall,
} from "./toWalls3d/shared";
import { emitWall } from "./toWalls3d/bands";
import { emitSlabs } from "./toWalls3d/ceilings";
import { emitStairMeshes, emitStairRailings, emitStairs } from "./toWalls3d/stairs";
import { emitExtrudedSolids, TRUCK_MESH_READY_EVENT } from "./toWalls3d/extrusions";
import { emitDrawingLines, pickDrawingSegs } from "./toWalls3d/drawing2d";
import { emitColumns } from "./toWalls3d/columns";
import { emitRoofCutLayers, emitRoofs } from "./toWalls3d/roofs";
import { emitLegacyDoorLeaves, emitOpeningFrames, emitOpeningGlass, emitOpeningShading } from "./toWalls3d/openings";

// Re-Export des gemeinsamen Vokabulars — externe Konsumenten (viewport/,
// export/, toSection.ts, nativeSync.ts, …) importieren weiterhin
// ausschliesslich von hier, unverändert zur Zeit vor dem Domänen-Split.
export { wallMaterialColorMaps, TRUCK_MESH_READY_EVENT };
export type { RVec2, RRgb, RWall, RSlab, RModel3d };

/** World-Punkt [x, Höhe, y] für den Dach-Pick (Vec3-Konvention von raycast3d). */
type RoofPickVec3 = [number, number, number];

/** Weltpunkt (x, elevation, y) — nur intern für Highlight-Kantengeometrie. */
type RVec3 = [number, number, number];

/**
 * Emittiert die rohen Kontext-Meshes eines Projekts: Gelände-TINs (`terrainMesh`)
 * und importierte Volumen (`importedMesh`) aus `project.context`, plus alle
 * übrigen Kontext-Mesh-Domänen (truck-Extrusionen, Stützen, 2D-Boden-Spuren).
 * `contourSet` bleibt außen vor — das sind nur 2D-Linien (Höhenlinien/
 * Footprints), keine Dreiecksmeshes. Die `positions`/`indices` der Geo-Meshes
 * werden 1:1 durchgereicht (Modell-Koordinaten, x,y,z=Höhe); render3d bildet
 * sie selbst nach world ab.
 */
function emitMeshes(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const obj of project.context ?? []) {
    if (obj.type === "terrainMesh" || obj.type === "importedMesh") {
      // Leere/entartete Meshes überspringen (render3d würde sie ohnehin verwerfen).
      if (obj.positions.length < 9 || obj.indices.length < 3) continue;
      out.push({
        positions: obj.positions,
        indices: obj.indices,
        kind: obj.type === "terrainMesh" ? "terrain" : "imported",
        color: obj.type === "terrainMesh" ? TERRAIN_RGB : IMPORTED_RGB,
        // Luftbild-Drape: das Gelände-TIN kann Pro-Vertex-Farben tragen (beim
        // Import aus dem Luftbild gesampelt) — dann zeigt render3d das Ortho
        // statt der Flächen-Grundfarbe.
        vertexColors:
          obj.type === "terrainMesh" && obj.vertexColors?.length
            ? obj.vertexColors
            : undefined,
      });
    }
  }
  // KEIN `out.push(...emitDrawingLines(project))`: bei grossen Importen (z. B.
  // ein Kataster-DXF einer ganzen Stadt → hunderttausende Drawing2D-Elemente,
  // je eins ein Mesh) sprengt der Spread-Operator die Argumentzahl-Grenze von
  // `push` (RangeError "Maximum call stack size exceeded") — dieselbe, bereits
  // dokumentierte Falle wie in `swissBuildings3d.ts::concatMeshes`/
  // `dwgParser.ts`. `emitExtrudedSolids`/`emitColumns` sind praktisch nie so
  // gross (Nutzer-platzierte BIM-Elemente), aber aus Konsistenz gleich
  // behandelt.
  for (const m of emitExtrudedSolids(project)) out.push(m);
  for (const m of emitColumns(project)) out.push(m);
  for (const m of emitDrawingLines(project)) out.push(m);
  return out;
}

/**
 * Nur die Wände (Rückwärts-Kompatibilität / bestehende Aufrufer). Zerlegt Wände
 * mit Öffnungen in Teilquader.
 */
export function projectToWalls3d(project: Project, layered = true): RWall[] {
  const out: RWall[] = [];
  // Verschneidungs-Schnittlinien PRO GESCHOSS berechnen (wie generatePlan.ts sie
  // je Grundriss auf der gefilterten Wandmenge bildet) — nur für den layered-3D-
  // Pfad. Nach Geschoss gruppieren, damit deckungsgleiche Wände verschiedener
  // Geschosse (z. B. EG/OG an identischen XY-Knoten) NICHT fälschlich verschneiden.
  // Der Schnitt-Pfad (layered=false) bekommt KEINE Cuts (unverändert, seine
  // Dominanz macht toSection.ts). Anders als im 2D wird hier NICHT nach
  // Sichtbarkeit gefiltert — 3D zeigt alle Wände, alle nehmen an den Joins teil.
  const joins = layered ? computeJoinsByFloor(project) : undefined;
  for (const w of project.walls) emitWall(out, project, w, layered, joins?.get(w.id));
  return out;
}

/**
 * Berechnet `computeJoins` getrennt je Geschoss (`wall.floorId`) und führt
 * die Ergebnis-Maps zu einer flachen `wallId → WallCuts` zusammen. So bilden nur
 * Wände desselben Geschosses gemeinsame Ecken/T-Stösse (identisch zur 2D-Semantik,
 * wo `generatePlan` je Grundriss aufruft).
 */
function computeJoinsByFloor(project: Project): Map<string, WallCuts> {
  const byFloor = new Map<string, Wall[]>();
  for (const w of project.walls) {
    const key = w.floorId ?? "";
    const list = byFloor.get(key);
    if (list) list.push(w);
    else byFloor.set(key, [w]);
  }
  const merged = new Map<string, WallCuts>();
  for (const walls of byFloor.values()) {
    const cuts = computeJoins(project, walls);
    for (const [id, wc] of cuts) merged.set(id, wc);
  }
  return merged;
}

/**
 * Optionen für {@link projectToModel3d}. `layeredWalls` steuert, ob eine
 * mehrschichtige Wand als eigene Box je Materiallage (Default, 3D-Viewer) oder
 * als EINE Voll-Box über die ganze Dicke emittiert wird. Der Schnitt-Pfad
 * (`computeSection`) setzt `false`, damit die Cut-Polygone 1:1 zur Wand liegen
 * (die Schicht-Zerlegung macht dort `splitWallLayers` TS-seitig) — sonst
 * verschöben die per-Lage vervielfachten Boxen die `ComponentRef.index`
 * gegenüber `wallSegmentOwners` und die materialspezifische Schnitt-Schraffur
 * ginge verloren.
 */
export interface Model3dOptions {
  layeredWalls?: boolean;
  /**
   * Detailgrad der Öffnungs-Darstellung im 3D (wie im 2D-Grundriss, Referenz ist
   * der VW-Detailgrad "fein"):
   *  • "grob"  — keine Rahmen/Sprossen (nur Loch + Scheibe).
   *  • "mittel"— Blendrahmen (Pfosten/Sturz/Schwelle) + ggf. Kämpfer, dazu die
   *    verschachtelten Flügelrahmen, Fensterbank (Sims) und Zargen-Umgriff — aber
   *    KEINE Sprossen und KEINE SIA-Öffnungssymbole.
   *  • "fein"  — zusätzlich Flügel-Mittelpfosten + Kämpfer-Zeilen (Sprossen) und
   *    die SIA-Öffnungssymbole (Dreh/Kipp) auf dem Glas.
   * Fehlt es, gilt "fein" (= volle Details).
   */
  detail?: DetailLevel;
}

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten + Kontext-Meshes. */
export function projectToModel3d(project: Project, opts: Model3dOptions = {}): RModel3d {
  const layered = opts.layeredWalls ?? true;
  const detail = opts.detail ?? "fein";
  return {
    walls: projectToWalls3d(project, layered),
    // Decken + Treppen (Treppentritte als extrudierte Slabs) — so wird die Treppe
    // auch im WASM/wgpu-Renderer sichtbar (der three.js-Pfad rendert sie separat).
    slabs: [...emitSlabs(project), ...emitStairs(project)],
    // Kontext-Meshes (Terrain/Import) + Fenster-/Tür-Glasscheiben (eigenes Mesh
    // je Scheibe) + Rahmen-/Sprossen-Riegel typisierter Öffnungen (Zarge/
    // Blendrahmen/Kämpfer/Mittelpfosten, s. emitOpeningFrames) + glatte Beton-
    // Laufplatten (gerade Betontreppen als Mesh) + Dachflächen/-giebel
    // (s. emitRoofs) — pickGeometry/Highlight nutzen `meshes` bewusst NICHT (man
    // wählt Wand/Öffnung/Treppe; Treppen-Pick läuft über die pickGeometry-Boxen).
    meshes: [
      ...emitMeshes(project),
      ...emitOpeningGlass(project),
      ...emitLegacyDoorLeaves(project),
      ...emitOpeningFrames(project, detail),
      ...emitOpeningShading(project, detail),
      ...emitStairMeshes(project),
      ...emitStairRailings(project),
      ...emitRoofs(project),
    ],
    // Dach-Schicht-Eingabe für den 3D-Live-Schnitt (render3d::roof_cut) — s.
    // Kopfkommentar bei `RRoofLayer`/`emitRoofCutLayers`: getrennt von `meshes`,
    // weil `section.rs` beliebige Dreiecksnetze nicht schneiden kann.
    roofLayers: emitRoofCutLayers(project),
  };
}

/**
 * Pick-Geometrie für den TS-seitigen 3D-Raycast (siehe viewport/raycast3d): die
 * Wand-Teilquader (mit `wallId`) und Decken-Prismen (mit `ceilingId`) desselben
 * geflachten Modells wie {@link projectToModel3d}, aber ohne die Kontext-Meshes
 * (die sind für die Bauteil-Auswahl irrelevant), PLUS die Öffnungs- (Fenster/
 * Türen) und Treppen-Boxen sowie die (tolerant aufgeweiteten) Boden-Spuren
 * freier 2D-Zeichnungen (`drawings`, s. `toWalls3d/drawing2d.ts::
 * pickDrawingSegs`) fürs Raycast-Picking. Reine TS-Nutzung — geht NICHT an
 * render3d; die Records tragen dieselben Geometriefelder wie die Serde-
 * Payload, plus die Ids fürs Picking.
 */
export function pickGeometry(
  project: Project,
): {
  walls: RWall[];
  slabs: RSlab[];
  openings: PickOpening[];
  stairs: PickStair[];
  roofs: PickRoof[];
  contextMeshes: PickContextMesh[];
  drawings: PickDrawingSeg[];
} {
  // Dächer: Dachflächen + Giebel als WORLD-Dreiecke (fan-trianguliert wie
  // emitRoofs; model [x,y,z=Höhe] → world [x, z, y]) — präzise geneigte
  // Flächen für den Ray-Dreieck-Pick (raycast3d.rayRoofTris).
  const roofs: PickRoof[] = [];
  for (const roof of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, roof);
    const g = roofGeometry(roof, eavesZ);
    const tris: [RoofPickVec3, RoofPickVec3, RoofPickVec3][] = [];
    const toWorld = (p: RoofVec3): RoofPickVec3 => [p[0], p[2], p[1]];
    for (const poly of [...g.planes.map((pl) => pl.pts), ...g.gables]) {
      for (let i = 1; i + 1 < poly.length; i++) {
        tris.push([toWorld(poly[0]), toWorld(poly[i]), toWorld(poly[i + 1])]);
      }
    }
    if (tris.length > 0) roofs.push({ tris, roofId: roof.id });
  }
  const openings: PickOpening[] = [];
  for (const o of project.openings ?? []) {
    const wall = project.walls.find((w) => w.id === o.hostWallId);
    if (!wall) continue;
    const jambs = openingJambs(wall, o);
    if (!jambs) continue;
    const thickness = wallTypeThickness(getWallType(project, wall));
    const { zBottom, zTop } = openingVerticalExtent(project, wall, o);
    if (zTop - zBottom <= 0) continue;
    openings.push({
      start: [jambs.jambStart.x, jambs.jambStart.y],
      end: [jambs.jambEnd.x, jambs.jambEnd.y],
      thickness,
      height: zTop - zBottom,
      baseElevation: zBottom,
      openingId: o.id,
    });
  }
  const stairs: PickStair[] = [];
  for (const st of project.stairs ?? []) {
    const { zBottom, zTop } = stairVerticalExtent(project, st);
    const totalRise = zTop - zBottom;
    if (totalRise <= 0) continue;
    const bbox = stairBBox(stairGeometry(st, totalRise));
    stairs.push({
      outline: [
        [bbox.minX, bbox.minY],
        [bbox.maxX, bbox.minY],
        [bbox.maxX, bbox.maxY],
        [bbox.minX, bbox.maxY],
      ],
      zBottom,
      zTop,
      stairId: st.id,
    });
  }
  // Kontext-Meshes (importierte Gebäude/Terrain, s. ContextObject): rohe
  // WORLD-Dreiecke, direkt aus dem Indexpuffer (kein Fan nötig — ImportedMesh/
  // TerrainMesh liefern bereits ein echtes Dreiecksnetz). Kaputte Indizes
  // robust überspringen statt abzustürzen (importierte Daten).
  // Modell (x,y,z) → world (x, z, −y) — Nord-Achse NEGIERT, damit der Pick
  // dieselbe (gespiegelte→korrigierte) Lage trifft wie die sichtbare Geometrie
  // in `viewport3d/meshBuilders.ts::buildContextMesh` (dort ausführlich
  // begründet: reines Achsen-Vertauschen ohne Vorzeichenwechsel ist für einen
  // allgemeinen xyz-Punktsatz eine Spiegelung, anders als bei Wand/Dach, die
  // über eine orientierungserhaltende Rotation/Fächer-Triangulation entstehen).
  const contextMeshes: PickContextMesh[] = [];
  for (const obj of project.context ?? []) {
    if (obj.type === "contourSet" || obj.type === "image") continue;
    const pos = obj.positions;
    const vcount = pos.length / 3;
    const tris: [RoofPickVec3, RoofPickVec3, RoofPickVec3][] = [];
    for (let i = 0; i + 2 < obj.indices.length; i += 3) {
      const ia = obj.indices[i];
      const ib = obj.indices[i + 1];
      const ic = obj.indices[i + 2];
      if (ia >= vcount || ib >= vcount || ic >= vcount) continue;
      const at = (idx: number): RoofPickVec3 => [pos[idx * 3], pos[idx * 3 + 2], -pos[idx * 3 + 1]];
      tris.push([at(ia), at(ib), at(ic)]);
    }
    if (tris.length > 0) contextMeshes.push({ tris, contextObjectId: obj.id });
  }
  const drawings = pickDrawingSegs(project);
  return {
    walls: projectToWalls3d(project),
    slabs: emitSlabs(project),
    openings,
    stairs,
    roofs,
    contextMeshes,
    drawings,
  };
}

/**
 * Baut die Highlight-Linien der aktuellen 3D-Auswahl (Wand-/Decken-Ids) als
 * flaches LineList-Vertex-Array `[px,py,pz,r,g,b, ...]` (world-Meter, je 2
 * Vertices = 1 Kante) — genau das Format, das `set_highlight_lines` erwartet
 * (immer obenauf gezeichnete Akzent-Umrisslinie, s. useWasm3dRenderer). Leere
 * Auswahl → leeres Array (Highlight löschen).
 *
 * GEOMETRIE (dieselbe Welt-Konvention wie pickGeometry/raycast3d: model (x,y)
 * → world (x, elevation, y), Höhe entlang +Y):
 *  • Wand: derselbe orientierte Quader wie `rayWallBox` (raycast3d.ts) — Achse
 *    entlang der Wandlänge, Normale (Dicke) senkrecht dazu in der XZ-Ebene,
 *    Y = Höhe. Aus den 8 Ecken werden die 12 Kanten des Quaders emittiert.
 *    Wände MIT Öffnungen bestehen aus mehreren Teilquadern (Pfeiler/Brüstung/
 *    Sturz, s. emitWall) — alle tragen dieselbe `wallId` und werden hier ALLE
 *    umrandet, sodass Öffnungsränder mit hervorgehoben werden.
 *  • Decke: der Umriss oben (zTop) und unten (zBottom) je als geschlossener
 *    Kantenzug, plus eine vertikale Kante an jeder Umriss-Ecke.
 *
 * Kanten werden EINFACH (nicht versetzt/doppelt) ausgegeben — eine zweite,
 * leicht verschobene Kopie je Linie (für optisch "breitere" Linien bei
 * WebGPU-Linienbreite 1) würde die Vertexzahl verdoppeln und die Achse/Betrag
 * des Versatzes müsste in Bildschirm- statt Weltraum berechnet werden (hängt
 * von Kamera-Distanz/-Winkel ab) — außerhalb des schmalen TS-Rahmens dieser
 * Funktion. Der Renderer kann das bei Bedarf selbst tun (Rust-seitige
 * Linienbreite/Shader), ohne dass sich dieses Vertexformat ändert.
 */
export function selectionHighlightLines(
  project: Project,
  wallIds: string[],
  ceilingIds: string[],
  rgb: RRgb,
  openingIds: string[] = [],
  stairIds: string[] = [],
  roofIds: string[] = [],
  contextObjectIds: string[] = [],
): Float32Array {
  if (
    wallIds.length === 0 &&
    ceilingIds.length === 0 &&
    openingIds.length === 0 &&
    stairIds.length === 0 &&
    roofIds.length === 0 &&
    contextObjectIds.length === 0
  ) {
    return new Float32Array(0);
  }
  const { walls, slabs, openings, stairs } = pickGeometry(project);
  const wallSet = new Set(wallIds);
  const ceilingSet = new Set(ceilingIds);
  const openingSet = new Set(openingIds);
  const stairSet = new Set(stairIds);
  const roofSet = new Set(roofIds);
  const contextObjSet = new Set(contextObjectIds);
  const out: number[] = [];
  const pushEdge = (a: RVec3, b: RVec3) => {
    out.push(a[0], a[1], a[2], rgb[0], rgb[1], rgb[2]);
    out.push(b[0], b[1], b[2], rgb[0], rgb[1], rgb[2]);
  };
  // 12 Kanten eines Quaders aus 8 Ecken (Ecken-Index-Bits: bit0=Achse,
  // bit1=Höhe, bit2=Dicke — je zwei Ecken, die sich in genau einem Bit
  // unterscheiden, bilden eine Kante).
  const BOX_EDGES: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
  ];
  // Orientierter Quader (Wand ODER Öffnung: gleiche Felder start/end/thickness/
  // height/baseElevation) → seine 12 Kanten.
  const boxEdges = (b: {
    start: readonly [number, number];
    end: readonly [number, number];
    thickness: number;
    height: number;
    baseElevation: number;
  }) => {
    const ax = b.end[0] - b.start[0];
    const az = b.end[1] - b.start[1];
    const len = Math.hypot(ax, az);
    if (len < EPS || b.height <= EPS || b.thickness <= EPS) return;
    const axis: RVec3 = [ax / len, 0, az / len];
    const normal: RVec3 = [az / len, 0, -ax / len];
    const halfLen = len / 2;
    const halfHeight = b.height / 2;
    const halfThick = b.thickness / 2;
    const center: RVec3 = [
      (b.start[0] + b.end[0]) / 2,
      b.baseElevation + b.height / 2,
      (b.start[1] + b.end[1]) / 2,
    ];
    const corners: RVec3[] = [];
    for (let i = 0; i < 8; i++) {
      const sL = i & 1 ? 1 : -1;
      const sH = i & 2 ? 1 : -1;
      const sT = i & 4 ? 1 : -1;
      corners.push([
        center[0] + sL * halfLen * axis[0] + sT * halfThick * normal[0],
        center[1] + sH * halfHeight,
        center[2] + sL * halfLen * axis[2] + sT * halfThick * normal[2],
      ]);
    }
    for (const [i, j] of BOX_EDGES) pushEdge(corners[i], corners[j]);
  };
  // Vertikales Prisma (Decke ODER Treppen-Fussabdruck) → Umriss oben/unten + Ecken.
  const prismEdges = (outline: ReadonlyArray<readonly [number, number]>, zBottom: number, zTop: number) => {
    const n = outline.length;
    if (n < 3 || zTop - zBottom <= EPS) return;
    const bottom: RVec3[] = outline.map((p) => [p[0], zBottom, p[1]]);
    const top: RVec3[] = outline.map((p) => [p[0], zTop, p[1]]);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      pushEdge(bottom[j], bottom[i]);
      pushEdge(top[j], top[i]);
    }
    for (let i = 0; i < n; i++) pushEdge(bottom[i], top[i]);
  };
  for (const w of walls) if (wallSet.has(w.wallId)) boxEdges(w);
  for (const o of openings) if (openingSet.has(o.openingId)) boxEdges(o);
  for (const s of slabs) if (ceilingSet.has(s.ceilingId)) prismEdges(s.outline, s.zBottom, s.zTop);
  for (const st of stairs) if (stairSet.has(st.stairId)) prismEdges(st.outline, st.zBottom, st.zTop);
  // Dach: die Kanten aller Dachflächen + Giebel als Draht-Umriss (roofGeometry
  // liefert 3D-Polygone in MODELL-Koordinaten [x, y, z=Höhe]; world = [x, z, y]).
  if (roofSet.size > 0) {
    for (const roof of project.roofs ?? []) {
      if (!roofSet.has(roof.id)) continue;
      const g = roofGeometry(roof, roofBaseElevation(project, roof));
      const polyEdges = (pts: readonly (readonly [number, number, number])[]) => {
        const m = pts.length;
        for (let i = 0, j = m - 1; i < m; j = i++) {
          const a = pts[j];
          const b = pts[i];
          pushEdge([a[0], a[2], a[1]], [b[0], b[2], b[1]]);
        }
      };
      for (const pl of g.planes) polyEdges(pl.pts);
      for (const gab of g.gables) polyEdges(gab);
    }
  }
  // Kontext-Objekt (importiertes Gebäude/Terrain): Umriss als achsenparallele
  // Bounding-Box statt vollem Dreiecks-Wireframe — importierte Meshes haben oft
  // tausende Dreiecke, deren Kanten einzeln zu zeichnen wäre unbrauchbar dicht.
  if (contextObjSet.size > 0) {
    for (const obj of project.context ?? []) {
      if (obj.type === "contourSet" || obj.type === "image" || !contextObjSet.has(obj.id)) continue;
      const pos = obj.positions;
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minH = Infinity, maxH = -Infinity;
      for (let i = 0; i + 2 < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], h = pos[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      if (!isFinite(minX)) continue;
      const corners: RVec3[] = [];
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? maxX : minX;
        const h = i & 2 ? maxH : minH;
        const y = i & 4 ? maxY : minY;
        corners.push([x, h, y]);
      }
      for (const [i, j] of BOX_EDGES) pushEdge(corners[i], corners[j]);
    }
  }
  return new Float32Array(out);
}

/** Blau-Akzent der Zeichnen-Vorschau — identisch zu `Viewport3D.tsx`s `draftLineMat` (0x2f8fff). */
const DRAFT_LINE_RGB: RRgb = [0x2f / 255, 0x8f / 255, 0xff / 255];
/** Warmes Gelb für Fang-Marker/-Führungslinien (Objekt-Snap, Ortho/Extension,
 * weicher Winkel-Snap) — analog dem 2D-Snap-Akzent (`PlanView`s `snapColor`-
 * Prop), hier als fester Wert (der 3D-Viewport hat noch keine eigene
 * einstellbare Snap-Farbe, s. PENDENZEN „ArchiCAD-Wunschliste"). */
const SNAP_GUIDE_RGB: RRgb = [1, 0.8, 0];
/** Halbe Kantenlänge des Fang-Markers (Welt-Meter) — deutlich grösser als die
 * 0.008m Zeichnungs-Linienbreite, aber klein genug, den Punkt nicht zu
 * verdecken. */
const SNAP_MARKER_HALF = 0.06;
/** Länge der weichen-Winkel-Führungslinie über den Fangpunkt hinaus (Welt-
 * Meter) — bewusst ENDLICH (anders als die 2D-SVG-Version, die bis zum
 * Viewport-Rand läuft; im 3D gibt es keine sinnvolle "Rand"-Grenze, eine
 * unendliche Linie liefe unkontrolliert durchs ganze Modell). */
const SNAP_ANGLE_GUIDE_EXTEND_M = 6;

/**
 * Wandelt den aktiven Werkzeug-Draft (`ToolDraft.preview`, Modell-Meter,
 * Grundriss-Ebene) in dasselbe flache Weltraum-LineList-Format wie
 * {@link selectionHighlightLines} (`[px,py,pz,r,g,b, ...]`, world-Meter, je 2
 * Vertices = 1 Kante) — reicht denselben `set_highlight_lines`-Kanal der
 * WASM-Engine, um im 3D-Viewport eine Live-Vorschau beim Zeichnen zu zeigen
 * (Parität zum three.js-Pfad, dessen `drawDraft` dieselben `DraftShape`s auf
 * derselben Ebene rendert). Modell (x,y) → world (x, planeY, y) — KEIN
 * Vorzeichenwechsel (dieselbe unveränderte, orientierungserhaltende
 * Konvention wie Wand-/Zeichnungslinien; s. `addDrawingLines`/`toWalls3d/
 * drawing2d.ts` — anders als die Kontext-Mesh-Konvention, s. PENDENZEN.md).
 *
 * ZUSÄTZLICH (Nutzer-Wunsch „generell im 3D auch Snapping einbauen"): bei
 * gesetztem `draft.snap` ein kleines Quadrat am Fangpunkt (JEDE Fang-Art,
 * analog der 2D-`SnapMarker`) sowie — bei Ortho-/Verlängerungs-Fang bzw.
 * weichem Winkel-Fang — die zugehörige Bezugslinie/-Führungslinie (analog
 * `snap-helper-line`/`AngleGuide` im 2D-Plan). Läuft VOR jedem gesetzten
 * Punkt (auch beim allerersten Klick, ohne `preview`), zeigt der Marker also
 * schon, wohin der erste Punkt fängt — deshalb NICHT mehr früh bei leerem
 * `preview` abgebrochen.
 */
export function draftWorldLines(draft: ToolDraft | null, planeY: number): Float32Array {
  if (!draft) return new Float32Array(0);
  const out: number[] = [];
  const pushSeg = (a: Vec2, bPt: Vec2, rgb: RRgb = DRAFT_LINE_RGB) => {
    const [cr, cg, cb] = rgb;
    out.push(a.x, planeY, a.y, cr, cg, cb);
    out.push(bPt.x, planeY, bPt.y, cr, cg, cb);
  };
  for (const shape of draft.preview) {
    if (shape.kind === "line") {
      pushSeg(shape.a, shape.b);
    } else {
      const n = shape.pts.length;
      for (let i = 0; i + 1 < n; i++) pushSeg(shape.pts[i], shape.pts[i + 1]);
      if (shape.closed && n > 2) pushSeg(shape.pts[n - 1], shape.pts[0]);
    }
  }
  const snap = draft.snap;
  if (snap) {
    const p = snap.point;
    const h = SNAP_MARKER_HALF;
    const c1 = { x: p.x - h, y: p.y - h };
    const c2 = { x: p.x + h, y: p.y - h };
    const c3 = { x: p.x + h, y: p.y + h };
    const c4 = { x: p.x - h, y: p.y + h };
    pushSeg(c1, c2, SNAP_GUIDE_RGB);
    pushSeg(c2, c3, SNAP_GUIDE_RGB);
    pushSeg(c3, c4, SNAP_GUIDE_RGB);
    pushSeg(c4, c1, SNAP_GUIDE_RGB);
    if (snap.refA && (snap.kind === "ortho" || snap.kind === "extension")) {
      pushSeg(snap.refA, p, SNAP_GUIDE_RGB);
    } else if (snap.refA && snap.kind === "angle") {
      const dx = p.x - snap.refA.x;
      const dy = p.y - snap.refA.y;
      const len = Math.hypot(dx, dy);
      const ext =
        len > 1e-6
          ? { x: p.x + (dx / len) * SNAP_ANGLE_GUIDE_EXTEND_M, y: p.y + (dy / len) * SNAP_ANGLE_GUIDE_EXTEND_M }
          : p;
      pushSeg(snap.refA, ext, SNAP_GUIDE_RGB);
    }
  }
  return new Float32Array(out);
}
