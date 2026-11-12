// Griff-Geometrie der Bauteile ([K4] S3): dünne Fassade über den Rust-Kern (`src-tauri/core/src/grips.rs`,
// Bindungen `web/grips.rs`). Die Griff-Änderungen selbst (Eckpunkt/Kante ziehen, verschieben, Grösse,
// Decke/Dach/Treppe/Raum, Polylinien-Punkte, Dicken) rechnet der Kern auf dem Dokument und wendet sie
// gleich an (`ProjectDocument.commitGrip`, Anfrage {@link GripRequest}); hier stehen die Griff-Listen
// für die Anzeige (`drawingVertices`, Kanten-Griffe).
//
// Bewusst TS: die Rahmen-Ecken einer Textspalte (`textFrameCorners` braucht die Schrift-Metrik der
// Hülle) — der Kern meldet dafür nur „Textspalte".

import type { Ceiling, Drawing2D, Drawing2DGeom, EdgeGrip, Project, Vec2, Wall } from "../model/types";
import { documentFor } from "../core/document";
import { core } from "../engine/coreWasm";
import { toMarkedJson } from "../core/ops";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import { textFrameCorners } from "../text/textFrame";
import type { SheetHeightKind } from "./gripDrag";

/** Punkt als `[x, y]` (Anfragen an den Kern). */
type P = [number, number];

/** Elemente mit Umriss-Ring, an denen sich Ecken einfügen/löschen lassen (geschlossene Polylinie eingeschlossen). */
export type RingKind = "roof" | "ceiling" | "room" | "excavation" | "polyline" | "contours";

/** Eine Griff-Änderung für den Kern (`grips.rs::run`); Zahlen dürfen NaN/±∞ sein (Marken). */
export type GripRequest =
  | { op: "moveGrip"; drawingId: string | null; wallId: string | null; index: number; pt: P; scale: number; free?: boolean; arcLength?: number }
  | { op: "moveBy"; drawingId: string | null; wallId: string | null; delta: P }
  | { op: "moveEdge"; drawingId: string | null; wallId: string | null; a: number; b: number; delta: P }
  | { op: "resize"; kind: string; id: string; w: number; h: number; fx: number; fy: number }
  | { op: "ceilingGrip" | "roomGrip" | "roofGrip"; id: string; index: number; pt: P }
  | { op: "ceilingBy" | "roofBy" | "stairBy" | "roomBy"; id: string; delta: P }
  // [140] Stempel: `pt` = gezeichnete Lage (Basis, solange der Raum keinen eigenen Anker hat; fehlt = Pol).
  | { op: "roomStamp"; id: string; delta: P; pt?: P }
  | { op: "ceilingEdge" | "roomEdge"; id: string; a: number; b: number; delta: P }
  | { op: "excavationGrip"; id: string; index: number; pt: P }
  // [193] Höhenlinien-Satz: Punkt (flacher Index über alle Linien) ziehen bzw. hinter Punkt `seg` einfügen (Kern `contour_edit`).
  | { op: "contourGrip"; id: string; index: number; pt: P }
  | { op: "contourInsert"; id: string; seg: number; pt: P }
  // [193] Gelände-Netz: Netzpunkt (Vertex-Nummer) im Grundriss verschieben (Kern `mesh_grip`).
  | { op: "meshGrip"; id: string; index: number; pt: P }
  // [26] Dach: Ecke bzw. Kante von Umriss/Hof, flacher Index (erst `outline`, dann `holes` Ring für Ring).
  | { op: "roofVertex"; id: string; index: number; pt: P }
  | { op: "roofEdge"; id: string; a: number; b: number; delta: P }
  // [176] Schnittlinie: 0 = Anfang, dann `bendPoints`, zuletzt das Ende.
  | { op: "sectionLineGrip"; id: string; index: number; pt: P }
  | { op: "sectionBendInsert"; id: string; seg: number; pt: P }
  | { op: "sectionBendDelete"; id: string; index: number }
  | { op: "sectionLineTidy"; id: string; tol?: number }
  // [26] Ecke an Umriss-Ringen einfügen (hinter Kante `seg`), löschen, aufräumen (Kern `ring_edit`); Dach: flacher Index.
  | { op: "ringInsert"; kind: RingKind; id: string; seg: number; pt: P }
  | { op: "ringDelete"; kind: RingKind; id: string; index: number }
  | { op: "ringTidy"; kind: RingKind; id: string; index: number; tol?: number }
  // [191] Bogen-Scheitel einer Umriss-Kante (Decke, Raum, Dach samt Höfen; `seg` wie bei `ringInsert`).
  | { op: "ringArc"; kind: "roof" | "ceiling" | "room"; id: string; seg: number; pt: P }
  // [151] Parameter-Griff einer Podesttreppe (Kern `grip_drag::stair_param_drag`).
  | { op: "stairParam"; id: string; index: number; pt: P }
  | { op: "excavationEdge"; id: string; a: number; b: number; delta: P }
  | { op: "insertPoint"; id: string; seg: number; pt: P }
  | { op: "deletePoint"; id: string; index: number }
  | { op: "vertexType"; id: string; index: number; vertexType: "corner" | "arc" | "spline" }
  // [187] Höhen-Griff im Schnitt/in der Ansicht: Kante `kind` auf die Blatt-Höhe `a` (absolutes Z) ziehen (Kern `sheet_height.rs`).
  | { op: "sheetHeight"; kind: SheetHeightKind; id: string; a: number; b?: number; index?: number; free?: boolean; newId: string; newName: string }
  | { op: "wallThickness" | "ceilingThickness"; id: string; thickness: number; newId: string; newName: string }
  // [144] Wandöffnung gleiten lassen (Kern `opening_slide`): Griff-Zug nach `pt` bzw. Position `a` ab Wandanfang.
  | { op: "openingSlide"; id: string; pt: P }
  | { op: "openingPosition"; id: string; a: number };

/** Punkt als Anfrage-Paar. */
export const gripPt = (p: Vec2): P => [p.x, p.y];

/**
 * Editier-Griffe (Eckpunkte) eines 2D-Zeichenelements in Modell-Metern — dieselbe Reihenfolge, in der
 * der Kern einen Griff-Index auflöst (`moveGrip`). line/polyline/rect: Eckpunkte (Polylinie zusätzlich je
 * Segment ein Bogen-Mitten-Griff); Kreis Ost/Nord; Bogen Start/Ende/Mitte; Ellipse je Halbachse;
 * Bemassung Kettenpunkte · Masslinie · je Segment die Masszahl (`scaleDenominator`: Papier-Massstab, die
 * Masszahl-Lage hängt an der Schrifthöhe in Papier-mm); Text Anker · Knicke · Spitze, Pfadpunkte oder
 * die vier Rahmen-Ecken einer Textspalte.
 */
export function drawingVertices(d: Drawing2D, scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR): Vec2[] {
  const g = d.geom;
  if (g.shape === "polyline") {
    // Flach (Kataster-Umrisse mit tausenden Punkten): ein fehlender/null-Bogen ist gerade.
    const f = core().grip_vertices_polyline(flat(g.pts), Float64Array.from(g.bulge ?? []), !!g.closed);
    const out: Vec2[] = new Array(f.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = { x: f[2 * i], y: f[2 * i + 1] };
    return out;
  }
  // NaN/±∞ als Marken (JSON hätte null daraus gemacht, das rechnet wie 0).
  const f = core().grip_vertices(toMarkedJson(g), scaleDenominator);
  if (f[0] === -1 && g.shape === "text") {
    // [37] Papiergrösse: Schrifthöhe in mm auf dem Blatt → Modellmeter im aktuellen Massstab.
    const heightM = g.paperHeight && g.paperHeight > 0 ? (g.paperHeight / 1000) * scaleDenominator : g.height;
    return textFrameCorners({ at: g.at, text: g.text, heightM, angle: g.angle, marks: g.marks, doc: g.doc, wrapWidth: g.width });
  }
  const n = f[0] ?? 0;
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: f[1 + 2 * i], y: f[2 + 2 * i] };
  return out;
}

type Owner = { drawingId?: string; wallId?: string };

function flat(verts: readonly Vec2[]): Float64Array {
  const f = new Float64Array(verts.length * 2);
  for (let i = 0; i < verts.length; i++) {
    f[2 * i] = verts[i].x;
    f[2 * i + 1] = verts[i].y;
  }
  return f;
}

function edges(verts: readonly Vec2[], closed: boolean, bulge: readonly number[] | null, owner: Owner): EdgeGrip[] {
  const f = core().edge_grips(flat(verts), closed, Float64Array.from(bulge ?? []), bulge !== null);
  const out: EdgeGrip[] = [];
  for (let i = 0; i + 5 < f.length; i += 6) {
    const e: EdgeGrip = { mid: { x: f[i + 2], y: f[i + 3] }, normal: { x: f[i + 4], y: f[i + 5] }, aIndex: f[i], bIndex: f[i + 1] };
    if (!closed) e.free = true;
    e.owner = owner;
    out.push(e);
  }
  return out;
}

/**
 * Geschlossener Ring → Kanten-Griffe mit Aussennormale (vom Eckpunkt-Mittel weg), inkl. Schlusskante.
 * [191] `bulge` (je Kante): Bogenkanten haben keinen Kanten-Griff (sie haben ihren Scheitel-Griff).
 */
export function ringEdges(verts: readonly Vec2[], owner: Owner, bulge?: readonly number[]): EdgeGrip[] {
  return edges(verts, true, bulge ?? null, owner);
}

/** [191] Scheitel (Bogenmitte) der Kante a → b mit `bulge`; gerade: Kantenmitte. */
export function arcApex(a: Vec2, b: Vec2, bulge: number | undefined): Vec2 {
  const k = Number.isFinite(bulge) ? (bulge as number) / 2 : 0;
  return { x: (a.x + b.x) / 2 - (b.y - a.y) * k, y: (a.y + b.y) / 2 + (b.x - a.x) * k };
}

/**
 * Offene Kette (Linie/offene Polylinie) → ein Griff je Segment, OHNE Schlusskante. `normal` dient nur
 * der Darstellung (linke Normale der Kante); die Bewegung ist frei (`free: true`).
 */
export function openEdges(verts: readonly Vec2[], owner: Owner): EdgeGrip[] {
  return edges(verts, false, null, owner);
}

/**
 * Kanten-Griffe einer Polylinie: nur über die Eckpunkte und nur an geraden Segmenten — ein Bogen hat
 * seinen Bogen-Mitten-Griff (`drawingVertices`), die Sehnen-Mitte läge neben der Linie.
 */
export function polylineEdgeGrips(g: Extract<Drawing2DGeom, { shape: "polyline" }>, owner: Owner): EdgeGrip[] {
  return edges(g.pts, !!g.closed, g.bulge ?? [], owner);
}

/** Unter-/Oberkante (absolutes Z, Meter) eines Bauteils. */
export interface VerticalExtent {
  zBottom: number;
  zTop: number;
}

/**
 * UK/OK von Wänden und Decken aus dem Kern (`selection_info.rs::vertical_extents`, Regeln
 * `model/helpers.rs::heights`): Geschoss-Bindungen und Deckentypen aus `project`, die
 * Elemente selbst als ganze Fassung (auch gerade gezogene, noch nicht übernommene — 3D-Griffe).
 */
export function verticalExtents(
  project: Project,
  walls: readonly Wall[],
  ceilings: readonly Ceiling[] = [],
): { walls: VerticalExtent[]; ceilings: VerticalExtent[] } {
  if (walls.length === 0 && ceilings.length === 0) return { walls: [], ceilings: [] };
  const f = documentFor(project).queryRootMarked<number[]>("verticalExtents", toMarkedJson({ walls, ceilings }));
  const at = (i: number): VerticalExtent => ({ zBottom: f[2 * i], zTop: f[2 * i + 1] });
  return { walls: walls.map((_, i) => at(i)), ceilings: ceilings.map((_, i) => at(walls.length + i)) };
}
