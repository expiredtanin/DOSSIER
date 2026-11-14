// Automatische Höhenkoten im Schnitt/in der Ansicht: je Geschoss die Kote
// OK fertig Boden (`baseElevation`, ±0.00 = Bezug) plus die oberste Kante des
// Gebäudes (First/OK Dach), links neben der Zeichnung mit einer kurzen
// Bezugslinie zur Geometrie. Symbol = dieselbe SIA-400-Kote wie das 2D-Element
// `kote`; gerechnet im Kern (`plan/drawings.rs::level_markers`, Abfrage `levelMarkers`).
// Abschaltbar je Ebene (`DrawingLevel.levelMarks`), über die Modelldarstellung ([173]) oder die Klasse
// „Höhenkoten" ([180]).

import type { DrawingLevel, Project } from "../model/types";
import type { Primitive } from "./generatePlan";
import { documentFor } from "../core/document";
import { decodePlanBuf } from "./planBuf";
import { derivedVisible, LEVEL_MARK_CATEGORY } from "../model/derivedCategories";
import {
  CONTEXT_PARENT_CATEGORY,
  EXCAVATION_CATEGORY,
  GENERIC_IMPORT_CATEGORY,
  GEO_CATEGORY_DEFS,
  IMAGE_CATEGORY,
  TERRAIN_CATEGORY,
} from "../model/contextCategories";

/**
 * Ob eine Ebene automatische Koten trägt: Ebene > [173] Modelldarstellung der Ebene (`dimensions.levelMarks`,
 * Rangfolge wie Kern `model_view::Options::level_marks`) > an.
 */
export function levelMarksEnabled(
  level: DrawingLevel,
  project?: Pick<Project, "modelViewOptions"> & Partial<Pick<Project, "layers">>,
  shown?: (code: string) => boolean,
): boolean {
  const mv = level.modelViewOptionId ? project?.modelViewOptions?.find((m) => m.id === level.modelViewOptionId) : undefined;
  const on = level.levelMarks ?? mv?.dimensions?.levelMarks ?? true;
  // [180] Die Koten liegen auf der Klasse „Höhenkoten": ausgeblendet ⇒ ohne (`shown`: sichtbar und gezeichnet).
  return on && (!shown || !project?.layers || derivedVisible(project.layers, LEVEL_MARK_CATEGORY, shown));
}

/**
 * Kote-Primitive für eine Zeichnung mit den Grenzen `bounds` (u, Höhe). Höhen
 * ausserhalb der Zeichnung (Geschosse, die der Schnitt nicht zeigt) entfallen.
 */
export function levelMarkerPrimitives(
  project: Project,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  primitives?: readonly Primitive[],
): Primitive[] {
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) return [];
  const minX = primitives ? Math.max(bounds.minX, builtMinX(project, primitives)) : bounds.minX;
  // [199] Oberste Kote = Oberkante des Gebauten: die Grenzen reichen sonst bis über die Achsblasen (Musterhaus
  // komplex: „+13.13" 1.4 m über dem First), über Bäume und Texte.
  const top = primitives ? Math.min(bounds.maxY, builtMaxY(project, primitives)) : bounds.maxY;
  const maxY = top > bounds.minY ? top : bounds.maxY;
  return decodePlanBuf(documentFor(project).queryBin("levelMarkers", [minX < bounds.maxX ? minX : bounds.minX, bounds.minY, bounds.maxX, maxY])).prims;
}

// [171] Gelände (Schnittfläche, Profil- und Grundlinie) zählt nicht zur Lage der Koten: sie stehen neben dem
// Gebauten (Haus, Carport, Körper), nicht links vom ganzen Geländeschnitt (Musterhaus komplex: ~15 m weiter).
const TERRAIN_CLS = new Set(["section-terrain", "elevation-terrain", "section-ground", "elevation-ground"]);

function siteIds(project: Project): Set<string> {
  return new Set((project.context ?? []).filter((c) => c.type === "terrainMesh" || c.type === "excavation" || c.type === "contourSet").map((c) => c.id));
}

// [256] Umgebungsklassen (Kern `import_context::is_context_class`): Netze darauf sind Nachbarn/Kataster, nicht das eigene Gebäude.
const CONTEXT_CLASSES = new Set([CONTEXT_PARENT_CATEGORY, TERRAIN_CATEGORY, IMAGE_CATEGORY, EXCAVATION_CATEGORY, GENERIC_IMPORT_CATEGORY, ...Object.values(GEO_CATEGORY_DEFS)].map((d) => d.code));

/**
 * [256] Nachbargebäude (wie Kern `drawings::level_marker_bounds`): Flächen der Kontext-Netze auf einer Umgebungsklasse und
 * Linien ganz in ihrem Ausmass (Umriss, Schnittkante) zählen nicht zum Gebauten.
 */
function neighbourFilter(project: Project, primitives: readonly Primitive[]): (q: Primitive) => boolean {
  const ids = new Set((project.context ?? []).filter((c) => c.type === "importedMesh" && CONTEXT_CLASSES.has(c.categoryCode)).map((c) => c.id));
  if (ids.size === 0) return () => false;
  const boxes: [number, number, number, number][] = [];
  for (const q of primitives) {
    if (q.kind === "polygon" && q.contextObjectId && ids.has(q.contextObjectId)) {
      const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const v of q.pts) [b[0], b[1], b[2], b[3]] = [Math.min(b[0], v.x), Math.min(b[1], v.y), Math.max(b[2], v.x), Math.max(b[3], v.y)];
      boxes.push(b);
    }
  }
  const inBox = (v: { x: number; y: number }) => boxes.some((b) => v.x >= b[0] - 1e-6 && v.x <= b[2] + 1e-6 && v.y >= b[1] - 1e-6 && v.y <= b[3] + 1e-6);
  return (q) => (q.kind === "polygon" ? !!q.contextObjectId && ids.has(q.contextObjectId) : q.kind === "line" && inBox(q.a) && inBox(q.b));
}

function builtMinX(project: Project, primitives: readonly Primitive[]): number {
  const site = siteIds(project);
  const neighbour = neighbourFilter(project, primitives);
  let minX = Infinity;
  for (const q of primitives) {
    if (neighbour(q)) continue;
    if (q.kind === "line") {
      if (!TERRAIN_CLS.has(q.cls)) minX = Math.min(minX, q.a.x, q.b.x);
    } else if (q.kind === "polygon") {
      if (!(q.contextObjectId && site.has(q.contextObjectId))) for (const v of q.pts) minX = Math.min(minX, v.x);
    }
  }
  return minX;
}

// [199] Achsraster (Linien „draw2d", Blasen, Beschriftungen) und Bäume zählen nicht zur Oberkante.
const NOT_BUILT_TOP = new Set([...TERRAIN_CLS, "draw2d", "tree-crown", "tree-remove"]);
const TREE_PICK_PREFIX = "@tree:"; // Kern `tree::TREE_PICK_PREFIX`

function builtMaxY(project: Project, primitives: readonly Primitive[]): number {
  const site = siteIds(project);
  const neighbour = neighbourFilter(project, primitives);
  let maxY = -Infinity;
  for (const q of primitives) {
    if (neighbour(q)) continue;
    if (q.kind === "line") {
      if (!NOT_BUILT_TOP.has(q.cls)) maxY = Math.max(maxY, q.a.y, q.b.y);
    } else if (q.kind === "polygon") {
      const id = q.contextObjectId;
      if (!(id && (site.has(id) || id.startsWith(TREE_PICK_PREFIX)))) for (const v of q.pts) maxY = Math.max(maxY, v.y);
    }
  }
  return maxY;
}
