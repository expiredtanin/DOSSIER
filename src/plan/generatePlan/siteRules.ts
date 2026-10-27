// Baurecht im Grundriss ([63]): Parzellengrenze (strichpunktiert), zulässige Grundfläche
// (gestrichelt), beides zuunterst, und Gebäude-Grundfläche ausserhalb davon (rot, halbtransparent,
// zuoberst). Nur im Geschoss
// nächst ±0.00, wie die Schattenstudie. Rechnung in `analysis/siteRules.ts`.

import type { Project, Vec2 } from "../../model/types";
import { checkSiteRules } from "../../analysis/siteRules";
import { withoutHoles } from "../../analysis/sun";
import { NO_HATCH, type Primitive } from "./shared";
import { groundFloorId } from "./sunShadow";

/** Erkennungsmerkmale (Linien-Klassen, Füllfarbe) — auch für Tests. */
export const SITE_CLS = {
  parcel: "site-parcel",
  allowed: "site-allowed",
  violationFill: "#d0342c",
} as const;

const PARCEL_COLOR = "#1f6f3f";
const ALLOWED_COLOR = "#2b5fae";

function ringLines(out: Primitive[], pts: Vec2[], cls: string, color: string, weightMm: number, dash: number[]): void {
  for (let i = 0; i < pts.length; i++) {
    out.push({ kind: "line", a: pts[i], b: pts[(i + 1) % pts.length], cls, weightMm, dash, color });
  }
}

/** Parzellengrenze und zulässige Fläche (zuunterst gezeichnet). */
export function addSiteRules(out: Primitive[], project: Project, floorId: string): void {
  const rules = project.siteRules;
  if (!rules || rules.show === false || groundFloorId(project) !== floorId) return;
  const check = checkSiteRules(project);
  if (!check) return;
  // Parzellengrenze: Strich-Punkt; zulässige Fläche: gestrichelt (Papier-mm).
  ringLines(out, rules.parcel, SITE_CLS.parcel, PARCEL_COLOR, 0.35, [6, 1.5, 0.5, 1.5]);
  for (const poly of check.allowed) for (const r of poly) ringLines(out, r, SITE_CLS.allowed, ALLOWED_COLOR, 0.25, [2, 1]);
}

/** Gebäude-Grundfläche ausserhalb der zulässigen Fläche (zuoberst, damit sie über der Wand liegt). */
export function addSiteViolations(out: Primitive[], project: Project, floorId: string): void {
  const rules = project.siteRules;
  if (!rules || rules.show === false || groundFloorId(project) !== floorId) return;
  for (const poly of checkSiteRules(project)?.violations ?? []) {
    for (const pts of withoutHoles(poly)) {
      out.push({ kind: "polygon", pts, fill: SITE_CLS.violationFill, stroke: "none", strokeWidthMm: 0, hatch: NO_HATCH, opacity: 0.45 });
    }
  }
}
