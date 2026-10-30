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

import type { Project, Vec2 } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";
import { documentFor } from "../core/document";
import type { PickOpening, PickRoof, PickStair, PickContextMesh, PickDrawingSeg } from "./pickTypes";
import {
  type RMesh,
  type RModel3d,
  type RRgb,
  type RSlab,
  type RVec2,
  type RWall,
} from "./toWalls3d/shared";
import { emitExtrudedSolids, TRUCK_MESH_READY_EVENT } from "./toWalls3d/extrusions";
import { applyVoids3d, type VoidCuts } from "./toWalls3d/voids3d";

// Re-Export des gemeinsamen Vokabulars — externe Konsumenten (viewport/,
// export/, toSection.ts, nativeSync.ts, …) importieren weiterhin
// ausschliesslich von hier, unverändert zur Zeit vor dem Domänen-Split.
export { TRUCK_MESH_READY_EVENT };
export type { RVec2, RRgb, RWall, RSlab, RModel3d };

/**
 * Boden-Spuren aller 2D-Zeichnungen (Linie, Polylinie, Rechteck) als LineList-Vertices
 * `[px, py, pz, r, g, b]` in Welt-Metern für render3d (`set_drawing_lines`, Binärkanal — ein
 * Kataster-DXF kann Millionen Segmente liefern, als JSON-Mesh sprengte das Speicher und
 * String-Länge). Rechnet der Kern (`model3d.rs`, Chargen).
 */
export function emitDrawingLineVerts(project: Project): Float32Array {
  return documentFor(project).drawingLineVerts();
}

/**
 * Ansichtsschraffur ([100]) auf den Flächen als Linien für render3d (`set_pattern_lines`): je Linie
 * `ax ay az bx by bz r g b maske` (Welt-Meter); die Maske wählt die Ausdünnung nach Abstand.
 */
export function emitSurfacePatternLines(project: Project): Float32Array {
  return documentFor(project).surfacePatternLines();
}

/**
 * Nur die Wände (Rückwärts-Kompatibilität / bestehende Aufrufer). Zerlegt Wände mit Öffnungen in
 * Teilquader bzw. (layered) in Schicht-Bänder. Rechnet der Kern auf dem Projekt-Dokument
 * (`model3d.rs`: Verschneidung je Geschoss, Bänder, Öffnungen, Decken-/Dach-Dominanz).
 */
export function projectToWalls3d(project: Project, layered = true): RWall[] {
  return documentFor(project).query<RWall[]>("walls", [layered ? 1 : 0]);
}

/**
 * Textur-Karten-URLs der Bauteile in der Reihenfolge des ersten Auftretens (Wandtypen, Decken,
 * Dächer): die Position + 1 ist die Textur-Ebene (`materialIndex`). Memoisiert je Projekt-Referenz.
 */
const materialMapCache = new WeakMap<Project, string[]>();
export function wallMaterialColorMaps(project: Project): string[] {
  let maps = materialMapCache.get(project);
  if (!maps) {
    maps = documentFor(project).query<string[]>("materialMaps");
    materialMapCache.set(project, maps);
  }
  return maps;
}

/**
 * Dach-Meshes (geschlossene, geschichtete Körper je Dachschicht); `onlyRoofId` beschränkt auf ein
 * Dach (IFC-Export). Rechnet der Kern.
 */
export function roofMeshes(project: Project, onlyRoofId?: string): RMesh[] {
  return documentFor(project).query<RMesh[]>("roofMeshes", [], onlyRoofId ?? "");
}

/**
 * Optionen für {@link projectToModel3d}. `layeredWalls` steuert, ob eine
 * mehrschichtige Wand als eigene Box je Materiallage (Default, 3D-Viewer) oder
 * als EINE Voll-Box über die ganze Dicke emittiert wird (so rechnen auch Schnitt
 * und Ansicht im Kern, `core/src/plan/{section,elevation}.rs`).
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
  /** Schnitt-Eingabe: Treppen immer als Tritt-Prismen (s. `emitStairs` `forSection`). */
  forSection?: boolean;
  /**
   * 3D-Viewer: Abzugskörper per truck-Boolean von Wänden/Decken abziehen (s.
   * `toWalls3d/voids3d.ts`). Schnitt/Ansicht/Export behandeln Abzugskörper selbst.
   */
  voids?: boolean;
}

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten + Kontext-Meshes. */
export function projectToModel3d(project: Project, opts: Model3dOptions = {}): RModel3d {
  const layered = opts.layeredWalls ?? true;
  const detail = opts.detail ?? "fein";
  // Mit `voids` liefert der Kern zusätzlich die getroffenen Wände/Decken als truck-Spezifikationen.
  const voids = !!opts.voids && typeof window !== "undefined";
  const parts = documentFor(project).query<Model3dParts>(
    "model3dParts",
    [layered ? 1 : 0, DETAIL_CODE[detail] ?? 3, opts.forSection ? 1 : 0, voids ? 1 : 0],
  );
  // Die truck-Körper (asynchron, mit Cache) kommen zwischen Kontext-Meshes und Stützen.
  const meshes: RMesh[] = [...parts.contextMeshes];
  for (const m of emitExtrudedSolids(project)) meshes.push(m);
  for (const m of parts.columnMeshes) meshes.push(m);
  for (const m of parts.openingMeshes) meshes.push(m);
  for (const m of parts.stairMeshes) meshes.push(m);
  for (const m of parts.stairRailings) meshes.push(m);
  for (const m of parts.roofMeshes) meshes.push(m);
  const model: RModel3d = {
    walls: parts.walls,
    // Decken + Treppen (Treppentritte als extrudierte Slabs), Kontext-Meshes, Öffnungs-Einbauteile,
    // Betonlaufplatten, Handläufe und Dachflächen: alles aus dem Kern; Dach-Schichten für den
    // 3D-Live-Schnitt getrennt (`roofLayers`).
    slabs: parts.slabs,
    meshes,
    roofLayers: parts.roofLayers,
  };
  if (parts.voidCuts) applyVoids3d(model, parts.voidCuts);
  return model;
}

/** Teile des 3D-Modells aus dem Kern (`model3d::Parts`). */
interface Model3dParts {
  walls: RWall[];
  slabs: RSlab[];
  contextMeshes: RMesh[];
  columnMeshes: RMesh[];
  openingMeshes: RMesh[];
  stairMeshes: RMesh[];
  stairRailings: RMesh[];
  roofMeshes: RMesh[];
  roofLayers: RModel3d["roofLayers"];
  /** Nur mit Abzugskörpern: (Index im Modell, Bauteil − Körper) je getroffene Wand/Decke. */
  voidCuts?: VoidCuts;
}

const DETAIL_CODE: Record<string, number> = { grob: 0, mittel: 1, fein: 2 };

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
  return documentFor(project).query("pickGeometry");
}

/**
 * Baut die Highlight-Linien der aktuellen 3D-Auswahl (Wand-/Decken-Ids) als
 * flaches LineList-Vertex-Array `[px,py,pz,r,g,b, ...]` (world-Meter, je 2
 * Vertices = 1 Kante) — genau das Format, das `set_highlight_lines` erwartet
 * (immer obenauf gezeichnete Akzent-Umrisslinie, s. useWasm3dRenderer). Leere
 * Auswahl → leeres Array (Highlight löschen).
 *
 * Gerechnet im Kern (`src-tauri/core/src/highlight3d.rs`).
 *
 * GEOMETRIE (dieselbe Welt-Konvention wie pickGeometry/raycast3d: model (x,y)
 * → world (x, elevation, y), Höhe entlang +Y):
 *  • Wand: derselbe orientierte Quader wie `rayWallBox` (raycast3d.ts) — Achse
 *    entlang der Wandlänge, Normale (Dicke) senkrecht dazu in der XZ-Ebene,
 *    Y = Höhe. Aus den 8 Ecken werden die 12 Kanten des Quaders emittiert.
 *    Wände MIT Öffnungen bestehen aus mehreren Teilquadern (Pfeiler/Brüstung/
 *    Sturz, s. emitWalls) — alle tragen dieselbe `wallId` und werden hier ALLE
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
  const sel = { walls: wallIds, ceilings: ceilingIds, openings: openingIds, stairs: stairIds, roofs: roofIds, context: contextObjectIds };
  if (Object.values(sel).every((l) => l.length === 0)) return new Float32Array(0);
  // Gerechnet im Kern (`highlight3d.rs`); Antwort f32-LE.
  const b = documentFor(project).queryBin("selectionHighlight", [], JSON.stringify({ ...sel, rgb }));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
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
 * Minimal-Form eines Werkzeug-Drafts (`ToolDraft` der Hülle erfüllt sie strukturell): nur das,
 * was `draftWorldLines` liest. So hängt der Kern nicht an `tools/types`.
 */
export interface DraftLike {
  preview: Array<{ kind: "line"; a: Vec2; b: Vec2 } | { kind: "poly"; pts: Vec2[]; closed?: boolean }>;
  vertices: Vec2[];
  snap?: { point: Vec2; kind?: string; refA?: Vec2 } | null;
}

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
export function draftWorldLines(draft: DraftLike | null, planeY: number): Float32Array {
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
