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
import { documentFor } from "../core/document";
import { exportStepSolids } from "../engine/truckSolid";
import type { SolidSpec } from "../engine/truckSolid";

export { wallProfile, wallSpec } from "../plan/wallSpec";

/**
 * Boolean-Spezifikation (Bauteil − Abzugskörper) → dieselbe ohne Abzug. Scheitert truck am
 * Boolean, exportiert `exportProjectStep` das Bauteil wenigstens ungeschnitten.
 */
const VOID_FALLBACK = new WeakMap<SolidSpec, SolidSpec>();

/** Alle Bauteile des Projekts als B-Rep-Spezifikationen (Rust-Kern, `solid_specs.rs::project_solid_specs`; kein truck-WASM). */
export function projectSolidSpecs(project: Project): SolidSpec[] {
  const r = documentFor(project).query<{ specs: SolidSpec[]; fallbacks: [number, SolidSpec][] }>("projectSolidSpecs", []);
  for (const [i, base] of r.fallbacks) VOID_FALLBACK.set(r.specs[i], base);
  return r.specs;
}

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
