// Schnitt und Ansicht aus dem Kern ([K3c]): die Abfragen `sectionPlan`/`elevationPlan`
// (`src-tauri/core/src/plan/{section,elevation}.rs`) liefern den Plan-Puffer v2 samt Pick-Ids;
// TS reicht nur die Ebene, die Sichtbarkeit (UI-Zustand) und — für den Schnitt — die
// asynchron gebauten truck-Körper hinein.

import type { DrawingLevel, Project } from "../model/types";
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
function hasLine(level: DrawingLevel): boolean {
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
function visibilityArgs(project: Project, visibleCodes?: Set<string>, categoryDisplay?: CategoryDisplayResolver) {
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
function levelArg(level: DrawingLevel) {
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

/** Optionen des Ansichts-Generators. */
export interface ElevationOptions {
  /** Schlagschatten zeichnen (Default aus `level.shadows`). */
  shadows?: boolean;
  /** Schwarz-Weiss-Modus (neutralisierte Füllungen). */
  mono?: boolean;
  /**
   * Ebenen-Panel-Sichtbarkeit: mit beiden Angaben werden Flächen ausgeblendeter Kategorien vor der
   * Verdeckung entfernt (sie verdecken dann auch nichts); ohne bleibt jede Fläche sichtbar.
   */
  visibleCodes?: Set<string>;
  categoryDisplay?: CategoryDisplayResolver;
}

/**
 * Ansichts-Plan einer Ebene (gefüllte Fassadenansicht, Painter fern → nah, Öffnungen, Schatten,
 * Bodenlinie). `null` ohne Ansichtslinie.
 */
export function generateElevationPlan(project: Project, level: DrawingLevel, opts: ElevationOptions = {}): Plan | null {
  if (!hasLine(level)) return null;
  const shadows = opts.shadows ?? level.shadows ?? false;
  const text = JSON.stringify({ level: levelArg(level), ...visibilityArgs(project, opts.visibleCodes, opts.categoryDisplay) });
  const buf = decodePlanBuf(documentFor(project).queryBin("elevationPlan", [opts.mono ? 1 : 0, shadows ? 1 : 0], text));
  if (buf.groups.length === 0) return null;
  const b = buf.bounds ?? [0, 0, 1, 1];
  return lazyPlan(
    { bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] } },
    buf.groups.map(([from, to]) => ({ buf, from, to })),
  );
}
