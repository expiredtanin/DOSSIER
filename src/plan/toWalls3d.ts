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
// freie Körper, freie 2D-Geometrie) rechnet der Kern (`src-tauri/core/src/model3d/`);
// `toWalls3d/` hält nur noch das gemeinsame Vokabular und die Abzugskörper-Netze.

import type { Project, Vec2 } from "../model/types";
import { collectVisibleCodes, flattenCategories } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";
import { documentFor } from "../core/document";
import { coreEpoch } from "../engine/coreWasm";
import type { PickOpening, PickRoof, PickStair, PickContextMesh, PickColumnMesh, PickSolidMesh, PickOpeningMesh, PickDrawingSeg, PickStairMesh, PickDrawingMesh, PickTreeMesh } from "./pickTypes";
import {
  type RMesh,
  type RModel3d,
  type RRgb,
  type RSlab,
  type RVec2,
  type RWall,
} from "./toWalls3d/shared";
import { applyVoidMeshes, type VoidMeshes } from "./toWalls3d/voids3d";

// Re-Export des gemeinsamen Vokabulars — externe Konsumenten (viewport/,
// export/, toSection.ts, nativeSync.ts, …) importieren weiterhin
// ausschliesslich von hier, unverändert zur Zeit vor dem Domänen-Split.
export type { RVec2, RRgb, RWall, RSlab, RModel3d };

/**
 * Boden-Spuren aller 2D-Zeichnungen (Linie, Polylinie, Rechteck) als LineList-Vertices
 * `[px, py, pz, r, g, b]` in Welt-Metern für render3d (`set_drawing_lines`, Binärkanal — ein
 * Kataster-DXF kann Millionen Segmente liefern, als JSON-Mesh sprengte das Speicher und
 * String-Länge). Rechnet der Kern (`model3d/drawings.rs`, Chargen).
 */
export function emitDrawingLineVerts(
  project: Project,
  /** Explosionsabstand ([65]): Spuren heben sich mit ihrem Geschoss; 0 = aus. */
  explode = 0,
  /** [180] Zusätzlich ausgeblendete Klassen (Darstellungsmodus), s. {@link Model3dOptions.hide}. */
  hide?: readonly string[],
): Float32Array {
  return documentFor(project).drawingLineVerts(explodeGap(explode), classFilterText(hide));
}

/**
 * [180] Klassen-Filter der 3D-Abfragen (Kern `model3d::ClassFilter`): der Kern blendet die Klassen aus, die im
 * Ebenen-Baum aus sind (Ebenen-Panel, Kombinationen, Vorlagen); `hide` ergänzt die, die der Darstellungsmodus
 * nicht zeichnet (`categoryDisplay(code).render === false`).
 */
export function classFilterText(hide?: readonly string[], extra?: Record<string, unknown>): string {
  const h = hide && hide.length ? { hide } : {};
  return hide?.length || extra ? JSON.stringify({ ...extra, ...h }) : "";
}

/**
 * [180] Ausgeblendete Klassen-Codes (Ebenen-Baum samt Elternklassen, dazu `hide`) — für die 3D-Zutaten, die
 * nicht aus dem Kern-Modell kommen (Schatten, Baurechts-Hülle); die Teile filtert der Kern.
 */
export function hiddenClassCodes(project: Project, hide?: readonly string[]): Set<string> {
  const out = new Set(hide ?? []);
  const visible = collectVisibleCodes(project.layers ?? []);
  for (const c of flattenCategories(project.layers ?? [])) if (!visible.has(c.code)) out.add(c.code);
  return out;
}

/**
 * Explosionsaxonometrie ([65]): Versatz (m) je Geschoss-id (Kern `explode3d.rs::floor_offsets`),
 * für 3D-Griffe und Arbeitsebene. Abstand ≤ 0 → leer (= nirgends Versatz).
 */
export function explodeFloorOffsets(project: Project, explode: number): Record<string, number> {
  const gap = explodeGap(explode);
  return gap === 0 ? {} : documentFor(project).query<Record<string, number>>("explodeOffsets", [gap]);
}

/**
 * Ansichtsschraffur ([100]) auf den Flächen als Linien für render3d (`set_pattern_lines`): je Linie
 * `ax ay az bx by bz r g b maske` (Welt-Meter); die Maske wählt die Ausdünnung nach Abstand.
 */
export function emitSurfacePatternLines(
  project: Project,
  /** Explosionsabstand ([65]): Linien heben sich mit dem Geschoss ihres Bauteils; 0 = aus. */
  explode = 0,
  /** [180] Zusätzlich ausgeblendete Klassen, s. {@link Model3dOptions.hide}. */
  hide?: readonly string[],
): Float32Array {
  return documentFor(project).surfacePatternLines(explodeGap(explode), classFilterText(hide));
}

/**
 * Nur die Wände (Rückwärts-Kompatibilität / bestehende Aufrufer). Zerlegt Wände mit Öffnungen in
 * Teilquader bzw. (layered) in Schicht-Bänder. Rechnet der Kern auf dem Projekt-Dokument
 * (`model3d/`: Verschneidung je Geschoss, Bänder, Öffnungen, Decken-/Dach-Dominanz).
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
   * 3D-Viewer: Abzugskörper von Wänden/Decken abziehen (Kern-Netze über Manifold, s.
   * `toWalls3d/voids3d.ts`). Schnitt/Ansicht/Export behandeln Abzugskörper selbst.
   */
  voids?: boolean;
  /**
   * Explosionsaxonometrie ([65]): Abstand (m) zwischen den Geschossen; 0/fehlt = aus. Jedes
   * Geschoss hebt sich um Index × Abstand (Kern `explode3d.rs`); Kontext bleibt stehen,
   * Abzugskörper wandern mit dem getroffenen Bauteil.
   */
  explode?: number;
  /**
   * [173] Modelldarstellung (Id, eingebaut oder `Project.modelViewOptions`): ihre Basis bestimmt das
   * Öffnungsdetail, „Handlauf aus" lässt die Handläufe weg. Rechnet ohne den inkrementellen Kern-Cache.
   */
  modelView?: string;
  /**
   * [180] Klassen, die zusätzlich zum Ebenen-Baum nicht gezeichnet werden (Darstellungsmodus des Ebenen-Panels).
   * Ausgeblendete Klassen fehlen im Modell, in der Pick-Geometrie und im Export der Ansicht (Kern filtert nach dem
   * Cache, Umschalten rechnet keine Wand neu).
   */
  hide?: readonly string[];
}

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten + Kontext-Meshes. */
export function projectToModel3d(project: Project, opts: Model3dOptions = {}): RModel3d {
  const layered = opts.layeredWalls ?? true;
  const detail = opts.detail ?? "fein";
  // Mit `voids` liefert der Kern zusätzlich die getroffenen Wände/Decken als Netze „Bauteil − Körper".
  const explode = explodeGap(opts.explode);
  const voids = !!opts.voids;
  const args = [layered ? 1 : 0, DETAIL_CODE[detail] ?? 3, opts.forSection ? 1 : 0, voids ? 1 : 0, explode];
  // Ohne Explosion inkrementell ([58]): nur geänderte Wände reisen aus dem Kern und werden gelesen.
  const doc = documentFor(project);
  const text = classFilterText(opts.hide, opts.modelView ? { modelView: opts.modelView } : undefined);
  const parts = opts.modelView || explode > 0 ? doc.query<Model3dParts>("model3dParts", args, text) : doc.model3dParts<Model3dParts>(args, text);
  // [115] Freie Körper als Kern-Netze (`model3d/solids.rs`) zwischen Kontext-Meshes und Stützen.
  const meshes: RMesh[] = [...parts.contextMeshes];
  for (const m of parts.solidMeshes) meshes.push(m);
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
  if (parts.voidMeshes) applyVoidMeshes(model, parts.voidMeshes);
  return model;
}

/**
 * Ein Teil des 3D-Modells für Teil-Updates im Viewer ([58], render3d `set_parts`). `fixed`: der Inhalt
 * zur `id` ändert sich nie (Wand-/Öffnungs-Eintrag des Kern-Caches, Laufnummer in der id) — der Viewer
 * schickt ihn nur einmal; sonst entscheidet der Inhalt (Rest-Gruppen: Decken, Dächer, Kontext …).
 */
export interface Model3dPart {
  id: string;
  fixed: boolean;
  walls?: RWall[];
  slabs?: RSlab[];
  meshes?: RMesh[];
  roofLayers?: RModel3d["roofLayers"];
}

/**
 * Das 3D-Modell wie {@link projectToModel3d} (gleiche Wände, Decken, Meshes — nur anders gruppiert), aber
 * in Teilen ([58]): je Wand-Eintrag des Kern-Caches (`w…`) und je Öffnungs-Eintrag (`o…`) ein
 * unveränderlicher Teil, dazu Rest-Gruppen. `null` mit Explosion (dort kein Cache): dann das ganze Modell.
 */
export function projectToModel3dParts(project: Project, opts: Model3dOptions = {}): Model3dPart[] | null {
  const layered = opts.layeredWalls ?? true;
  const detail = opts.detail ?? "fein";
  if (explodeGap(opts.explode) > 0) return null;
  const voids = !!opts.voids;
  const args = [layered ? 1 : 0, DETAIL_CODE[detail] ?? 3, opts.forSection ? 1 : 0, voids ? 1 : 0, 0];
  const { parts, keyed } = documentFor(project).model3dPartsKeyed<Model3dParts>(args, classFilterText(opts.hide));
  const wallEntries = keyed.wallEntries as (readonly [number, RWall[]])[];
  const openingEntries = keyed.openingEntries as (readonly [number, RMesh[][]])[];
  // Abzugskörper ([115], Kern-Netze): Wand/Decke durch ihr Netz ersetzen; der Inhalts-Schlüssel geht in die Teil-id.
  const wallMesh = new Map((parts.voidMeshes?.walls ?? []).map(([i, key, m]) => [i, [key, m] as const]));
  const slabCut = new Set((parts.voidMeshes?.slabs ?? []).map(([i]) => i));
  const slabMeshes = (parts.voidMeshes?.slabs ?? []).map(([, , m]) => m);
  const slabs = slabCut.size ? parts.slabs.filter((_, i) => !slabCut.has(i)) : parts.slabs;
  const ns = `${coreEpoch()}.`;
  const out: Model3dPart[] = [];
  let at = 0;
  for (const [k, ws] of wallEntries) {
    const start = at;
    at += ws.length;
    let cut = "";
    const walls: RWall[] = [];
    const meshes: RMesh[] = [];
    for (let i = start; i < at; i++) {
      const m = wallMesh.get(i);
      if (m) {
        meshes.push(m[1]);
        cut += `.${i - start}m${m[0]}`;
      } else walls.push(parts.walls[i]);
    }
    out.push(cut ? { id: `w${ns}${k}${cut}`, fixed: true, walls, meshes } : { id: `w${ns}${k}`, fixed: true, walls });
  }
  for (const [k, lists] of openingEntries) {
    const meshes = lists.flat();
    if (meshes.length) out.push({ id: `o${ns}${k}`, fixed: true, meshes });
  }
  const rest = (id: string, p: Omit<Model3dPart, "id" | "fixed">) => out.push({ id, fixed: false, ...p });
  rest("slabs", { slabs, meshes: slabMeshes });
  rest("context", { meshes: parts.contextMeshes });
  rest("solids", { meshes: parts.solidMeshes });
  rest("columns", { meshes: parts.columnMeshes });
  rest("openingTail", { meshes: keyed.openingTail as RMesh[] });
  rest("stairs", { meshes: [...parts.stairMeshes, ...parts.stairRailings] });
  rest("roofs", { meshes: parts.roofMeshes, roofLayers: parts.roofLayers });
  return out;
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
  /** [115] Freie Körper (ohne Abzugskörper) als Kern-Netze, Klassen gefiltert, mit der Explosion angehoben. */
  solidMeshes: RMesh[];
  /** Nur mit Abzugskörpern: (Index im Modell, Schlüssel, Netz „Bauteil − Körper") je getroffene Wand/Decke. */
  voidMeshes?: VoidMeshes;
}

/** Explosionsabstand bereinigt: endlich und > 0, sonst 0 (= aus). */
function explodeGap(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
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
  /** Explosionsabstand ([65]) wie bei {@link projectToModel3d}; 0 = aus. */
  explode = 0,
  /** [180] Zusätzlich ausgeblendete Klassen (nicht anwählbar), s. {@link Model3dOptions.hide}. */
  hide?: readonly string[],
): {
  walls: RWall[];
  slabs: RSlab[];
  openings: PickOpening[];
  stairs: PickStair[];
  roofs: PickRoof[];
  contextMeshes: PickContextMesh[];
  columns: PickColumnMesh[];
  solids: PickSolidMesh[];
  openingMeshes: PickOpeningMesh[];
  drawings: PickDrawingSeg[];
  stairMeshes: PickStairMesh[];
  drawingMeshes: PickDrawingMesh[];
  /** [149] Bäume (Stamm + Krone). */
  trees: PickTreeMesh[];
} {
  // [137]/[115] Freie Körper als Dreiecke ihres Kern-Netzes (dasselbe wie im Bild, mit der Explosion angehoben).
  return documentFor(project).query("pickGeometry", [explodeGap(explode)], classFilterText(hide)) as ReturnType<typeof pickGeometry>;
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
  /** Explosionsabstand ([65]); 0 = aus. */
  explode = 0,
  /** [137] Stützen und freie Körper (Prisma-Umriss). */
  columnIds: string[] = [],
  solidIds: string[] = [],
  /** [149] Bäume (Kronen-Zylinder vom Fuss bis zur Spitze). */
  treeIds: string[] = [],
): Float32Array {
  const sel = { walls: wallIds, ceilings: ceilingIds, openings: openingIds, stairs: stairIds, roofs: roofIds, context: contextObjectIds, columns: columnIds, solids: solidIds, trees: treeIds };
  if (Object.values(sel).every((l) => l.length === 0)) return new Float32Array(0);
  // Gerechnet im Kern (`highlight3d.rs`); Antwort f32-LE.
  const b = documentFor(project).queryBin("selectionHighlight", [], JSON.stringify({ ...sel, rgb, explode: explodeGap(explode) }));
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
