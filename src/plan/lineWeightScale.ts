// Strichstärken nach Massstab ([32]): mit `Project.scaleLineWeights` werden alle Papier-mm-Stärken
// eines Grundrisses mit (100/n)^0.25 skaliert — 1:200 ≈ 84 %, 1:50 ≈ 119 % (Vorgabe wie BIMCraft
// `pen.rs`). So bleibt ein 1:200-Plan nicht zu schwer und ein 1:50-Plan nicht zu dünn, ohne eigene
// Stiftsätze je Massstab.

import type { Project } from "../model/types";
import type { Primitive } from "./generatePlan/shared";

const REFERENCE_SCALE = 100;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 1.6;

/** Faktor für den Massstab 1:n (1 ohne Option oder bei ungültigem n). */
export function lineWeightFactor(project: Project, scaleDenominator: number): number {
  if (!project.scaleLineWeights || !(scaleDenominator > 0) || !Number.isFinite(scaleDenominator)) return 1;
  const f = (REFERENCE_SCALE / scaleDenominator) ** 0.25;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, f));
}

// Je Quell-Primitiv die zuletzt erzeugte Skalierung: gleiche Eingabe → dasselbe Objekt, damit der
// GPU-Chunk-Cache (`glPlanChunks.ts`) Primitive wiedererkennt.
const scaledClones = new WeakMap<Primitive, { f: number; clone: Primitive }>();

/** Primitiv mit skalierten Strichstärken (Original bleibt unverändert). */
export function scalePrimitiveWeights(p: Primitive, f: number): Primitive {
  if (f === 1) return p;
  const hit = scaledClones.get(p);
  if (hit && hit.f === f) return hit.clone;
  const c = { ...p } as Record<string, unknown>;
  if (typeof c.weightMm === "number") c.weightMm = c.weightMm * f;
  if (typeof c.strokeWidthMm === "number") c.strokeWidthMm = c.strokeWidthMm * f;
  const hatch = c.hatch as { lineWeight?: unknown } | undefined;
  if (hatch && typeof hatch.lineWeight === "number") c.hatch = { ...hatch, lineWeight: hatch.lineWeight * f };
  const clone = c as unknown as Primitive;
  scaledClones.set(p, { f, clone });
  return clone;
}
