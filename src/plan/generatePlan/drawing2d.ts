// Freie 2D-Zeichengeometrie-Domäne des Grundriss-Generators (docs/design/
// drawing-tools.md §7.2): leitet ein `Drawing2D`-Element (line/polyline/rect/
// circle/arc/text/image) in Plan-Primitive ab. Farbe/Strichstärke kommen aus
// dem optionalen LineStyle, sonst aus der Kategorie.

import type { Drawing2D, EndMark, LayerCategory, Project, Vec2 } from "../../model/types";
import {
  NO_HATCH,
  WALL_FALLBACK_MM,
  MONO_INK,
  resolveHatch,
  resolveHatchId,
  resolveStrokeWeight,
  type Primitive,
} from "./shared";
import { layersStyleSig } from "./layerSig";
import { ellipsePts, sampleBezierChain, sampleCatmullRom, sampleUniformBSpline } from "../../tools/curves";
import { scaleGeom } from "../../tools/transform";
import { bulgeArc, bulgeArcPoints } from "../../geometry/bulge";
import { END_MARK_DEFAULT_SIZE_MM, addEndMark, pullBack } from "./endMarks";
import {
  DEFAULT_SCALE_DENOMINATOR,
  DIM_DEFAULTS_MM,
  dimTextFrame,
  dimTextPos,
  mmToModel,
} from "../../model/dimension";

// ── Bemassung (SIA 400 B.5.3) ────────────────────────────────────────────────
// Modell-Meter-Konstanten für rein grafische (nicht reale) Bemassungs-Details
// — analog zu DEFAULT_TEXT_HEIGHT_M (text.ts): fest gewählt, damit sie bei der
// üblichen Plan-Massstäben (1:50…1:100) lesbar wirken, nicht dynamisch an den
// Massstab gekoppelt (wie auch die übrige Textgrösse im Plan).
// Defaults (Papier-mm) liegen in `model/dimension.ts` — geteilt mit den Griffen.

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
interface DimStyle {
  gap: number;
  overshoot: number;
  tickLen: number;
  textHeight: number;
  /** Strichstärken (Papier-mm) für Masslinie · Masshilfslinien · Massstriche. */
  lineWeightMm: number;
  extWeightMm: number;
  tickWeightMm: number;
  /** Versatz der Masszahl (entlang/quer zur Masslinie), 0/0 = Standardlage. */
  textOffset: { along: number; perp: number };
}

function addDimensionSegment(
  out: Primitive[],
  a: Vec2,
  b: Vec2,
  offset: number,
  dash: number[] | null,
  color: string,
  greyed: boolean,
  drawingId: string,
  style: DimStyle,
): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lineLen = Math.hypot(dx, dy);
  if (lineLen < 1e-6) return;
  const ux = dx / lineLen, uy = dy / lineLen; // Einheitsrichtung a→b
  const nx = -uy, ny = ux; // Links-Normale (Einheit) — Richtung des Offsets
  const sign = offset >= 0 ? 1 : -1;
  const dimA: Vec2 = { x: a.x + nx * offset, y: a.y + ny * offset };
  const dimB: Vec2 = { x: b.x + nx * offset, y: b.y + ny * offset };
  const lineAt = (from: Vec2, to: Vec2, w: number) =>
    out.push({ kind: "line", a: from, b: to, cls: "draw2d", weightMm: w, dash, color, greyed, drawingId });
  const extLine = (from: Vec2, to: Vec2) => lineAt(from, to, style.extWeightMm);
  extLine(
    { x: a.x + nx * style.gap * sign, y: a.y + ny * style.gap * sign },
    { x: dimA.x + nx * style.overshoot * sign, y: dimA.y + ny * style.overshoot * sign },
  );
  extLine(
    { x: b.x + nx * style.gap * sign, y: b.y + ny * style.gap * sign },
    { x: dimB.x + nx * style.overshoot * sign, y: dimB.y + ny * style.overshoot * sign },
  );
  lineAt(dimA, dimB, style.lineWeightMm); // die eigentliche Masslinie
  // Massstriche: 45°-Diagonale (Winkelhalbierende von Richtung/Normale), an
  // beiden Enden PARALLEL (nicht gespiegelt) — wie in SIA 400 Figur 13.
  const tx = (ux + nx) / Math.SQRT2, ty = (uy + ny) / Math.SQRT2;
  const half = style.tickLen / 2;
  const tick = (pt: Vec2) =>
    out.push({
      kind: "line",
      a: { x: pt.x - tx * half, y: pt.y - ty * half },
      b: { x: pt.x + tx * half, y: pt.y + ty * half },
      cls: "draw2d",
      weightMm: style.tickWeightMm,
      dash: null,
      color,
      greyed,
      drawingId,
    });
  tick(dimA);
  tick(dimB);
  // Masszahl: Standardlage mittig knapp über der Masslinie (nie kopfüber),
  // plus optionaler Nutzer-Versatz — Lage UND Achsen kommen aus dem geteilten
  // Helfer, damit der Masszahl-GRIFF (projectSlice) nicht auseinanderdriftet.
  const frame = dimTextFrame(a, b, offset, style.textHeight);
  const at = dimTextPos(a, b, offset, style.textHeight, style.textOffset);
  out.push({
    kind: "drawingText",
    at,
    text: formatDimLabel(lineLen),
    heightM: style.textHeight,
    angle: frame.angle,
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

// ── Detail-/Schnitt-Verweis-Symbol ───────────────────────────────────────────
const DETAILREF_RADIUS_M = 0.3; // Kreis-Radius (fixe Modell-Meter, wie „kote")
const DETAILREF_TEXT_HEIGHT_M = 0.2;
const POINTMARKER_RADIUS_M = 0.08; // Kreis-Radius (fixe Modell-Meter, wie „kote"/„detailref")
const POINTMARKER_CROSS_M = 0.12; // Kreuz-Halbarm — etwas grösser als der Kreis (ragt sichtbar heraus)

// ── Massstabsbalken ──────────────────────────────────────────────────────────
// Papier-mm (wie Bemassung/Kote) — die Balkenlänge selbst ist Modell-Meter,
// s. Kommentar am `scalebar`-Fall.
const SCALEBAR_HEIGHT_MM = 1.5;
const SCALEBAR_TICK_MM = 1;
const SCALEBAR_TEXT_MM = 3;

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


/**
 * Erzeugt die Plan-Primitive EINES 2D-Elements. Hülle um
 * {@link addDrawing2DInner}: sie stempelt am Ende die Objekt-Transparenz
 * (`Drawing2D.opacity`) auf ALLE hier entstandenen Primitive — an einer
 * Stelle statt an jeder der dutzenden Push-Stellen, und dadurch auch für
 * rekursiv erzeugte Block-Geometrie automatisch korrekt.
 */
export function addDrawing2D(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
  /**
   * Ergebnis je Drawing2D-OBJEKT wiederverwenden (s. `drawingPrimCache`). NUR
   * setzen, wenn der Aufrufer die erzeugten Primitive danach NICHT verändert
   * (`toMono` mutiert in place → dort aus).
   */
  useCache = false,
): void {
  const cacheable = useCache && CACHEABLE_SHAPES.has(d.geom.shape);
  if (cacheable) {
    const hit = drawingPrimCache.get(d);
    if (
      hit &&
      hit.lineStyles === project.lineStyles &&
      hit.hatches === project.hatches &&
      hit.layersSig === layersStyleSig(project.layers) &&
      hit.greyed === greyed &&
      hit.scaleDenominator === scaleDenominator
    ) {
      for (const p of hit.prims) out.push(p);
      return;
    }
  }
  const start = out.length;
  addDrawing2DInner(out, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator);
  const op = d.opacity;
  if (op !== undefined && op < 1) {
    const clamped = Math.max(0, op);
    for (let i = start; i < out.length; i++) {
      const p = out[i];
      // Bilder tragen bereits eine eigene Deckkraft — beide multiplizieren sich.
      out[i] =
        p.kind === "drawingImage"
          ? { ...p, opacity: p.opacity * clamped }
          : { ...p, opacity: (p.opacity ?? 1) * clamped };
    }
  }
  if (cacheable) {
    drawingPrimCache.set(d, {
      lineStyles: project.lineStyles,
      hatches: project.hatches,
      layersSig: layersStyleSig(project.layers),
      greyed,
      scaleDenominator,
      prims: out.slice(start),
    });
  }
}

/**
 * KOMPAKTER Unterlagen-Pfad (s. `Plan.underlay`): Zeichnungen, deren Primitive
 * nur aus Linien-Segmenten (plus ggf. einem Flächen-Polygon bei geschlossenen
 * Konturen) bestehen. Bei einem Kataster-Import sind das 3,7 Mio. 'line'-
 * Primitive, die sich beim Bearbeiten NIE ändern — als dauerhafte JS-Objekte
 * kosteten sie ~0,5 GB, GC-Last und bei jeder Änderung mehrere O(N)-Durchgänge.
 * Statt dessen bleiben diese Zeichnungen als `Drawing2D` und ihre Linien werden
 * nur bei Bedarf (GPU-Chunk neu zu kompilieren) kurzlebig erzeugt.
 *
 * Ausgeschlossen: Bogen-Segmente (Bulge → `drawingArc`), Linienenden (Pfeile/
 * Kreise → eigene Primitive). `line`/offene und geschlossene Polylinien sonst
 * immer.
 */
export function isCompactUnderlayEligible(d: Drawing2D): boolean {
  const g = d.geom;
  if (g.shape === "line") return !d.endMarks?.start && !d.endMarks?.end;
  if (g.shape !== "polyline") return false;
  if (d.endMarks?.start || d.endMarks?.end) return false;
  return !g.bulge || g.bulge.every((b) => !b);
}

/**
 * Wie {@link addDrawing2D}, aber OHNE die 'line'-Primitive (die liefert
 * {@link drawingLinePrims} bei Bedarf): übrig bleiben z. B. das Polygon einer
 * geschlossenen Kontur (Auswahl/Füllung/Schraffur). Gecacht je Drawing2D-Objekt.
 */
export function addDrawing2DWithoutLines(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
): void {
  const hit = withoutLinesCache.get(d);
  if (
    hit &&
    hit.lineStyles === project.lineStyles &&
    hit.hatches === project.hatches &&
    hit.layersSig === layersStyleSig(project.layers) &&
    hit.greyed === greyed &&
    hit.scaleDenominator === scaleDenominator
  ) {
    for (const p of hit.prims) out.push(p);
    return;
  }
  const tmp: Primitive[] = [];
  addDrawing2D(tmp, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator);
  const kept = tmp.filter((p) => p.kind !== "line");
  withoutLinesCache.set(d, {
    lineStyles: project.lineStyles,
    hatches: project.hatches,
    layersSig: layersStyleSig(project.layers),
    greyed,
    scaleDenominator,
    prims: kept,
  });
  for (const p of kept) out.push(p);
}
const withoutLinesCache = new WeakMap<
  Drawing2D,
  {
    lineStyles: Project["lineStyles"];
    hatches: Project["hatches"];
    layersSig: string;
    greyed: boolean;
    scaleDenominator: number;
    prims: Primitive[];
  }
>();

/** Nur die 'line'-Primitive einer Zeichnung (kurzlebig, für GPU-Chunk-Kompilierung). */
export function drawingLinePrims(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
): void {
  const tmp: Primitive[] = [];
  addDrawing2D(tmp, project, d, greyed, lwByCode, colorByCode, catByCode, scaleDenominator);
  for (const p of tmp) if (p.kind === "line") out.push(p);
}

/**
 * Cache der erzeugten Primitive je Drawing2D-OBJEKT. Projekt-Updates sind
 * immutabel mit Structural Sharing — ein unveränderte Zeichnung bleibt dasselbe
 * Objekt; ihre Primitive müssen dann nicht neu erzeugt werden (bei einem
 * Kataster-Import 128k Elemente bei JEDER Projektänderung) UND bleiben als
 * Objekte identisch, wodurch der GPU-Chunk-Cache (`glPlanChunks.ts`) ihre
 * Geometrie wiederverwendet. Der Schlüssel enthält alles, was die Ausgabe
 * ausser `d` selbst bestimmt.
 */
const drawingPrimCache = new WeakMap<
  Drawing2D,
  {
    lineStyles: Project["lineStyles"];
    hatches: Project["hatches"];
    layersSig: string;
    greyed: boolean;
    scaleDenominator: number;
    prims: Primitive[];
  }
>();

/**
 * Formen, deren Primitive nur von `d` + dem Cache-Schlüssel abhängen. `block`
 * (liest `blockDefs`, rekursiv) und `detailref` (liest `layouts`) bewusst nicht.
 */
const CACHEABLE_SHAPES: ReadonlySet<string> = new Set([
  "line",
  "polyline",
  "rect",
  "circle",
  "arc",
  "ellipse",
  "bezier",
  "spline",
  "text",
]);

function addDrawing2DInner(
  out: Primitive[],
  project: Project,
  d: Drawing2D,
  greyed: boolean,
  lwByCode: Map<string, number>,
  colorByCode: Map<string, string>,
  catByCode: Map<string, LayerCategory>,
  /**
   * Papier-Massstab (1:N) dieses Plans — nur für Bemassungs-Feinheiten, die
   * in Papier-mm angegeben sind. Default 1:100, damit bestehende Aufrufer
   * (u. a. Tests) unverändert funktionieren.
   */
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
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
  // Strichmuster des Linienstils, mit dem Objekt-Massstab gestreckt (LTSCALE).
  // Nicht-positive Werte werden ignoriert (ein Muster der Länge 0 wäre unsichtbar).
  const dashScale = d.dashScale && d.dashScale > 0 ? d.dashScale : 1;
  const rawDash = ls?.dash ?? null;
  const dash = rawDash && dashScale !== 1 ? rawDash.map((v) => v * dashScale) : rawDash;
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
   * Enden einer OFFENEN, bereits tessellierten Punktfolge zeichnen und die
   * Folge an den Enden so weit zurückziehen, wie eine gefüllte Spitze sie
   * überdeckt. Tangentenrichtung = erstes bzw. letztes Stützpunktpaar.
   */
  const withEndMarks = (pts: Vec2[]): Vec2[] => {
    if (pts.length < 2 || (!d.endMarks?.start && !d.endMarks?.end)) return pts;
    const next = [...pts];
    const dirStart = { x: next[0].x - next[1].x, y: next[0].y - next[1].y };
    const last = next.length - 1;
    const dirEnd = { x: next[last].x - next[last - 1].x, y: next[last].y - next[last - 1].y };
    next[0] = pullBack(next[0], dirStart, endMark(next[0], dirStart, d.endMarks?.start));
    next[last] = pullBack(next[last], dirEnd, endMark(next[last], dirEnd, d.endMarks?.end));
    return next;
  };

  // Ein Linienende dieser Form zeichnen (nur offene Formen rufen das auf).
  // `outward` zeigt aus der Form heraus; zurück kommt, um wie viel die Linie
  // dort verkürzt werden soll (nur bei gefüllter Spitze > 0).
  const endMark = (at: Vec2, outward: Vec2, mark: EndMark | undefined): number =>
    addEndMark(out, at, outward, mark, d.endMarks?.sizeMm ?? END_MARK_DEFAULT_SIZE_MM, scaleDenominator, {
      weightMm,
      color,
      greyed,
      drawingId: d.id,
    });

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
      hatch: hatchId
        ? resolveHatch(project, hatchId, undefined, foreground, {
            angleDeg: d.hatchAngleDeg,
            scale: d.hatchScale,
            origin: d.hatchOrigin,
          })
        : NO_HATCH,
      greyed,
      drawingId: d.id,
    });

  const g = d.geom;
  switch (g.shape) {
    case "line": {
      // Linienenden (Pfeil & Co.) an beiden Seiten; die Linie wird dort
      // verkürzt, wo eine gefüllte Spitze sie ohnehin überdeckt.
      const dA = { x: g.a.x - g.b.x, y: g.a.y - g.b.y };
      const dB = { x: g.b.x - g.a.x, y: g.b.y - g.a.y };
      const cutA = endMark(g.a, dA, d.endMarks?.start);
      const cutB = endMark(g.b, dB, d.endMarks?.end);
      seg(pullBack(g.a, dA, cutA), pullBack(g.b, dB, cutB));
      break;
    }
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
    case "ray": {
      // Wie „xline", aber NUR über `b` hinaus verlängert — `a` bleibt der
      // feste Anker (halb-unendlich statt beidseitig).
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      const ux = dx / len, uy = dy / len;
      out.push({
        kind: "line",
        a: g.a,
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
      // FÜLLUNG weiterhin über die tessellierte Kontur: Poché/Schraffur
      // brauchen ein Vieleck, ein Bogen-Primitiv trägt keine Fläche.
      // KONTUR dagegen als ECHTE Bögen (`drawingArc`) statt Geradenstücken —
      // dadurch bleibt der Bogen bei jedem Zoom rund und kommt im DXF als
      // ARC statt als Kette von LINEs an (dasselbe Primitiv, das die
      // Kreis-/Bogen-Werkzeuge schon nutzen, inkl. Auswahl + GL-Pfad).
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
      /** Ein Segment a→b: gerade als Linie, gekrümmt als echter Bogen. */
      const emitSegment = (a: Vec2, b: Vec2, bulge: number | undefined) => {
        const arc = bulge !== undefined ? bulgeArc(a, b, bulge) : null;
        if (!arc) {
          seg(a, b);
          return;
        }
        // `drawingArc` läuft per Konvention IMMER gegen den Uhrzeigersinn von
        // a0 nach a1 (s. planView/primitives.tsx). Ein im Uhrzeigersinn
        // laufender Bulge-Bogen wird daher mit vertauschten Winkeln
        // beschrieben — dieselbe Kurve, nur andersherum benannt.
        const ccw = arc.sweep >= 0;
        out.push({
          kind: "drawingArc",
          center: arc.center,
          r: arc.r,
          a0: ccw ? arc.a0 : arc.a1,
          a1: ccw ? arc.a1 : arc.a0,
          stroke: color,
          weightMm,
          dash,
          greyed,
          drawingId: d.id,
        });
      };
      // Linienenden nur an der OFFENEN Polylinie. Die Tangentenrichtung am
      // Ende folgt dem ersten/letzten Segment — bei einem BOGEN-Segment ist
      // das die Bogentangente dort, nicht die Sehne.
      const n = g.pts.length;
      const open = !(g.closed && n > 2);
      let first = g.pts[0];
      let last = g.pts[n - 1];
      if (open && n >= 2 && (d.endMarks?.start || d.endMarks?.end)) {
        const tangentAt = (i: number, atStart: boolean): Vec2 => {
          const a = g.pts[i];
          const b = g.pts[i + 1];
          const arc = bulgeArc(a, b, g.bulge?.[i] ?? 0);
          if (!arc) {
            return atStart ? { x: a.x - b.x, y: a.y - b.y } : { x: b.x - a.x, y: b.y - a.y };
          }
          // Radius am betreffenden Bogenende, um 90° gedreht = Tangente;
          // Vorzeichen so, dass sie aus der Form heraus zeigt.
          const p = atStart ? a : b;
          const rx = p.x - arc.center.x;
          const ry = p.y - arc.center.y;
          const sign = (arc.sweep >= 0 ? 1 : -1) * (atStart ? -1 : 1);
          return { x: -ry * sign, y: rx * sign };
        };
        const dirStart = tangentAt(0, true);
        const dirEnd = tangentAt(n - 2, false);
        first = pullBack(first, dirStart, endMark(first, dirStart, d.endMarks?.start));
        last = pullBack(last, dirEnd, endMark(last, dirEnd, d.endMarks?.end));
      }
      for (let i = 0; i < n - 1; i++) {
        const a = i === 0 ? first : g.pts[i];
        const b = i === n - 2 ? last : g.pts[i + 1];
        emitSegment(a, b, g.bulge?.[i]);
      }
      if (!open) {
        emitSegment(g.pts[n - 1], g.pts[0], g.bulge?.[n - 1]);
      }
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
      const pts = withEndMarks(sampleBezierChain(g.pts));
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
      break;
    }
    case "spline": {
      const closed = g.closed && g.pts.length > 2;
      const raw = g.mode === "control" ? sampleUniformBSpline(g.pts, closed) : sampleCatmullRom(g.pts, closed);
      if (closed) fillPoly(raw);
      // Enden nur an der OFFENEN Kurve (ein Ring hat keine).
      const pts = closed ? raw : withEndMarks(raw);
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
      if (closed) seg(pts[pts.length - 1], pts[0]);
      break;
    }
    case "dimension": {
      // SIA 400 B.5.3, Figur 14 (Reihenbemassung): jedes aufeinanderfolgende
      // Punktpaar der Kette ist ein eigenes Mass-Segment, alle teilen `offset`.
      for (let i = 0; i < g.pts.length - 1; i++) {
        // Papier-mm → Modell-Meter mit dem Massstab DIESES Plans.
        const mm = (v: number) => mmToModel(v, scaleDenominator);
        const offMm = g.textOffsetsMm?.[i];
        addDimensionSegment(out, g.pts[i], g.pts[i + 1], g.offset, dash, color, greyed, d.id, {
          gap: mm(g.gapMm ?? DIM_DEFAULTS_MM.gap),
          overshoot: mm(g.overshootMm ?? DIM_DEFAULTS_MM.overshoot),
          tickLen: mm(g.tickLenMm ?? DIM_DEFAULTS_MM.tickLen),
          textHeight: mm(g.textHeightMm ?? DIM_DEFAULTS_MM.textHeight),
          lineWeightMm: g.lineWeightMm ?? weightMm,
          extWeightMm: g.extWeightMm ?? weightMm,
          // Massstriche bisher fest doppelt so dick — bleibt der Default.
          tickWeightMm: g.tickWeightMm ?? weightMm * 2,
          textOffset: offMm
            ? { along: mm(offMm.along), perp: mm(offMm.perp) }
            : { along: 0, perp: 0 },
        });
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
    case "detailref": {
      // Zweigeteilte Verweisblase: Kreis + waagrechte Trennlinie, Bezeichner
      // oben, Blattname (aufgelöst über sheetLayoutId, sonst manueller
      // sheetLabel-Platzhalter) unten — fixe Modell-Meter-Grösse wie „kote".
      out.push({
        kind: "drawingCircle",
        center: g.at,
        r: DETAILREF_RADIUS_M,
        fill: "none",
        stroke: color,
        weightMm,
        dash: null,
        greyed,
        drawingId: d.id,
      });
      seg(
        { x: g.at.x - DETAILREF_RADIUS_M, y: g.at.y },
        { x: g.at.x + DETAILREF_RADIUS_M, y: g.at.y },
      );
      const sheetName = g.sheetLayoutId
        ? (project.layouts ?? []).find((l) => l.id === g.sheetLayoutId)?.name
        : undefined;
      const lowerText = sheetName ?? g.sheetLabel ?? "";
      // `drawingText` ist immer LINKS verankert (kein Zentrier-Anker ohne
      // ein volles RichTextDoc, s. `primitives.tsx` "Baseline am Ankerpunkt
      // (links)") — wie beim strukturell ähnlichen „kote" daher ein simpler
      // Links-Einzug statt echter Zentrierung.
      const textX = g.at.x - DETAILREF_RADIUS_M * 0.62;
      out.push({
        kind: "drawingText",
        at: { x: textX, y: g.at.y + DETAILREF_RADIUS_M * 0.32 },
        text: g.label,
        heightM: DETAILREF_TEXT_HEIGHT_M,
        angle: 0,
        color,
        greyed,
        drawingId: d.id,
      });
      if (lowerText) {
        out.push({
          kind: "drawingText",
          at: { x: textX, y: g.at.y - DETAILREF_RADIUS_M * 0.68 },
          text: lowerText,
          heightM: DETAILREF_TEXT_HEIGHT_M,
          angle: 0,
          color,
          greyed,
          drawingId: d.id,
        });
      }
      break;
    }
    case "scalebar": {
      // Balkenhöhe/Tick-/Textgrösse sind Papier-mm (unabhängig vom Massstab
      // lesbar, wie Bemassung/Kote) — die BALKENLÄNGE selbst ist bereits in
      // echten Modell-Metern (`g.segmentLength`) und braucht KEINE eigene
      // Umrechnung: der ganze Plan wird ohnehin im Papier-Massstab
      // abgebildet, ein 1-Meter-Segment landet dadurch automatisch in der
      // richtigen Papiergrösse.
      const barH = mmToModel(SCALEBAR_HEIGHT_MM, scaleDenominator);
      const tickLen = mmToModel(SCALEBAR_TICK_MM, scaleDenominator);
      const textH = mmToModel(SCALEBAR_TEXT_MM, scaleDenominator);
      for (let i = 0; i < g.segments; i++) {
        const x0 = g.at.x + i * g.segmentLength;
        const x1 = x0 + g.segmentLength;
        const pts: Vec2[] = [
          { x: x0, y: g.at.y },
          { x: x1, y: g.at.y },
          { x: x1, y: g.at.y + barH },
          { x: x0, y: g.at.y + barH },
        ];
        out.push({
          kind: "polygon",
          pts,
          fill: i % 2 === 0 ? color : "none",
          stroke: color,
          strokeWidthMm: weightMm,
          hatch: NO_HATCH,
          greyed,
          drawingId: d.id,
        });
      }
      // Ticks + kumulative Distanz-Beschriftung an jeder Segmentgrenze
      // (0..segments) — „m"-Einheit nur an der LETZTEN Zahl (übliche
      // Massstabsbalken-Konvention, kein „m" an jeder Zwischenzahl).
      for (let i = 0; i <= g.segments; i++) {
        const x = g.at.x + i * g.segmentLength;
        seg({ x, y: g.at.y }, { x, y: g.at.y - tickLen });
        const dist = i * g.segmentLength;
        const distText = Number.isInteger(dist) ? String(dist) : dist.toFixed(2);
        out.push({
          kind: "drawingText",
          at: { x: x + textH * 0.25, y: g.at.y - tickLen - textH * 1.2 },
          text: i === g.segments ? `${distText}m` : distText,
          heightM: textH,
          angle: 0,
          color,
          greyed,
          drawingId: d.id,
        });
      }
      break;
    }
    case "pointmarker": {
      // Kreuz-in-Kreis — fixe Modell-Meter-Grösse wie „kote"/„detailref"
      // (keine Papier-mm-Skalierung, s. Typ-Kommentar in model/types.ts).
      out.push({
        kind: "drawingCircle",
        center: g.at,
        r: POINTMARKER_RADIUS_M,
        fill: "none",
        stroke: color,
        weightMm,
        dash: null,
        greyed,
        drawingId: d.id,
      });
      seg(
        { x: g.at.x - POINTMARKER_CROSS_M, y: g.at.y },
        { x: g.at.x + POINTMARKER_CROSS_M, y: g.at.y },
      );
      seg(
        { x: g.at.x, y: g.at.y - POINTMARKER_CROSS_M },
        { x: g.at.x, y: g.at.y + POINTMARKER_CROSS_M },
      );
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
        // Hinweislinie: Spitze ist eine Eigenschaft, optional über
        // `leaderBendPoints` mehrsegmentig (Textanker → Knicke → Spitze,
        // s. Typ-Kommentar). Ohne Knickpunkte identisch zum bisherigen
        // Verhalten (EIN Segment, gefüllter Pfeil an der Spitze).
        const path = [g.at, ...(g.leaderBendPoints ?? []), g.leaderTarget];
        const tipIdx = path.length - 1;
        const dir = { x: path[tipIdx].x - path[tipIdx - 1].x, y: path[tipIdx].y - path[tipIdx - 1].y };
        const mark = d.endMarks?.end ?? "arrow";
        const cut = endMark(path[tipIdx], dir, mark);
        const tipPulled = pullBack(path[tipIdx], dir, cut);
        for (let i = 0; i < tipIdx; i++) {
          seg(path[i], i === tipIdx - 1 ? tipPulled : path[i + 1]);
        }
      }
      break;
    case "block": {
      // Block-Instanz trägt selbst keine Geometrie: Definition nachschlagen,
      // jede Teilgeometrie per `scaleGeom` (Skalierung um den Ursprung, dann
      // Rotation, dann Verschiebung um `at` — Standard-TRS-Reihenfolge)
      // transformieren und REKURSIV über denselben Renderpfad ausgeben — eine
      // synthetische Drawing2D-Hülle mit derselben Ebene/Kategorie/
      // Farb-Overrides wie die Instanz selbst (Sub-Elemente tragen in v1 keinen
      // eigenen Stil). Unbekannte/gelöschte `blockDefId` ⇒ nichts rendern.
      const def = project.blockDefs?.find((b) => b.id === g.blockDefId);
      if (!def) break;
      const scl = g.scale ?? 1;
      const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
      const xf = (p: Vec2): Vec2 => ({
        x: g.at.x + (p.x * scl) * c - (p.y * scl) * s,
        y: g.at.y + (p.x * scl) * s + (p.y * scl) * c,
      });
      for (const sub of def.geom2d) {
        addDrawing2D(
          out,
          project,
          { ...d, geom: scaleGeom(sub, xf, scl) },
          greyed,
          lwByCode,
          colorByCode,
          catByCode,
          scaleDenominator,
        );
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
