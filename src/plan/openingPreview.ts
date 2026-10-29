// Live-Vorschau einer Öffnung für den Fenster-/Tür-Dialog ([102]/[103]): Der Kern baut ein kleines
// Projekt (Abfrage `openingPreview`, `src-tauri/core/src/opening_preview.rs`: Wirtswand mit nur dieser
// Öffnung, Schnitt quer durch die Mitte, Ansicht von aussen); Grundriss, Schnitt und Ansicht rechnen die
// gewöhnlichen Kern-Fassaden, als SVG-Text (`planToSvgString`).

import type { DetailLevel, Project } from "../model/types";
import { documentFor } from "../core/document";
import { generatePlan } from "./generatePlan";
import { computeSection, generateSectionPlan } from "./toSection";
import { generateElevationPlan } from "./toElevation";
import { planToSvgString } from "../export/planToSvgString";

export interface OpeningPreviewSvgs {
  plan: string;
  section: string | null;
  elevation: string | null;
}

/** Vorschau-Projekt (oder `null`, wenn Öffnung/Wand fehlen). */
export function openingPreviewProject(project: Project, openingId: string): Project | null {
  return documentFor(project).query<Project | null>("openingPreview", [], openingId);
}

/** Grundriss (Detailgrad `detail`), Schnitt und Ansicht der Öffnung als SVG-Text, Massstab 1:`scale`. */
export async function openingPreviewSvgs(project: Project, openingId: string, detail: DetailLevel = "fein", scale = 20): Promise<OpeningPreviewSvgs | null> {
  const mini = openingPreviewProject(project, openingId);
  if (!mini) return null;
  const codes = new Set<string>(["", ...collectCodes(mini)]);
  const opts = { scaleDenominator: scale, marginM: 0.15 };
  const plan = planToSvgString(generatePlan(mini, "preview-floor", codes, undefined, detail, false, false, false, scale), opts);
  const secLevel = mini.drawingLevels.find((l) => l.id === "preview-section");
  const elevLevel = mini.drawingLevels.find((l) => l.id === "preview-elevation");
  let section: string | null = null;
  if (secLevel) {
    const out = await computeSection(mini, secLevel);
    if (out) section = planToSvgString(generateSectionPlan(out, false, { visibleCodes: codes, openings: true }), opts);
  }
  let elevation: string | null = null;
  if (elevLevel) {
    const p = generateElevationPlan(mini, elevLevel, { visibleCodes: codes });
    if (p) elevation = planToSvgString(p, opts);
  }
  return { plan, section, elevation };
}

function collectCodes(p: Project): string[] {
  const out: string[] = [];
  for (const w of p.walls) out.push(w.categoryCode);
  for (const o of p.openings ?? []) out.push(o.categoryCode);
  const walk = (cats: Project["layers"]) => {
    for (const c of cats) {
      out.push(c.code);
      walk((c as { children?: Project["layers"] }).children ?? []);
    }
  };
  walk(p.layers);
  return out;
}
