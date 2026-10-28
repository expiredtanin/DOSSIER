// Schnittführungs-Symbol-Domäne des Grundriss-Generators (klassische
// Strichpunkt-Schnittlinie mit Endmarken + Label) — NICHT zu verwechseln mit
// `generateSectionPlan()` (der Schnitt-ALS-Plan-Übersetzung, bleibt Orchestrator
// in `../generatePlan.ts`): diese Domäne zeichnet nur das Führungssymbol EINER
// Schnitt-/Ansichtsebene IM Grundriss. Die Geometrie berechnet der Rust-Kern (`plan_misc.rs`, [K3a]).

import { core } from "../../engine/coreWasm";
import type { Project } from "../../model/types";
import { NO_HATCH, SHOW_ALL, type CategoryDisplayResolver, type Primitive } from "./shared";

/**
 * Kategorie-Code der Schnittführungs-Symbole — feste Zuordnung zu "90"
 * (Referenzen), derselben Kategorie wie Kontext-Konturen/Höhenlinien:
 * Schnittlinien sind Dokumentations-/Referenzelemente, keine Bauteile, und
 * bekommen deshalb kein eigenes Sichtbarkeits-Flag mehr am DrawingLevel —
 * sie sind ein Element AUF einer Ebene und werden NUR darüber (Ebenen-Panel,
 * visibleCodes/categoryDisplay) ein-/ausgeblendet, wie jedes andere Bauteil.
 */
const SECTION_LINE_CATEGORY = "90";

/** Tinte der Schnittführungs-Linie/Marken (kräftiges Grau). */
const SECTION_LINE_INK = "#1f242c";
/** Haarlinie der Strichpunkt-Schnittlinie (mm Papier). */
const SECTION_LINE_MM = 0.18;
/** Kräftige Endmarken (Querstrich + Pfeil) (mm Papier). */
const SECTION_LINE_MARK_MM = 0.5;
/** Strichpunkt-Muster der Schnittlinie (lange Striche + Punkt, mm Papier). */
const SECTION_LINE_DASH: number[] = [6, 1.5, 0.4, 1.5];
/** Schrifthöhe des Schnitt-Labels (Modell-Meter). */
const SECTION_LABEL_H = 0.5;

/**
 * Kurz-Tag eines Schnitt-Labels: der letzte „Wort"-Teil des Ebenennamens (z. B.
 * „Schnitt A" → „A"); enthält der Name kein Leerzeichen, der ganze Name. Klassisch
 * wird der Schnitt an beiden Enden mit diesem Tag beschriftet (A–A).
 */
function sectionLabelTag(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : name.trim();
}

/**
 * Zeichnet für jede Schnitt-/Ansichtsebene MIT gesetzter `linePoints` das
 * klassische Schnittführungs-Symbol in den Grundriss: eine Strichpunkt-Haarlinie
 * über die volle Länge, an beiden Enden einen kräftigen Querstrich + Richtungspfeil
 * auf der Blickseite (`directionSign`) und das Schnitt-Label (Kurz-Tag) daneben.
 * Zusätzlich ein unsichtbares Pick-Band (Polygon mit `sectionLineId`), damit die
 * Linie im Grundriss anklickbar ist (analog dem Dach-Traufe-Pick-Polygon).
 *
 * Sichtbarkeit/Dimmen läuft über die Kategorie "90" (Referenzen) — genau wie
 * bei Wänden/Decken/Räumen, NICHT über das eigene Sichtbarkeits-Flag der
 * Schnitt-/Ansichtsebene (Nutzer-Feedback: "diese sollten Elemente sein, die
 * sich auf einer Ebene befinden und nur damit ein-/ausgeblendet werden").
 * `visibleCodes`/`categoryDisplay` fehlen sie (Export-/Print-Pfad ohne
 * Ebenen-Filter) → immer sichtbar, wie bisher.
 */
export function addSectionLines(
  out: Primitive[],
  project: Project,
  visibleCodes?: Set<string>,
  categoryDisplay: CategoryDisplayResolver = SHOW_ALL,
): void {
  const d = categoryDisplay(SECTION_LINE_CATEGORY);
  if ((visibleCodes && !visibleCodes.has(SECTION_LINE_CATEGORY)) || !d.render) return;
  const greyed = d.greyed;
  for (const level of project.drawingLevels) {
    if (level.kind !== "section" && level.kind !== "elevation") continue;
    const line = level.linePoints;
    if (!line) continue;
    const [p0, p1] = line;
    const f = core().section_line_flat(p0.x, p0.y, p1.x, p1.y, level.directionSign ?? 1);
    if (f.length === 0) continue;
    let i = 1;
    for (let k = 0; k < f[0]; k++) {
      if (f[i] === 2) {
        const main = f[i + 1] === 0;
        out.push({
          kind: "line",
          a: { x: f[i + 2], y: f[i + 3] },
          b: { x: f[i + 4], y: f[i + 5] },
          cls: "section-line",
          weightMm: main ? SECTION_LINE_MM : SECTION_LINE_MARK_MM,
          ...(main ? { dash: SECTION_LINE_DASH } : {}),
          color: SECTION_LINE_INK,
          greyed,
        });
        i += 6;
      } else if (f[i] === 5) {
        out.push({
          kind: "drawingText",
          at: { x: f[i + 1], y: f[i + 2] },
          text: sectionLabelTag(level.name),
          heightM: SECTION_LABEL_H,
          angle: 0,
          color: SECTION_LINE_INK,
          greyed,
        });
        i += 3;
      } else {
        // Unsichtbares Pick-Band (Rechteck entlang der Linie) — klickbar per Punkt-in-Polygon in
        // PlanView, trägt die DrawingLevel-Id.
        out.push({
          kind: "polygon",
          pts: [0, 1, 2, 3].map((j) => ({ x: f[i + 1 + 2 * j], y: f[i + 2 + 2 * j] })),
          fill: "none",
          stroke: "none",
          strokeWidthMm: 0,
          hatch: NO_HATCH,
          sectionLineId: level.id,
        });
        i += 9;
      }
    }
  }
}
