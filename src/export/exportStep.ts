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
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { exportStepSolids } from "../engine/truckSolid";
import { extrudedSolidSpec } from "../plan/extrudedSolidSpec";
import type { SolidSpec } from "../engine/truckSolid";
import { wallSpec } from "../plan/wallSpec";
import { bbox, hittingVoids, subtractSpec, voidPrisms, wallCorners } from "../plan/voids";
import type { Box2 } from "../plan/voids";

export { wallProfile, wallSpec } from "../plan/wallSpec";

const EPS = 1e-6;
/** Schicht/Öffnung so dünn, dass sie als nicht vorhanden gilt. */
const MIN_THICKNESS = 1e-4;

/**
 * Boolean-Spezifikation (Bauteil − Abzugskörper) → dieselbe ohne Abzug. Scheitert truck am
 * Boolean, exportiert `exportProjectStep` das Bauteil wenigstens ungeschnitten.
 */
const VOID_FALLBACK = new WeakMap<SolidSpec, SolidSpec>();

/** Alle Bauteile des Projekts als B-Rep-Spezifikationen (reiner Kern, kein WASM). */
export function projectSolidSpecs(project: Project): SolidSpec[] {
  const out: SolidSpec[] = [];
  const model = projectToModel3d(project, { layeredWalls: true });
  const voids = voidPrisms(project);
  const withVoids = (base: SolidSpec, foot: Box2, z0: number, z1: number): SolidSpec => {
    const hits = hittingVoids(voids, foot, z0, z1);
    if (hits.length === 0) return base;
    const spec = subtractSpec(base, hits);
    VOID_FALLBACK.set(spec, base);
    return spec;
  };

  for (const w of model.walls) {
    const s = wallSpec(w);
    if (s) out.push(withVoids(s, bbox(wallCorners(w)), w.baseElevation, w.baseElevation + w.height));
  }

  for (const s of model.slabs) {
    if (s.outline.length < 3 || s.zTop - s.zBottom < MIN_THICKNESS) continue;
    const base: SolidSpec = {
      kind: "extrude",
      points: s.outline.flatMap((p) => [p[0], p[1]]),
      height: s.zTop - s.zBottom,
      z0: s.zBottom,
    };
    out.push(withVoids(base, bbox(s.outline.map((p) => ({ x: p[0], y: p[1] }))), s.zBottom, s.zTop));
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
    if (solid.operation === "subtract") continue; // Abzugskörper sind kein Material
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
      const fallback = VOID_FALLBACK.get(specs[i]);
      if (fallback) {
        try {
          await exportStepSolids([fallback], "");
          good.push(fallback);
          skipped.push({ index: i, error: "Abzugskörper nicht abziehbar — Bauteil ungeschnitten exportiert" });
          continue;
        } catch {
          /* unten melden */
        }
      }
      skipped.push({ index: i, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const text = await exportStepSolids(good, fileName || project.name);
  return { text, count: good.length, skipped };
}
