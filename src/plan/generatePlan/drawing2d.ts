// Freie 2D-Zeichengeometrie-Domäne des Grundriss-Generators (docs/design/
// drawing-tools.md §7.2): leitet ein `Drawing2D`-Element (line/polyline/rect/
// circle/arc/text/image) in Plan-Primitive ab. Farbe/Strichstärke kommen aus
// dem optionalen LineStyle, sonst aus der Kategorie.

import type { Drawing2D, LayerCategory, Project, Vec2 } from "../../model/types";
import {
  NO_HATCH,
  WALL_FALLBACK_MM,
  MONO_INK,
  resolveHatch,
  resolveHatchId,
  resolveStrokeWeight,
  type Primitive,
} from "./shared";
import { ellipsePts, sampleBezierChain, sampleCatmullRom } from "../../tools/curves";

export function addDrawing2D(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
): void {
  const category = catByCode.get(d.categoryCode);
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  // Plan-Tinte fix dunkel: Fallback auf MONO_INK (statt hell „#d0d0d0"), damit
  // ein kategorieloses 2D-Element auf dem hellen Papier sichtbar bleibt.
  const color = d.color ?? ls?.color ?? colorByCode.get(d.categoryCode) ?? MONO_INK;
  // Strichstärke: "layer" erzwingt die Ebenen-Strichstärke (umgeht das
  // LineStyle-Gewicht), sonst (Default "object") die heutige Kette.
  const weightMm = resolveStrokeWeight(
    d.weightMm,
    d.strokeWeightSource,
    category,
    ls?.weight ?? lwByCode.get(d.categoryCode) ?? WALL_FALLBACK_MM,
  );
  const dash = ls?.dash ?? null;
  // Drawing2D trägt kein Bauteil → die By-Layer-Quelle ist hier die einzige
  // Alternative zum expliziten Wert (kein Component-Fallback); Default
  // "object"/undefined bleibt exakt das heutige Verhalten.
  const foreground = d.foreground ?? (d.foregroundSource === "layer" ? category?.color : undefined);
  const background = d.background ?? (d.backgroundSource === "layer" ? category?.color : undefined);
  const hatchId = resolveHatchId(d.hatchId, d.hatchSource, category, undefined);
  // Zickzack-Parameter aus dem LineStyle durchreichen (nur kind==="zigzag").
  // Additiv: fehlt es, bleibt die Linie gerade/gestrichelt wie bisher.
  const zigzag = ls?.kind === "zigzag" ? ls.zigzag : undefined;
  // Custom-Motiv analog durchreichen (nur kind==="custom").
  const motif = ls?.kind === "custom" ? ls.motif : undefined;
  const seg = (a: Vec2, b: Vec2) =>
    out.push({ kind: "line", a, b, cls: "draw2d", weightMm, dash, zigzag, motif, color, greyed, drawingId: d.id });

  /**
   * Gefüllte Fläche einer GESCHLOSSENEN Form: trägt die Vollton-Füllfarbe
   * (`d.fillColor`, sonst transparent) UND die optionale Füllschraffur
   * (`d.hatchId`, sonst NO_HATCH). Wird VOR den Strichen gepusht, damit die
   * Umrisslinien oben liegen. Trägt `drawingId`, sodass ein Klick auf die Fläche
   * das Element selektiert (analog zu den Linien).
   */
  const fillPoly = (pts: Vec2[]) =>
    out.push({
      kind: "polygon",
      pts,
      // Hintergrund-Override (Wert ?? By-Layer) hat Vorrang vor dem Alt-Feld
      // fillColor (alle leer = transparente Fläche, nur Schraffur) — Sample
      // bleibt identisch (kein Element setzt background/backgroundSource).
      fill: background ?? d.fillColor ?? "none",
      // Umriss zeichnen die separaten Linien-Primitive (mit Strichmuster); die
      // Füllfläche selbst bleibt randlos, um doppelte Striche zu vermeiden.
      stroke: "none",
      strokeWidthMm: 0,
      // Drawing2D trägt kein Bauteil → Vordergrund/Schraffur-Override direkt aus
      // d.foreground/d.hatchId bzw. der Ebene (Attribut „Nach System" ⇒
      // undefined ⇒ HatchStyle.color-Fallback bzw. NO_HATCH).
      hatch: hatchId ? resolveHatch(project, hatchId, undefined, foreground) : NO_HATCH,
      greyed,
      drawingId: d.id,
    });

  const g = d.geom;
  switch (g.shape) {
    case "line":
      seg(g.a, g.b);
      break;
    case "polyline": {
      // Geschlossene Polylinie: zuerst die gefüllte Fläche (Vollton/Schraffur).
      if (g.closed && g.pts.length > 2) fillPoly(g.pts);
      for (let i = 0; i < g.pts.length - 1; i++) seg(g.pts[i], g.pts[i + 1]);
      if (g.closed && g.pts.length > 2) seg(g.pts[g.pts.length - 1], g.pts[0]);
      break;
    }
    case "rect": {
      const c1 = g.min;
      const c2 = { x: g.max.x, y: g.min.y };
      const c3 = g.max;
      const c4 = { x: g.min.x, y: g.max.y };
      // Rechteck ist immer geschlossen → zuerst die gefüllte Fläche.
      fillPoly([c1, c2, c3, c4]);
      seg(c1, c2);
      seg(c2, c3);
      seg(c3, c4);
      seg(c4, c1);
      break;
    }
    case "circle":
      // Echtes Kreis-Primitiv → glattes `<circle>` (rund bei jedem Zoom) mit
      // optionaler Vollton-Füllung. Ersetzt die frühere 64-Ecken-Approximation.
      out.push({
        kind: "drawingCircle",
        center: g.center,
        r: g.r,
        fill: background ?? d.fillColor ?? "none",
        stroke: color,
        weightMm,
        dash,
        greyed,
        drawingId: d.id,
      });
      break;
    case "arc":
      // Echtes Bogen-Primitiv → glatter SVG-Bogenpfad (Winkel in Radiant).
      out.push({
        kind: "drawingArc",
        center: g.center,
        r: g.r,
        a0: g.a0,
        a1: g.a1,
        stroke: color,
        weightMm,
        dash,
        greyed,
        drawingId: d.id,
      });
      break;
    case "ellipse": {
      // Tessellierte Kontur (wie polyline/rect) statt eigenem SVG-Primitiv —
      // konsistent mit dem übrigen 2D-Zeichnen-Werkzeugsatz, keine eigene
      // Grip-/Snap-/Export-Sonderbehandlung nötig.
      const pts = ellipsePts(g.center, g.rx, g.ry, g.rotation);
      fillPoly(pts);
      for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length]);
      break;
    }
    case "bezier": {
      const pts = sampleBezierChain(g.pts);
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
      break;
    }
    case "spline": {
      const pts = sampleCatmullRom(g.pts, g.closed && g.pts.length > 2);
      if (g.closed && g.pts.length > 2) fillPoly(pts);
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
      if (g.closed && g.pts.length > 2) seg(pts[pts.length - 1], pts[0]);
      break;
    }
    case "text":
      out.push({
        kind: "drawingText",
        at: g.at,
        text: g.text,
        heightM: g.height,
        angle: g.angle,
        // marks.color (falls gesetzt) übersteuert die Kategorie-/Elementfarbe.
        color: g.marks?.color ?? color,
        ...(g.width && g.width > 0 ? { wrapWidth: g.width } : {}),
        ...(g.marks ? { marks: g.marks } : {}),
        ...(g.doc ? { doc: g.doc } : {}),
        greyed,
        drawingId: d.id,
      });
      break;
    case "image":
      out.push({
        kind: "drawingImage",
        min: g.min,
        max: g.max,
        src: g.src,
        opacity: g.opacity ?? 1,
        greyed,
        drawingId: d.id,
      });
      break;
    default:
      break;
  }
}
