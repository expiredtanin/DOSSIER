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
import { mvGeom } from "../../tools/transform";
import { bulgeArcPoints } from "../../geometry/bulge";

// ── Bemassung (SIA 400 B.5.3) ────────────────────────────────────────────────
// Modell-Meter-Konstanten für rein grafische (nicht reale) Bemassungs-Details
// — analog zu DEFAULT_TEXT_HEIGHT_M (text.ts): fest gewählt, damit sie bei der
// üblichen Plan-Massstäben (1:50…1:100) lesbar wirken, nicht dynamisch an den
// Massstab gekoppelt (wie auch die übrige Textgrösse im Plan).
const DIM_GAP_M = 0.05; // Abstand Masshilfslinie → bemessener Punkt
const DIM_OVERSHOOT_M = 0.05; // Überstand der Masshilfslinie über die Masslinie hinaus
const DIM_TICK_LEN_M = 0.15; // Länge des Massstrichs (Diagonale an den Masslinien-Enden)
const DIM_TEXT_HEIGHT_M = 0.2; // Schrifthöhe der Masszahl

/** Formatiert eine Länge (Meter) als Masszahl: 2 Dezimalstellen (SIA 400 B.5.2/B.5.4, „3.25"/„518.60"). */
function formatDimLabel(m: number): string {
  return m.toFixed(2);
}

/**
 * Ein einzelnes Mass-Segment (Masshilfslinien + Masslinie + Massstriche +
 * Masszahl) zwischen `a` und `b` bei gegebenem `offset` — s. `formatDimLabel`.
 * Extrahiert, damit eine Masskette (`shape:"dimension"`, `pts.length` ≥ 2)
 * je aufeinanderfolgendem Punktpaar dasselbe Rendering wiederverwenden kann.
 */
function addDimensionSegment(
  out: Primitive[],
  a: Vec2,
  b: Vec2,
  offset: number,
  weightMm: number,
  dash: number[] | null,
  color: string,
  greyed: boolean,
  drawingId: string,
): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lineLen = Math.hypot(dx, dy);
  if (lineLen < 1e-6) return;
  const ux = dx / lineLen, uy = dy / lineLen; // Einheitsrichtung a→b
  const nx = -uy, ny = ux; // Links-Normale (Einheit) — Richtung des Offsets
  const sign = offset >= 0 ? 1 : -1;
  const dimA: Vec2 = { x: a.x + nx * offset, y: a.y + ny * offset };
  const dimB: Vec2 = { x: b.x + nx * offset, y: b.y + ny * offset };
  const extLine = (from: Vec2, to: Vec2) =>
    out.push({ kind: "line", a: from, b: to, cls: "draw2d", weightMm, dash, color, greyed, drawingId });
  extLine(
    { x: a.x + nx * DIM_GAP_M * sign, y: a.y + ny * DIM_GAP_M * sign },
    { x: dimA.x + nx * DIM_OVERSHOOT_M * sign, y: dimA.y + ny * DIM_OVERSHOOT_M * sign },
  );
  extLine(
    { x: b.x + nx * DIM_GAP_M * sign, y: b.y + ny * DIM_GAP_M * sign },
    { x: dimB.x + nx * DIM_OVERSHOOT_M * sign, y: dimB.y + ny * DIM_OVERSHOOT_M * sign },
  );
  extLine(dimA, dimB);
  // Massstriche: 45°-Diagonale (Winkelhalbierende von Richtung/Normale), an
  // beiden Enden PARALLEL (nicht gespiegelt) — wie in SIA 400 Figur 13.
  const tx = (ux + nx) / Math.SQRT2, ty = (uy + ny) / Math.SQRT2;
  const half = DIM_TICK_LEN_M / 2;
  const tick = (pt: Vec2) =>
    out.push({
      kind: "line",
      a: { x: pt.x - tx * half, y: pt.y - ty * half },
      b: { x: pt.x + tx * half, y: pt.y + ty * half },
      cls: "draw2d",
      weightMm: weightMm * 2,
      dash: null,
      color,
      greyed,
      drawingId,
    });
  tick(dimA);
  tick(dimB);
  // Masszahl: Mitte der Masslinie, leicht abgesetzt, nie kopfüber lesbar.
  let angle = Math.atan2(dy, dx);
  if (Math.cos(angle) < 0) angle += Math.PI;
  const upx = -Math.sin(angle), upy = Math.cos(angle); // Links-Normale der ENDGÜLTIGEN Richtung
  const mid: Vec2 = { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 };
  out.push({
    kind: "drawingText",
    at: { x: mid.x + upx * DIM_TEXT_HEIGHT_M * 0.6, y: mid.y + upy * DIM_TEXT_HEIGHT_M * 0.6 },
    text: formatDimLabel(lineLen),
    heightM: DIM_TEXT_HEIGHT_M,
    angle,
    color,
    greyed,
    drawingId,
  });
}

// ── Höhenkote (SIA 400 B.5.4) ────────────────────────────────────────────────
const KOTE_TRI_SIZE_M = 0.15; // Dreieck-Grösse (Spitze bis Basis)
const KOTE_TRI_HALF_W_M = KOTE_TRI_SIZE_M * 0.6;
const KOTE_TEXT_HEIGHT_M = 0.2;
const KOTE_TEXT_GAP_M = 0.08; // Abstand Dreieck-Basis → Zahl

/** Formatiert einen Höhenwert (SIA 400 B.5.4, Figur 18): „+3.25" · „±0.00" · „-0.10". */
function formatKoteLabel(value: number): string {
  if (Math.abs(value) < 1e-6) return "±0.00";
  return (value > 0 ? "+" : "") + value.toFixed(2);
}

// ── Konstruktionslinie (Hilfslinie) ─────────────────────────────────────────
const XLINE_EXTEND_M = 1000; // Verlängerung über a/b hinaus je Richtung
const XLINE_WEIGHT_MM = 0.13; // dünnste übliche Linienstärke (nie dicker als das Objekt)
const XLINE_DASH: number[] = [0.3, 0.1, 0.03, 0.1]; // Strich-Punkt (CAD-Mittellinien-Konvention)

// ── Leader (Vorführungspfeil) ────────────────────────────────────────────────
const LEADER_ARROW_LEN_M = 0.12;
const LEADER_ARROW_HALF_W_M = 0.045;

/** Dünne Linie `from`→`to` + gefüllte Pfeilspitze bei `to` (Ziel des Leaders). */
function addLeaderLine(
  out: Primitive[],
  from: Vec2,
  to: Vec2,
  weightMm: number,
  color: string,
  greyed: boolean,
  drawingId: string,
): void {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const base: Vec2 = { x: to.x - ux * LEADER_ARROW_LEN_M, y: to.y - uy * LEADER_ARROW_LEN_M };
  out.push({ kind: "line", a: from, b: base, cls: "draw2d", weightMm, dash: null, color, greyed, drawingId });
  out.push({
    kind: "polygon",
    pts: [
      to,
      { x: base.x + nx * LEADER_ARROW_HALF_W_M, y: base.y + ny * LEADER_ARROW_HALF_W_M },
      { x: base.x - nx * LEADER_ARROW_HALF_W_M, y: base.y - ny * LEADER_ARROW_HALF_W_M },
    ],
    fill: color,
    stroke: color,
    strokeWidthMm: weightMm,
    hatch: NO_HATCH,
    greyed,
    drawingId,
  });
}

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
    case "xline": {
      // Konstruktionslinie: weit über a/b hinaus verlängert (wirkt unendlich),
      // immer im Strich-Punkt-Muster gezeichnet (überstimmt den LineStyle-
      // Strich — Erkennbarkeit als Hilfslinie hat Vorrang vor Objektstil).
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      const ux = dx / len, uy = dy / len;
      out.push({
        kind: "line",
        a: { x: g.a.x - ux * XLINE_EXTEND_M, y: g.a.y - uy * XLINE_EXTEND_M },
        b: { x: g.b.x + ux * XLINE_EXTEND_M, y: g.b.y + uy * XLINE_EXTEND_M },
        cls: "draw2d",
        weightMm: Math.min(weightMm, XLINE_WEIGHT_MM),
        dash: XLINE_DASH,
        color,
        greyed,
        drawingId: d.id,
      });
      break;
    }
    case "polyline": {
      // Bogen-Segmente (`bulge`, DXF-Konvention) zu Geradenstücken tessellieren
      // — ohne `bulge` liefert `bulgeArcPoints` exakt `[a,b]`, das Ergebnis ist
      // dann bitgleich zum alten reinen Geradenzug (kein Sonderpfad nötig).
      const ring: Vec2[] = [g.pts[0]];
      for (let i = 0; i < g.pts.length - 1; i++) {
        const sub = bulgeArcPoints(g.pts[i], g.pts[i + 1], g.bulge?.[i]);
        for (let k = 1; k < sub.length; k++) ring.push(sub[k]);
      }
      if (g.closed && g.pts.length > 2) {
        const sub = bulgeArcPoints(g.pts[g.pts.length - 1], g.pts[0], g.bulge?.[g.pts.length - 1]);
        for (let k = 1; k < sub.length; k++) ring.push(sub[k]);
        // Letzter Punkt dupliziert ring[0] (Schliess-Segment endet dort) — für
        // die Füllfläche nicht nötig, das SVG-`<polygon>` schliesst implizit.
        fillPoly(ring.slice(0, -1));
      }
      for (let i = 0; i < ring.length - 1; i++) seg(ring[i], ring[i + 1]);
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
    case "dimension": {
      // SIA 400 B.5.3, Figur 14 (Reihenbemassung): jedes aufeinanderfolgende
      // Punktpaar der Kette ist ein eigenes Mass-Segment, alle teilen `offset`.
      for (let i = 0; i < g.pts.length - 1; i++) {
        addDimensionSegment(out, g.pts[i], g.pts[i + 1], g.offset, weightMm, dash, color, greyed, d.id);
      }
      break;
    }
    case "kote": {
      // SIA 400 B.5.4/Figur 18: OK = Spitze nach unten, UK = Spitze nach oben;
      // fertig = Kontur (hohl), roh = voll gefüllt. `at` ist die Spitze.
      const up = g.kind === "okFertig" || g.kind === "okRoh" ? 1 : -1;
      const filled = g.kind === "okRoh" || g.kind === "ukRoh";
      const pts: Vec2[] = [
        g.at,
        { x: g.at.x - KOTE_TRI_HALF_W_M, y: g.at.y + up * KOTE_TRI_SIZE_M },
        { x: g.at.x + KOTE_TRI_HALF_W_M, y: g.at.y + up * KOTE_TRI_SIZE_M },
      ];
      out.push({
        kind: "polygon",
        pts,
        fill: filled ? color : "none",
        stroke: color,
        strokeWidthMm: weightMm,
        hatch: NO_HATCH,
        greyed,
        drawingId: d.id,
      });
      out.push({
        kind: "drawingText",
        at: { x: g.at.x + KOTE_TRI_HALF_W_M + KOTE_TEXT_GAP_M, y: g.at.y + up * KOTE_TRI_SIZE_M * 0.5 },
        text: formatKoteLabel(g.value),
        heightM: KOTE_TEXT_HEIGHT_M,
        angle: 0,
        color,
        greyed,
        drawingId: d.id,
      });
      break;
    }
    case "text":
      if (g.pathPts && g.pathPts.length >= 2) {
        // Text-entlang-Pfad: eigener Primitive-Typ (echtes SVG textPath),
        // Rich-Doc/marks/Leader bewusst ignoriert (v1 nur schlichter String).
        out.push({
          kind: "drawingTextPath",
          pathPts: g.pathPts,
          text: g.text,
          heightM: g.height,
          color: g.marks?.color ?? color,
          greyed,
          drawingId: d.id,
        });
        break;
      }
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
      if (g.leaderTarget) {
        addLeaderLine(out, g.at, g.leaderTarget, weightMm, color, greyed, d.id);
      }
      break;
    case "block": {
      // Block-Instanz trägt selbst keine Geometrie: Definition nachschlagen,
      // jede Teilgeometrie per `mvGeom` (Rotation um den Ursprung + Verschiebung
      // um `at`) transformieren und REKURSIV über denselben Renderpfad ausgeben
      // — eine synthetische Drawing2D-Hülle mit derselben Ebene/Kategorie/
      // Farb-Overrides wie die Instanz selbst (Sub-Elemente tragen in v1 keinen
      // eigenen Stil). Unbekannte/gelöschte `blockDefId` ⇒ nichts rendern.
      const def = project.blockDefs?.find((b) => b.id === g.blockDefId);
      if (!def) break;
      const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
      const xf = (p: Vec2): Vec2 => ({
        x: g.at.x + p.x * c - p.y * s,
        y: g.at.y + p.x * s + p.y * c,
      });
      for (const sub of def.geom2d) {
        addDrawing2D(out, project, { ...d, geom: mvGeom(sub, xf) }, greyed, lwByCode, colorByCode, catByCode);
      }
      break;
    }
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
