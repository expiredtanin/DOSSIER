// Abzugskörper (`ExtrudedSolid.operation === "subtract"`): Aussparungen, Durchbrüche und
// Nischen, die sich von Wänden, Decken und Stützen abziehen — in ALLEN abgeleiteten
// Ansichten aus demselben Modell:
//
//  • Grundriss: Poché-Polygone der getroffenen Bauteile minus Körper-Grundfläche, sofern der
//    Körper die Schnitthöhe (Wände/Stützen) bzw. die Platte (Decken) durchdringt — rechnet der
//    Kern (`core/src/plan/extras.rs::subtract_voids`).
//  • Schnitt:   Cut-Polygone minus Körper-Schnitt (Grundfläche ∩ Schnittspur × Höhenbereich), im Kern
//               (`core/src/plan/section.rs`).
//  • 3D:        Boolean-Differenz (truck, Mesh-CSG-Fallback); welche Bauteile getroffen sind und
//               ihre Spezifikation rechnet der Kern (`core/src/solid_specs.rs`), s. `toWalls3d/voids3d.ts`.
//  • STEP:      `exportStep.ts` liest dieselben Kern-Spezifikationen (`model3dParts` mit Abzugskörpern).
//
// Abzugskörper sind senkrechte Prismen (Profil × Höhe, ohne Verjüngung/B-Rep) — damit bleiben
// Grundriss und Schnitt exakt analytisch (ein Prisma schneidet eine waagrechte Ebene in seiner
// Grundfläche und eine senkrechte Ebene in Rechtecken).
//
// Polygone mit Loch (Körper ganz im Bauteil) werden über einen Steg an den Aussenring
// gehängt (Schlüsselloch); die beiden Stegkanten sind nicht gestrichen (`noStrokeEdges`).

import type { Pair } from "../geometry/polygonBool";
import { core } from "../engine/coreWasm";

// ── Polygon-Booleans (Rust-Kern, `voids.rs`) ─────────────────────────────────

/** Ringliste flach für den Kern (`[n, (k, x, y …) × n]`). */
function encodeRings(rings: Pair[][]): Float64Array {
  const b: number[] = [rings.length];
  for (const r of rings) {
    b.push(r.length);
    for (const p of r) b.push(p[0], p[1]);
  }
  return Float64Array.from(b);
}

/**
 * Polygon (Ring `pts`, optional nicht gestrichene Kanten) minus Schneider. Liefert die
 * Rest-Polygone mit übertragenen `noStrokeEdges` (eine Kante bleibt ungestrichen, wenn sie
 * auf einer ungestrichenen Kante des Originals liegt; Stege sind immer ungestrichen).
 * `null` = keine Überschneidung (Original unverändert lassen).
 */
export function subtractRings(
  pts: Pair[],
  cutters: Pair[][],
  noStroke: number[] = [],
): Array<{ pts: Pair[]; noStrokeEdges: number[] }> | null {
  if (pts.length < 3 || cutters.length === 0) return null;
  const f = core().voids_subtract_rings_flat(
    encodeRings([pts]).subarray(1),
    encodeRings(cutters),
    Float64Array.from([noStroke.length, ...noStroke]),
  );
  if (f.length === 0 || f[0] < 0) return null;
  const out: Array<{ pts: Pair[]; noStrokeEdges: number[] }> = [];
  let i = 1;
  for (let k = 0; k < f[0]; k++) {
    const n = f[i++];
    const rp = new Array<Pair>(n);
    for (let j = 0; j < n; j++, i += 2) rp[j] = [f[i], f[i + 1]];
    const m = f[i++];
    const ns = new Array<number>(m);
    for (let j = 0; j < m; j++) ns[j] = f[i++];
    out.push({ pts: rp, noStrokeEdges: ns });
  }
  return out;
}
