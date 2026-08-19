// Schnittführungs-Symbol-Domäne des Grundriss-Generators (klassische
// Strichpunkt-Schnittlinie mit Endmarken + Label) — NICHT zu verwechseln mit
// `generateSectionPlan()` (der Schnitt-ALS-Plan-Übersetzung, bleibt Orchestrator
// in `../generatePlan.ts`): diese Domäne zeichnet nur das Führungssymbol EINER
// Schnitt-/Ansichtsebene IM Grundriss.

import { leftNormal, normalize, sub } from "../../model/geometry";
import type { Project } from "../../model/types";
import { NO_HATCH, type Primitive } from "./shared";

/** Tinte der Schnittführungs-Linie/Marken (kräftiges Grau). */
const SECTION_LINE_INK = "#1f242c";
/** Haarlinie der Strichpunkt-Schnittlinie (mm Papier). */
const SECTION_LINE_MM = 0.18;
/** Kräftige Endmarken (Querstrich + Pfeil) (mm Papier). */
const SECTION_LINE_MARK_MM = 0.5;
/** Strichpunkt-Muster der Schnittlinie (lange Striche + Punkt, mm Papier). */
const SECTION_LINE_DASH: number[] = [6, 1.5, 0.4, 1.5];
/** Länge der Endmarken (Querstrich/Pfeil) in Modell-Metern. */
const SECTION_MARK_LEN = 0.6;
/** Halbe Breite des unsichtbaren Pick-Bands über der Linie (Modell-Meter). */
const SECTION_PICK_HALF = 0.3;
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
 */
export function addSectionLines(out: Primitive[], project: Project): void {
  for (const level of project.drawingLevels) {
    if (level.kind !== "section" && level.kind !== "elevation") continue;
    // Schnittebene ist ein-/ausblendbar wie andere Ebenen: eine unsichtbare
    // Schnitt-/Ansichtsebene zeigt ihre Linie im Grundriss nicht (Nutzer-Vision
    // „eigene Ebene Schnittebenen"). `visible` fehlt = sichtbar (Alt-Projekte).
    if (level.visible === false) continue;
    const line = level.linePoints;
    if (!line) continue;
    const [p0, p1] = line;
    const axis = sub(p1, p0);
    const len = Math.hypot(axis.x, axis.y);
    if (len < 1e-6) continue;
    const u = normalize(axis);
    const n = leftNormal(u); // (-uy, ux)
    const sign = level.directionSign ?? 1;
    const bn = { x: n.x * sign, y: n.y * sign }; // Blicknormale

    // Hauptlinie (Strichpunkt-Haarlinie).
    out.push({
      kind: "line",
      a: p0,
      b: p1,
      cls: "section-line",
      weightMm: SECTION_LINE_MM,
      dash: SECTION_LINE_DASH,
      color: SECTION_LINE_INK,
    });

    // Endmarken (Querstrich + Richtungspfeil + Label) an beiden Enden.
    const half = SECTION_MARK_LEN / 2;
    for (const end of [p0, p1]) {
      // Querstrich senkrecht zur Linie, mittig am Endpunkt.
      const t0 = { x: end.x - n.x * half, y: end.y - n.y * half };
      const t1 = { x: end.x + n.x * half, y: end.y + n.y * half };
      out.push({
        kind: "line",
        a: t0,
        b: t1,
        cls: "section-line",
        weightMm: SECTION_LINE_MARK_MM,
        color: SECTION_LINE_INK,
      });
      // Richtungspfeil: vom Querstrich-Ende auf der Blickseite entlang bn.
      const base = { x: end.x + bn.x * half, y: end.y + bn.y * half };
      const tip = { x: base.x + bn.x * SECTION_MARK_LEN, y: base.y + bn.y * SECTION_MARK_LEN };
      const wingBack = {
        x: tip.x - bn.x * SECTION_MARK_LEN * 0.4,
        y: tip.y - bn.y * SECTION_MARK_LEN * 0.4,
      };
      const w = SECTION_MARK_LEN * 0.25;
      out.push({ kind: "line", a: base, b: tip, cls: "section-line", weightMm: SECTION_LINE_MARK_MM, color: SECTION_LINE_INK });
      out.push({
        kind: "line",
        a: tip,
        b: { x: wingBack.x + u.x * w, y: wingBack.y + u.y * w },
        cls: "section-line",
        weightMm: SECTION_LINE_MARK_MM,
        color: SECTION_LINE_INK,
      });
      out.push({
        kind: "line",
        a: tip,
        b: { x: wingBack.x - u.x * w, y: wingBack.y - u.y * w },
        cls: "section-line",
        weightMm: SECTION_LINE_MARK_MM,
        color: SECTION_LINE_INK,
      });
      // Label (Kurz-Tag) etwas hinter dem Pfeil, horizontal.
      const labelAt = {
        x: tip.x + bn.x * SECTION_MARK_LEN * 0.4 - SECTION_LABEL_H * 0.3,
        y: tip.y + bn.y * SECTION_MARK_LEN * 0.4 + SECTION_LABEL_H * 0.5,
      };
      out.push({
        kind: "drawingText",
        at: labelAt,
        text: sectionLabelTag(level.name),
        heightM: SECTION_LABEL_H,
        angle: 0,
        color: SECTION_LINE_INK,
      });
    }

    // Unsichtbares Pick-Band (Rechteck entlang der Linie) — klickbar per
    // Punkt-in-Polygon in PlanView, trägt die DrawingLevel-Id.
    const off = { x: n.x * SECTION_PICK_HALF, y: n.y * SECTION_PICK_HALF };
    out.push({
      kind: "polygon",
      pts: [
        { x: p0.x + off.x, y: p0.y + off.y },
        { x: p1.x + off.x, y: p1.y + off.y },
        { x: p1.x - off.x, y: p1.y - off.y },
        { x: p0.x - off.x, y: p0.y - off.y },
      ],
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: NO_HATCH,
      sectionLineId: level.id,
    });
  }
}
