// Schnitt aus dem Kern ([K3c]): die Abfrage `sectionPlan` (`src-tauri/core/src/plan/section.rs`) rechnet
// den Schnitt auf dem Projekt-Dokument — Prismen-Schnitt (render3d `cut_section`), Besitzer, Schicht-Bänder,
// Stil, Dominanz, Treppen, Abzugskörper, Gelände, Tiefe, geschnittene Fenster/Türen — und liefert den
// Plan-Puffer v2 samt Pick-Ids (lazy gelesen wie `generatePlan`). TS reicht nur die Ebene, die
// Sichtbarkeit (UI-Zustand) und die asynchron gebauten truck-Körper hinein. Einheiten: Meter; u entlang
// der Ebene (Blickrichtungs-RECHTS), v = absolute Höhe.

import type { DrawingLevel, Project, Vec2 } from "../model/types";
import { flattenCategories, getFloor } from "../model/types";
import { documentFor } from "../core/document";
import { buildSolidMesh } from "../engine/truckSolid";
import { extrudedSolidSpec } from "./extrudedSolidSpec";
import { decodePlanBuf } from "./planBuf";
import { lazyPlan } from "./planLazy";
import type { CategoryDisplayResolver, Plan } from "./generatePlan";

/** Vorbereitete Eingabe eines Schnitts: Projekt, Ebene und die truck-Körper (flach). */
export interface SectionOutput {
  project: Project;
  level: DrawingLevel;
  /** `[mono, openings, key, n, (index, nPos, pos…, nIdx, idx…) × n]`: Platz für die zwei Schalter, der
   *  Schlüssel dieses Schnitts (der Kern merkt sich die zuletzt berechneten, Umschalten von Darstellung
   *  oder Sichtbarkeit rechnet nicht neu), dann die geschnittenen freien Körper. */
  bodies: Float64Array;
}

/** Schlüssel der vorbereiteten Schnitte (s. `SectionOutput.bodies`). */
let sectionKey = 0;

/** Ob die Ebene eine gültige Schnittlinie trägt (wie `sectionPlaneFromLevel`). */
export function hasLine(level: DrawingLevel): boolean {
  const line = level.linePoints;
  if (!line) return false;
  return Math.hypot(line[1].x - line[0].x, line[1].y - line[0].y) >= 1e-9;
}

/** Ob ein Körper als Abzugskörper wirkt (s. `voids.ts`). */
function isVoid(s: NonNullable<Project["extrudedSolids"]>[number]): boolean {
  return s.operation === "subtract" && !s.brep && (s.taper ?? 0) < 1e-6 && s.points.length >= 3 && s.height > 0;
}

/**
 * Bereitet den Schnitt der Ebene vor: baut die Netze der freien Körper (truck, asynchron, mit
 * Cache). `null`, wenn die Ebene keine gültige Schnittlinie trägt.
 */
export async function computeSection(project: Project, level: DrawingLevel): Promise<SectionOutput | null> {
  if (!hasLine(level)) return null;
  const bodies: number[] = [0, 0, ++sectionKey, 0];
  const solids = project.extrudedSolids ?? [];
  for (let index = 0; index < solids.length; index++) {
    const solid = solids[index];
    if (solid.operation === "subtract" || isVoid(solid)) continue;
    let baseZ = 0;
    try {
      baseZ = solid.levelId ? (getFloor(project, solid.levelId).baseElevation ?? 0) : 0;
    } catch {
      baseZ = 0;
    }
    const spec = extrudedSolidSpec(solid, baseZ);
    if (!spec) continue;
    let mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> };
    try {
      mesh = await buildSolidMesh(spec, 0.01);
    } catch {
      continue; // Körper nicht baubar → im Schnitt weglassen, wie im 3D
    }
    bodies.push(index, mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i++) bodies.push(mesh.positions[i]);
    bodies.push(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i++) bodies.push(mesh.indices[i]);
    bodies[3]++;
  }
  return { project, level, bodies: Float64Array.from(bodies) };
}

/** Kategorie-Codes, die Schnitt/Ansicht prüfen. */
function candidateCodes(project: Project): Set<string> {
  const codes = new Set<string>();
  for (const c of flattenCategories(project.layers)) codes.add(c.code);
  for (const list of [project.walls, project.ceilings, project.roofs, project.stairs, project.openings]) {
    for (const e of list ?? []) codes.add(e.categoryCode);
  }
  for (const c of project.context ?? []) if (c.type === "terrainMesh" && c.categoryCode !== undefined) codes.add(c.categoryCode);
  return codes;
}

/** Sichtbarkeit (UI-Zustand) als Code-Listen für den Kern. */
export function visibilityArgs(project: Project, visibleCodes?: Set<string>, categoryDisplay?: CategoryDisplayResolver) {
  const invisible: string[] = [];
  const norender: string[] = [];
  const grey: string[] = [];
  for (const c of candidateCodes(project)) {
    if (visibleCodes && !visibleCodes.has(c)) invisible.push(c);
    if (categoryDisplay) {
      const d = categoryDisplay(c);
      if (!d.render) norender.push(c);
      if (d.greyed) grey.push(c);
    }
  }
  return { hasVis: !!visibleCodes, invisible, hasDisplay: !!categoryDisplay, norender, grey };
}

/** Ebene ohne fremde Felder für den Kern. */
export function levelArg(level: DrawingLevel) {
  return {
    kind: level.kind,
    linePoints: level.linePoints,
    directionSign: level.directionSign,
    depth: level.depth,
    shadows: level.shadows,
  };
}

/**
 * Plan eines Schnitts (Cut-Flächen mit Stil und Pick-Ids, Gelände, sichtbare/verdeckte Kanten,
 * Bodenlinie). `openings`: geschnittene Fenster/Türen anhängen (nicht im Ausmass).
 */
export function generateSectionPlan(
  output: SectionOutput,
  mono = false,
  opts: { hiddenLines?: boolean; visibleCodes?: Set<string>; categoryDisplay?: CategoryDisplayResolver; openings?: boolean } = {},
): Plan {
  const { project, level } = output;
  const text = JSON.stringify({
    level: levelArg(level),
    hiddenLines: !!opts.hiddenLines,
    ...visibilityArgs(project, opts.visibleCodes, opts.categoryDisplay),
  });
  const args = output.bodies.slice();
  args[0] = mono ? 1 : 0;
  args[1] = opts.openings ? 1 : 0;
  const buf = decodePlanBuf(documentFor(project).queryBin("sectionPlan", args, text));
  if (buf.groups.length === 0) return { primitives: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  const b = buf.bounds ?? [0, 0, 1, 1];
  return lazyPlan(
    { bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] } },
    buf.groups.map(([from, to]) => ({ buf, from, to })),
  );
}

/**
 * Eine Schnittebene in world-Koordinaten (Y-up): Punkt auf der Ebene +
 * Normale (= Blickrichtung, zeigt vom Betrachter ins Modell).
 */
export interface SectionPlaneSpec {
  point: [number, number, number];
  normal: [number, number, number];
}

/**
 * Leitet aus einer Schnitt-/Ansichtsebene die world-Schnittebene ab. Die
 * Grundriss-Schnittlinie `linePoints` [p0, p1] (Modell-Meter) liegt in der
 * XZ-Ebene (world.x = model.x, world.z = model.y); die Ebenennormale steht
 * senkrecht auf der Linie in der Horizontalen und wird über `directionSign`
 * (Voreinstellung +1) in die gewünschte Blickrichtung gedreht.
 *
 * Gibt `null` zurück, wenn die Ebene (noch) keine Schnittlinie trägt (z. B. eine
 * frisch angelegte Ansicht ohne gesetzte Linie) — der Aufrufer zeigt dann einen
 * Hinweis statt eines leeren Plans. Gegenstück im Kern: `LevelSpec::plane` (`plan/section.rs`).
 */
export function sectionPlaneFromLevel(level: DrawingLevel): SectionPlaneSpec | null {
  const line = level.linePoints;
  if (!line) return null;
  const [p0, p1] = line;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Links-Normale der Linie im Grundriss (n = (-u.y, u.x)), per directionSign
  // in die Blickrichtung gedreht. Modell (nx, ny) → world (nx, 0, ny).
  const sign = level.directionSign ?? 1;
  const nx = -uy * sign;
  const ny = ux * sign;
  return {
    point: [p0.x, 0, p0.y],
    normal: [nx, 0, ny],
  };
}

/**
 * Die in-plane-u-Weltrichtung der Schnittebene, projiziert in die Grundriss-
 * Ebene (Modell-2D: model.x = world.x, model.y = world.z).
 *
 * Muss EXAKT der u-Achse des Kern-Schnitts entsprechen (render3d `SectionPlane::u_axis`,
 * `core/src/plan/section.rs` `Plane::u_model`): dort `u = normalize(cross(up, normal))` mit up = (0,1,0) —
 * das Blickrichtungs-RECHTS des Betrachters (Entspiegelung; wer nach Norden
 * blickt, hat Osten rechts). Für eine horizontale Normale `[Nx, Ny, Nz]` sind
 * die Grundriss-Komponenten (x, z) also `(Nz, -Nx)`. (Nicht normiert; für das
 * Vorzeichen des Skalarprodukts irrelevant.)
 */
export function sectionUAxisModel(plane: SectionPlaneSpec): Vec2 {
  // Blickrichtungs-RECHTS (cross(up, N)) — muss EXAKT `SectionPlane::u_axis`
  // in section.rs spiegeln (dort seit der Entspiegelung dieselbe Formel).
  const [nx, , nz] = plane.normal;
  return { x: nz, y: -nx };
}

/**
 * Projekt-Felder, die den abgeleiteten Schnitt/die Ansicht NICHT beeinflussen.
 * Vor allem `drawings2d`: jede Linie, die man IM Schnitt zeichnet, landet dort —
 * ohne diesen Ausschluss rechnete jede solche Änderung den ganzen Schnitt neu.
 */
const SECTION_IRRELEVANT_KEYS = new Set<string>(["drawings2d", "layouts", "viewSnapshots", "masterLayouts"]);

/**
 * Ob zwei Projektstände denselben Schnitt/dieselbe Ansicht ergeben — Vergleich
 * je Feld per Referenz (das Projekt wird immutabel aktualisiert, unveränderte
 * Teile behalten ihre Identität), ohne {@link SECTION_IRRELEVANT_KEYS}. Bei
 * Unsicherheit `false` (dann wird eben neu gerechnet).
 */
export function sameSectionInputs(a: Project, b: Project): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (SECTION_IRRELEVANT_KEYS.has(k)) continue;
    if (ra[k] !== rb[k]) return false;
  }
  return true;
}

/** Ob zwei Stände einer Schnitt-/Ansichtsebene dieselbe Projektion ergeben. */
export function sameSectionLine(a: DrawingLevel, b: DrawingLevel): boolean {
  if (a === b) return true;
  const la = a.linePoints;
  const lb = b.linePoints;
  const sameLine =
    la === lb ||
    (!!la && !!lb &&
      la[0].x === lb[0].x && la[0].y === lb[0].y && la[1].x === lb[1].x && la[1].y === lb[1].y);
  return (
    sameLine &&
    a.id === b.id &&
    a.kind === b.kind &&
    (a.directionSign ?? 1) === (b.directionSign ?? 1) &&
    a.depth === b.depth &&
    !!a.shadows === !!b.shadows
  );
}
