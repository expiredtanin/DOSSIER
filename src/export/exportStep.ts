// STEP-Export (ISO 10303-42 B-Rep) des Gebäudemodells über truck (trucksolid-WASM).
//
// Reiner Kern: `projectSolidSpecs(project)` liefert die Körper als {@link SolidSpec}
// (kein WASM, testbar), `exportProjectStep` serialisiert sie über truck-stepio.
//
//  • Wände: je Materiallage ein Körper. Das Wandprofil (Achse × Höhe) wird mit den
//    Öffnungen als Löcher bzw. Kerben (Türen am Wandfuss) in der Wandebene gebildet und
//    um die Lagendicke extrudiert — OHNE Boolean (B-Rep-Booleans scheitern an den
//    bündigen Laibungsflächen). Gehrungen/Anschlüsse stecken schon in `start`/`end`.
//  • Decken + Treppentritte: Umriss-Prisma zwischen `zBottom` und `zTop`.
//  • Dächer: je Dachfläche eine Platte der Gesamt-Schichtdicke (nach unten).
//  • Extrusionen: Prisma bzw. verjüngter Körper (Loft) des Profils.
//
// Koordinaten: Modell-Meter, X/Y = Grundriss, Z = Höhe (wie die Eingabe von render3d).

import type { Project } from "../model/types";
import { getFloor, roofLayers } from "../model/types";
import { projectToModel3d } from "../plan/toWalls3d";
import type { RWall } from "../plan/toWalls3d";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { exportStepSolids } from "../engine/truckSolid";
import { extrudedSolidSpec } from "../plan/extrudedSolidSpec";
import type { SolidSpec } from "../engine/truckSolid";

const EPS = 1e-6;
/** Schicht/Öffnung so dünn, dass sie als nicht vorhanden gilt. */
const MIN_THICKNESS = 1e-4;

/**
 * Wandprofil (u = Achse, v = Höhe über Wandfuss) mit Öffnungen: Löcher, die ganz im Profil
 * liegen; Öffnungen am Wandfuss (Türen) als Kerben im Aussenring. Öffnungen am Wandkopf
 * werden um 1 mm gekappt (ein Loch darf den Rand nicht berühren).
 */
export function wallProfile(
  length: number,
  height: number,
  holes: Array<{ from: number; to: number; zBottom: number; zTop: number }>,
  baseElevation: number,
): { outer: number[]; holes: number[][] } {
  const inner: number[][] = [];
  const notches: Array<[number, number, number]> = []; // [from, to, top]
  const cut = 1e-3;
  for (const h of holes) {
    const u0 = Math.max(0, Math.min(length, h.from));
    const u1 = Math.max(0, Math.min(length, h.to));
    if (u1 - u0 < MIN_THICKNESS) continue;
    const v0 = h.zBottom - baseElevation;
    const v1 = Math.min(height - cut, h.zTop - baseElevation);
    if (v1 - Math.max(v0, 0) < MIN_THICKNESS) continue;
    if (v0 <= cut) notches.push([u0, u1, v1]);
    else inner.push([u0, v0, u1, v0, u1, v1, u0, v1]);
  }
  // Kerben sortieren und überlappende zusammenfassen.
  notches.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number, number]> = [];
  for (const n of notches) {
    const last = merged[merged.length - 1];
    if (last && n[0] <= last[1] + EPS) {
      last[1] = Math.max(last[1], n[1]);
      last[2] = Math.max(last[2], n[2]);
    } else merged.push([...n]);
  }
  // Aussenring CCW in (u,v): Wandfuss links→rechts mit Kerben, dann Kopf rechts→links.
  const outer: number[] = [0, 0];
  for (const [a, b, top] of merged) {
    outer.push(a, 0, a, top, b, top, b, 0);
  }
  outer.push(length, 0, length, height, 0, height);
  return { outer, holes: inner };
}

function wallSpec(w: RWall): SolidSpec | null {
  const dx = w.end[0] - w.start[0];
  const dy = w.end[1] - w.start[1];
  const len = Math.hypot(dx, dy);
  if (len < MIN_THICKNESS || w.height < MIN_THICKNESS || w.thickness < MIN_THICKNESS) return null;
  const ux = dx / len;
  const uy = dy / len;
  // u × v (v = +Z) = (uy, −ux, 0): Extrusionsrichtung. Ursprung = eine Wandfläche.
  const nx = uy;
  const ny = -ux;
  const prof = wallProfile(len, w.height, w.holes ?? [], w.baseElevation);
  return {
    kind: "extrudePlane",
    points: prof.outer,
    holes: prof.holes,
    origin: [
      w.start[0] - (nx * w.thickness) / 2,
      w.start[1] - (ny * w.thickness) / 2,
      w.baseElevation,
    ],
    uAxis: [ux, uy, 0],
    vAxis: [0, 0, 1],
    depth: w.thickness,
  };
}

/** Alle Bauteile des Projekts als B-Rep-Spezifikationen (reiner Kern, kein WASM). */
export function projectSolidSpecs(project: Project): SolidSpec[] {
  const out: SolidSpec[] = [];
  const model = projectToModel3d(project, { layeredWalls: true });

  for (const w of model.walls) {
    const s = wallSpec(w);
    if (s) out.push(s);
  }

  for (const s of model.slabs) {
    if (s.outline.length < 3 || s.zTop - s.zBottom < MIN_THICKNESS) continue;
    out.push({
      kind: "extrude",
      points: s.outline.flatMap((p) => [p[0], p[1]]),
      height: s.zTop - s.zBottom,
      z0: s.zBottom,
    });
  }

  for (const roof of project.roofs ?? []) {
    const total = roofLayers(project, roof).reduce((sum, l) => sum + Math.max(0, l.thickness), 0);
    if (total < MIN_THICKNESS) continue;
    const g = roofGeometry(roof, roofBaseElevation(project, roof));
    for (const pl of g.planes) {
      const p = pl.pts;
      if (p.length < 3) continue;
      // Lokales Koordinatensystem der (ebenen, konvexen) Dachfläche.
      const e1 = sub(p[1], p[0]);
      const e2 = sub(p[2], p[0]);
      let n = cross(e1, e2);
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl < EPS) continue;
      n = [n[0] / nl, n[1] / nl, n[2] / nl];
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]]; // Normale nach oben
      const el = Math.hypot(e1[0], e1[1], e1[2]);
      const u: [number, number, number] = [e1[0] / el, e1[1] / el, e1[2] / el];
      const v = cross(n, u); // u × v = n
      out.push({
        kind: "extrudePlane",
        points: p.flatMap((q) => {
          const d = sub(q, p[0]);
          return [dot(d, u), dot(d, v)];
        }),
        origin: [p[0][0], p[0][1], p[0][2]],
        uAxis: u,
        vAxis: [v[0], v[1], v[2]],
        depth: -total, // nach unten (Eindeckung oben)
      });
    }
  }

  for (const solid of project.extrudedSolids ?? []) {
    let baseZ = 0;
    if (solid.levelId) {
      try {
        baseZ = getFloor(project, solid.levelId).baseElevation ?? 0;
      } catch {
        baseZ = 0;
      }
    }
    const spec = extrudedSolidSpec(solid, baseZ);
    if (spec) out.push(spec);
  }
  return out;
}

type V3 = [number, number, number];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Ergebnis des Projekt-Exports. */
export interface StepExportResult {
  text: string;
  /** Anzahl exportierter Körper. */
  count: number;
  /** Körper, die truck nicht bauen konnte (Index + Meldung) — beim Export übersprungen. */
  skipped: Array<{ index: number; error: string }>;
}

/**
 * Exportiert das Projekt als STEP-Text. Körper, die truck nicht bauen kann (entartete
 * Profile …), werden einzeln übersprungen statt den ganzen Export zu verwerfen.
 */
export async function exportProjectStep(project: Project, fileName = ""): Promise<StepExportResult> {
  const specs = projectSolidSpecs(project);
  const good: SolidSpec[] = [];
  const skipped: StepExportResult["skipped"] = [];
  // Erst alle zusammen versuchen (Normalfall); nur bei Fehler einzeln prüfen.
  try {
    const text = await exportStepSolids(specs, fileName || project.name);
    return { text, count: specs.length, skipped };
  } catch {
    /* einzeln weiter */
  }
  for (let i = 0; i < specs.length; i++) {
    try {
      await exportStepSolids([specs[i]], "");
      good.push(specs[i]);
    } catch (e) {
      skipped.push({ index: i, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const text = await exportStepSolids(good, fileName || project.name);
  return { text, count: good.length, skipped };
}
