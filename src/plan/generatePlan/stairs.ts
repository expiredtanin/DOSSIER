// Treppen-Domäne des Grundriss-Generators (DOSSIER/SIA): Tritte, Lauflinie mit
// Auf-/Abpfeil, Zwischenpodest und Aussenlinie — mit dem Grundriss-Schnitt
// (Tritte unter der Schnitthöhe durchgezogen, darüber gestrichelt/verdeckt +
// SIA-Bruchlinie).

import type { Project, Stair, Vec2 } from "../../model/types";
import { stairVerticalExtent } from "../../model/wall";
import { stairCut, stairGeometry, stairOutline } from "../../geometry/stair";
import type { SpiralOutlineSegments } from "../../geometry/stair";
import { NO_HATCH, POCHE_STROKE, type Primitive } from "./shared";

/**
 * Zeichnet die Wendel-Aussenlinie: Innen-/Aussenbogen als Arc-Primitive plus zwei
 * radiale Schliesslinien. Wird von `addStairSymbol` aufgerufen wenn `shape === "spiral"`.
 */
function _addSpiralOutline(
  out: Primitive[],
  seg: SpiralOutlineSegments,
  stroke: string,
  lwMm: number,
  greyed: boolean,
  stairId: string,
): void {
  // Radiale Schliesslinien (Startwinkel + Endwinkel).
  for (const [a, b] of seg.lines) {
    out.push({ kind: "line", a, b, cls: "stair-outline", weightMm: lwMm, color: stroke, greyed, stairId });
  }
  // Innen- und Aussenbogen.
  for (const arc of seg.arcs) {
    const from: Vec2 = { x: arc.cx + arc.r * Math.cos(arc.a0), y: arc.cy + arc.r * Math.sin(arc.a0) };
    const to: Vec2   = { x: arc.cx + arc.r * Math.cos(arc.a1), y: arc.cy + arc.r * Math.sin(arc.a1) };
    out.push({
      kind: "arc",
      center: { x: arc.cx, y: arc.cy },
      from,
      to,
      r: arc.r,
      cls: "stair-outline",
      weightMm: lwMm,
      greyed,
      stairId,
    });
  }
}

/**
 * Treppen-Symbol im Grundriss (DOSSIER/SIA):
 *  • Tritte als Rechtecke: die Tritt-Trennlinien werden gezeichnet — unter der
 *    Schnittebene DURCHGEZOGEN (sichtbar), darüber GESTRICHELT (verdeckt).
 *  • Der erste Tritt oberhalb der Schnittebene trägt die diagonale SIA-Bruchlinie
 *    (Doppelstrich quer über den Lauf).
 *  • Zwischenpodest (L/Wendel) als Umriss-Polygon.
 *  • Lauflinie (Lauflinie) mit Auf-/Abpfeil (Auf-/Abpfeil) und Stufenanzahl-Label.
 * Alle Primitive tragen `stairId` für die Auswahl.
 */
export function addStairSymbol(
  out: Primitive[],
  project: Project,
  stair: Stair,
  greyed: boolean,
  lwMm: number,
  cutHeight: number,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const totalRise = zTop - zBottom;
  const geo = stairGeometry(stair, totalRise);
  const cut = stairCut(geo, cutHeight);
  const below = new Set(cut.belowIndices);
  const stroke = stair.color ?? POCHE_STROKE;
  const stairId = stair.id;

  // Umriss + Tritt-Trennlinien je Stufe. Der letzte Punkt jedes Tritt-Rechtecks
  // liefert die vordere Kante (Auftritt); wir zeichnen jede Tritt-Kante.
  for (const tr of geo.treads) {
    const isBelow = below.has(tr.index);
    // Tritt-Rechteck als reine Umrisslinie (keine Füllung), durchgezogen wenn
    // unter der Schnittebene, sonst gestrichelt (verdeckt).
    out.push({
      kind: "polygon",
      pts: tr.pts,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
    // Zusätzliche Auftrittskante (vordere Kante der Stufe) etwas kräftiger.
    const front: [Vec2, Vec2] = [tr.pts[1], tr.pts[2]];
    out.push({
      kind: "line",
      a: front[0],
      b: front[1],
      cls: "stair-tread",
      weightMm: lwMm * (isBelow ? 1.0 : 0.6),
      dash: isBelow ? null : [0.12, 0.08],
      color: stroke,
      greyed,
      stairId,
    });
  }

  // Zwischenpodest (L/Wendel-Auge): Umriss-Polygon.
  if (geo.landing && geo.landing.length >= 3) {
    out.push({
      kind: "polygon",
      pts: geo.landing,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm * 0.7,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  }

  // SIA-Bruchlinie (Doppelstrich diagonal über den Schnitt-Tritt).
  if (cut.breakLine) {
    for (const [a, b] of cut.breakLine) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "stair-break",
        weightMm: lwMm,
        color: stroke,
        greyed,
        stairId,
      });
    }
  }

  // Lauflinie (Lauflinie) — kräftig, durchgezogen.
  for (let i = 0; i < geo.runLine.length - 1; i++) {
    out.push({
      kind: "line",
      a: geo.runLine[i],
      b: geo.runLine[i + 1],
      cls: "stair-run",
      weightMm: lwMm,
      color: stroke,
      greyed,
      stairId,
    });
  }
  // Auf-/Abpfeil an der Spitze der Lauflinie. "filled" = gefülltes Dreieck
  // (SIA-Vollpfeil), sonst der offene Winkelpfeil (zwei Linien, Default).
  const [h1, tip, h2] = geo.arrow.head;
  if (stair.arrowStyle === "filled") {
    out.push({
      kind: "polygon",
      pts: [h1, tip, h2],
      fill: stroke,
      stroke,
      strokeWidthMm: lwMm,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  } else {
    out.push({ kind: "line", a: h1, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });
    out.push({ kind: "line", a: h2, b: tip, cls: "stair-arrow", weightMm: lwMm, color: stroke, greyed, stairId });
  }

  // Aussenlinie (Outline) der Treppe — schliessendes Umriss-Polygon (gerade/L)
  // bzw. Innen-/Aussenbogen + radiale Schliesslinien (Wendel).
  // Entspricht `_aussen_gerade` / `_aussen_l_polygon` / `_aussen_wendel` im
  // Rhino-Plugin. Stets durchgezogen, volle Strichstärke.
  const outline = stairOutline(stair, totalRise);
  if (outline.polygon && outline.polygon.length >= 3) {
    out.push({
      kind: "polygon",
      pts: outline.polygon,
      fill: "none",
      stroke,
      strokeWidthMm: lwMm,
      hatch: NO_HATCH,
      greyed,
      stairId,
    });
  }
  if (outline.spiral) {
    _addSpiralOutline(out, outline.spiral, stroke, lwMm, greyed, stairId);
  }
}
