// Flacht einen {@link Plan} (die eine Wahrheit aus generatePlan) auf das
// GPU-nahe Szenenformat des nativen render2d-Renderers ab: Füllpolygone,
// Umrisse, Linien und Textzeilen. Text wird zeilenweise geflacht (Rich-Text-Doc
// + Live-Zusatzzeilen) — die echten Glyphen rastert der Rust-Renderer über
// einen GPU-Glyphen-Atlas (glyphon/cosmic-text), keine Vektor-Ersatzschrift.
//
// Das erzeugte Objekt matcht 1:1 die serde-Structs render2d::types::Scene
// { fills:[{pts,color}], outlines:[{pts,color,widthMm,dash}],
//   polylines:[{pts,color,widthMm,dash}], arcs:[{center,from,to,r,color,widthMm,dash}],
//   lines:[{a,b,color,widthMm,dash}], texts:[{pos,content,sizeMm,color,align}] }
// mit Point = [x,y] (Meter) und Rgba = [r,g,b,a] (0..1).
//
// Bögen werden NICHT hier tessellliert: der Rust-Renderer zeichnet sie
// mathematisch exakt per SDF-Fragment-Shader (`shaders::ARC_WGSL`, eine
// analytische Instanz je Bogen) — bei jeder Vergrößerung ein echter Kreis statt
// eines Vielecks, ohne Neu-Tessellierung. Strichmuster
// (`dash`, mm Papier) werden ebenfalls unverändert durchgereicht — das geometrische
// Zerschneiden in Teilstücke (`applyDashRuns`-Algorithmus) passiert erst NACH der
// Bogen-Tessellierung in Rust (`tessellate::split_dash`), damit die Phase über die
// gesamte (ggf. verkettete oder adaptiv tessellierte) Strecke durchläuft.

import type { Plan, Primitive } from "./generatePlan";
import { applyDashRuns, buildHatchRuns } from "./glPlan/glPlanHatch";
import { docToLines } from "../text/renderHtml";

type LinePrim = Extract<Primitive, { kind: "line" }>;

export type RPoint = [number, number];
export type RRgba = [number, number, number, number];

export interface RFill {
  pts: RPoint[];
  color: RRgba;
  /**
   * Maler-Reihenfolge (kleiner = früher/unten). Der SVG-Pfad zeichnet die
   * Primitive strikt in Array-Reihenfolge (Füllung/Schraffur/Umriss
   * interleaved) — eine spätere Wand-Poché deckt z. B. den früheren
   * Raum-Umriss ab. Der native Renderer (`compile_scene`) stellt diese
   * Reihenfolge über die getrennten Szenen-Arrays hinweg wieder her.
   */
  z: number;
}
export interface ROutline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
}
export interface RPolyline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
  /**
   * true: `widthMm` trägt BILDSCHIRM-Einheiten (viewBox-px, zoom-skalierend)
   * statt Papier-mm. Aktuell von keinem Primitiv mehr gesetzt — auch die
   * Schraffur läuft inzwischen als gewöhnlicher Papier-mm-Stift (0.02 mm,
   * gleiche Tinte wie die Wand-Schichtfugen). Feld bleibt für etwaige
   * zukünftige Bildschirm-gekoppelte Linien erhalten.
   */
  widthScreen?: boolean;
}
export interface RArc {
  center: RPoint;
  from: RPoint;
  to: RPoint;
  r: number;
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
}
export interface RLine {
  a: RPoint;
  b: RPoint;
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
}
export type RTextAlign = "left" | "center" | "right";
/** EINE Textzeile; serde-kompatibel zu render2d::types::Text. */
export interface RText {
  /** Anker in Modell-Metern: X gemäß align, Y = Baseline der Zeile. */
  pos: RPoint;
  content: string;
  /** Schriftgröße in echten Papier-mm (skaliert mit Zoom wie Strichbreiten). */
  sizeMm: number;
  color: RRgba;
  align: RTextAlign;
}
/** Achsenparalleler Rahmen der Plan-Geometrie in Modell-Metern (siehe Plan.bounds). */
export interface RBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface RScene {
  fills: RFill[];
  outlines: ROutline[];
  polylines: RPolyline[];
  arcs: RArc[];
  lines: RLine[];
  texts: RText[];
  /**
   * Plan-Bounds (Modell-Meter) — additiv aus `Plan.bounds` übernommen, damit
   * Verbraucher (z. B. der Vektor-PDF-Serializer `sceneToPrintSvg.ts`) den
   * Plan-Inhalt zentrieren können, OHNE zusätzlich den `Plan` selbst zu
   * benötigen. Unbekannt für den Rust-Renderer (serde ignoriert überzählige
   * Felder ohne `deny_unknown_fields`), also rückwirkungsfrei fürs GPU-Backend.
   */
  bounds: RBounds;
}

const DEFAULT_LINE = "#1a1a1a";

/**
 * Strichfarben/-deckkraft je CSS-Klasse — Spiegel der `.plan-svg .<cls>`-Regeln
 * in styles.css: Im SVG-Pfad ÜBERSTIMMT eine CSS-`stroke`-Property das inline
 * gesetzte `stroke`-Attribut (Präsentationsattribut), d. h. für diese Klassen
 * gilt IMMER die CSS-Farbe. Klassen ohne CSS-`stroke` (draw2d, stair-*,
 * context-line) behalten die Modell-Farbe; context-line trägt zusätzlich
 * `opacity: 0.7`, wall-axis `opacity: 0.85`.
 */
const CLS_STROKE: Record<string, string> = {
  "door-leaf": "#1a1a1a",
  "door-swing": "#1a1a1a",
  "door-frame": "#1a1a1a",
  "window-glass": "#1a1a1a",
  "wall-axis": "#2f5d54", // var(--accent) des hellen Standard-Themes
};
const CLS_OPACITY: Record<string, number> = {
  "wall-axis": 0.85,
  "context-line": 0.7,
};

/** Deckkraft gedimmter (greyed) Primitive — wie GREYED_OPACITY in PlanView. */
const GREYED_ALPHA = 0.3;

/** Farbe mit Klassen-Deckkraft und Greyed-Dimmung multiplizieren. */
function withOpacity(col: RRgba, cls: string | undefined, greyed: boolean | undefined): RRgba {
  const o = (cls ? CLS_OPACITY[cls] ?? 1 : 1) * (greyed ? GREYED_ALPHA : 1);
  return o === 1 ? col : [col[0], col[1], col[2], col[3] * o];
}

/** Strichfarbe einer line/arc-Primitive: CSS-Klassen-Farbe > Modell-Farbe > Tinte. */
function strokeColorFor(cls: string | undefined, color: string | undefined): RRgba {
  const css = cls ? CLS_STROKE[cls] : undefined;
  return toRgba(css ?? color ?? DEFAULT_LINE, 1) ?? [0.1, 0.1, 0.1, 1];
}

/** 1 Punkt (pt) in Papier-Millimetern. */
const PT_TO_MM = 25.4 / 72;
/**
 * Default-Referenzmaßstab (1:100) für Aufrufer ohne Massstabskontext (WASM-
 * Viewport, `nativeSync.ts`) — identisch zu PlanView (`nRef`) im Display-
 * Modus: dort belegt 1 pt Schrift (1/72)·0.0254·100 Modell-Meter. Der native
 * Renderer rechnet im Anzeigemodus mit `paper_scale_n = 100`, damit ist
 * `sizeMm = pt · PT_TO_MM` exakt die Browser-Darstellung. Für Aufrufer MIT
 * Massstabskontext (z. B. PDF-Export) übersteuert `planToRenderScene`s
 * `paperScaleN`-Parameter diesen Default — siehe `mmToM` dort.
 */
const STAMP_DEFAULT_N = 100;

/** Wenige benannte Farben, die in Klassen/Defaults vorkommen können. */
const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  none: "none",
  transparent: "none",
};

/** Hex/Named-Farbe → [r,g,b,a] in 0..1, oder null bei "none"/leer. */
function toRgba(input: string | undefined, alpha = 1): RRgba | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  if (h === "none" || h === "transparent") return null;
  if (h[0] !== "#") {
    const mapped = NAMED[h];
    if (!mapped) return [0, 0, 0, alpha];
    if (mapped === "none") return null;
    h = mapped;
  }
  h = h.slice(1);
  // Kurzformen auf Langform expandieren (#rgb → #rrggbb, #rgba → #rrggbbaa).
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return [0, 0, 0, alpha];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // 8-stelliges Hex trägt den Alpha-Kanal selbst; sonst der Parameter.
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : alpha;
  if (![r, g, b, a].every((v) => Number.isFinite(v))) return [0, 0, 0, alpha];
  return [r, g, b, a];
}

/** Zwei Modell-Punkte (Meter) als gleich behandeln (Verkettungs-Toleranz). */
function samePt(a: RPoint, b: RPoint): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/** Gleicher Linienstil (für das Verketten aufeinanderfolgender 2D-Zeichenlinien). */
function sameLineStyle(a: LinePrim, b: LinePrim): boolean {
  return (
    a.cls === b.cls &&
    a.weightMm === b.weightMm &&
    (a.color ?? "") === (b.color ?? "") &&
    JSON.stringify(a.dash ?? null) === JSON.stringify(b.dash ?? null)
  );
}

/**
 * Zerlegt einen Polygon-Ring in zusammenhängende Läufe SICHTBARER Kanten (die
 * `noStroke`-Kanten werden ausgelassen). Jeder Lauf beginnt an einer sichtbaren
 * Kante, deren Vorgänger unterdrückt ist. Portiert aus PlanView.visibleEdgeRuns —
 * so bekommen die inneren Ecken eine Gehrung statt Stumpfkappen.
 */
function visibleEdgeRuns(pts: RPoint[], noStroke: number[]): RPoint[][] {
  const n = pts.length;
  const skip = new Set(noStroke.map((i) => ((i % n) + n) % n));
  if (skip.size >= n || n < 2) return [];
  const visible = (i: number) => !skip.has(((i % n) + n) % n);
  const runs: RPoint[][] = [];
  for (let s = 0; s < n; s++) {
    if (!visible(s) || visible(s - 1 + n)) continue; // kein Lauf-Anfang
    const run: RPoint[] = [pts[s]];
    let j = s;
    while (visible(j) && j - s < n) {
      run.push(pts[(j + 1) % n]);
      j++;
    }
    runs.push(run);
  }
  return runs;
}

/**
 * Näht sichtbare Kantenläufe ÜBER Polygon-Grenzen hinweg zusammen: Läufe mit
 * koinzidenten Endpunkten (und GENAU zwei beteiligten Enden — T-Stösse bleiben
 * unangetastet) werden zu einer Kette verbunden, ggf. mit Richtungsumkehr.
 * Schliesst sich eine Kette, wird sie als geschlossener Ring markiert. So
 * bekommt eine Wandecke, deren zwei Schenkel aus VERSCHIEDENEN Wand-Polygonen
 * stammen, dieselbe Gehrung wie die inneren Ecken eines einzelnen Laufs
 * (statt zweier Stumpfkappen, die eine Kerbe bilden).
 */
function stitchRuns(runs: RPoint[][]): { pts: RPoint[]; closed: boolean }[] {
  const eps = 1e-5;
  const key = (p: RPoint) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  // Endpunkt-Belegung zählen: verkettet wird nur, wo genau ZWEI Enden liegen.
  const endCount = new Map<string, number>();
  for (const r of runs) {
    for (const p of [r[0], r[r.length - 1]]) {
      endCount.set(key(p), (endCount.get(key(p)) ?? 0) + 1);
    }
  }
  const joinable = (p: RPoint) => endCount.get(key(p)) === 2;

  const pool = runs.map((pts) => ({ pts, used: false }));
  const out: { pts: RPoint[]; closed: boolean }[] = [];
  for (const seed of pool) {
    if (seed.used) continue;
    seed.used = true;
    let chain = seed.pts;
    let extended = true;
    while (extended && !(chain.length > 2 && samePt(chain[0], chain[chain.length - 1]))) {
      extended = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (const cand of pool) {
        if (cand.used) continue;
        const cs = cand.pts[0];
        const ce = cand.pts[cand.pts.length - 1];
        if (joinable(tail) && samePt(tail, cs)) {
          chain = chain.concat(cand.pts.slice(1));
        } else if (joinable(tail) && samePt(tail, ce)) {
          chain = chain.concat([...cand.pts].reverse().slice(1));
        } else if (joinable(head) && samePt(head, ce)) {
          chain = cand.pts.concat(chain.slice(1));
        } else if (joinable(head) && samePt(head, cs)) {
          chain = [...cand.pts].reverse().concat(chain.slice(1));
        } else {
          continue;
        }
        cand.used = true;
        extended = true;
        break;
      }
    }
    const closed = chain.length > 3 && samePt(chain[0], chain[chain.length - 1]);
    out.push({ pts: closed ? chain.slice(0, -1) : chain, closed });
  }
  return out;
}

/**
 * Wandelt einen Plan in eine native render2d-Szene um. Zusammenhängende Umriss-
 * und Zeichnungskanten werden zu OFFENEN Polylinien verkettet (gehrte Ecken);
 * nur genuin einzelne Segmente (Türblätter, Referenzlinien) bleiben `lines`.
 *
 * `paperScaleN` ist der Massstab-Nenner N (1:N), mit dem die vertikale
 * Zeilenposition mehrzeiliger Stempel-Texte in Modell-Meter umgerechnet wird
 * (Papier-mm sind massstabsunabhängig, ihre Weltgrösse aber nicht — analog zu
 * PlanViews `nRef`, s. `PlanView.tsx` case "text"). Default 100 für Aufrufer
 * ohne Massstabskontext (WASM-Viewport, `nativeSync.ts`).
 */
export function planToRenderScene(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): RScene {
  const mmToM = paperScaleN / 1000; // Papier-mm → Modell-Meter beim gewählten Massstab.
  const fills: RFill[] = [];
  const outlines: ROutline[] = [];
  const polylines: RPolyline[] = [];
  const arcs: RArc[] = [];
  const lines: RLine[] = [];
  const texts: RText[] = [];

  // Sichtbare Umriss-Läufe werden erst GESAMMELT (nach Stil gruppiert) und am
  // Ende über Polygon-Grenzen hinweg zusammengenäht — erst dadurch bekommen
  // Wand-zu-Wand-Ecken (zwei Polygone!) eine Gehrung statt einer Kerbe.
  const edgeRunGroups = new Map<string, { color: RRgba; widthMm: number; runs: RPoint[][]; z: number }>();
  const collectEdgeRun = (run: RPoint[], color: RRgba, widthMm: number, z: number) => {
    const k = `${color.join(",")}|${widthMm}`;
    let g = edgeRunGroups.get(k);
    if (!g) {
      g = { color, widthMm, runs: [], z };
      edgeRunGroups.set(k, g);
    }
    g.runs.push(run);
    // Die Kette zeichnet, wenn ihr SPÄTESTER Beitrag im SVG zeichnen würde.
    g.z = Math.max(g.z, z);
  };

  // Maler-Reihenfolge: läuft in EXAKT der Reihenfolge mit, in der der SVG-Pfad
  // die Elemente zeichnet (Primitive in Array-Reihenfolge; je Polygon Füllung →
  // Schraffur → Umriss). Jedes emittierte Szenen-Element bekommt das nächste z.
  let zc = 0;

  // Laufender, verketteter 2D-Zeichnungs-Zug (gleiche drawingId + Stil, End-an-Start).
  let curPts: RPoint[] | null = null;
  let curSrc: LinePrim | null = null;
  const flushRun = () => {
    if (curPts && curSrc && curPts.length >= 2) {
      const col = withOpacity(strokeColorFor(curSrc.cls, curSrc.color), curSrc.cls, curSrc.greyed);
      const closed = curPts.length > 2 && samePt(curPts[0], curPts[curPts.length - 1]);
      const dash = curSrc.dash ?? null;
      if (closed) {
        outlines.push({ pts: curPts.slice(0, -1), color: col, widthMm: curSrc.weightMm, dash, z: zc++ });
      } else {
        polylines.push({ pts: curPts, color: col, widthMm: curSrc.weightMm, dash, z: zc++ });
      }
    }
    curPts = null;
    curSrc = null;
  };

  for (const p of plan.primitives) {
    if (p.kind === "polygon") {
      flushRun();
      const pts: RPoint[] = p.pts.map((v) => [v.x, v.y]);
      if (pts.length < 2) continue;

      // Füllung
      const fillCol = toRgba(p.fill, 1);
      if (fillCol && pts.length >= 3) {
        fills.push({ pts, color: withOpacity(fillCol, undefined, p.greyed), z: zc++ });
      }

      // Schraffur: die aufs Polygon geclippten Musterlinien wie im Browser
      // (glPlanHatch — identische Geometrie), als Polylinien. "none"/"solid"
      // brauchen keine Linien (solid deckt die Füllung farbig ab).
      if (p.hatch && p.hatch.pattern !== "none" && p.hatch.pattern !== "solid") {
        const hatchCol = withOpacity(
          toRgba(p.hatch.color, 1) ?? [0.1, 0.1, 0.1, 1],
          undefined,
          p.greyed,
        );
        // Strichbreite: ein GEWÖHNLICHER Papier-mm-Stift (0.02 mm), wie jede
        // andere Linie — nicht mehr an die Musterkachel/Bildschirm-px
        // gekoppelt (siehe RPolyline.widthScreen-Kommentar).
        const hatchMm = p.hatch.lineWeight > 0 ? p.hatch.lineWeight : 0.13;
        const runs = applyDashRuns(buildHatchRuns(p.pts, p.hatch), p.hatch.dash);
        // Alle Musterläufe eines Polygons teilen EIN z (überlappen einander nicht).
        const hatchZ = zc++;
        for (const run of runs) {
          if (run.length >= 2) {
            polylines.push({
              pts: run.map((v) => [v.x, v.y]),
              color: hatchCol,
              widthMm: hatchMm,
              z: hatchZ,
            });
          }
        }
      }

      // Umriss
      const strokeColRaw = toRgba(p.stroke, 1);
      if (strokeColRaw && p.strokeWidthMm > 0) {
        const strokeCol = withOpacity(strokeColRaw, undefined, p.greyed);
        const suppressed = p.noStrokeEdges ?? [];
        if (suppressed.length === 0) {
          // Ganzer Ring → geschlossener, gehrter Umriss.
          outlines.push({ pts, color: strokeCol, widthMm: p.strokeWidthMm, z: zc++ });
        } else {
          // Nur die sichtbaren Kanten — sammeln, die Naht ans Ende verschoben.
          const runZ = zc++;
          for (const run of visibleEdgeRuns(pts, suppressed)) {
            collectEdgeRun(run, strokeCol, p.strokeWidthMm, runZ);
          }
        }
      }
    } else if (p.kind === "line") {
      if (p.drawingId) {
        // Aufeinanderfolgende 2D-Zeichenlinien gleicher drawingId/Stil verketten.
        const a: RPoint = [p.a.x, p.a.y];
        const b: RPoint = [p.b.x, p.b.y];
        if (curPts && curSrc && sameLineStyle(curSrc, p) && samePt(curPts[curPts.length - 1], a)) {
          curPts.push(b);
        } else {
          flushRun();
          curPts = [a, b];
          curSrc = p;
        }
      } else {
        // Genuin einzelnes Segment (Türblatt, Referenzlinie, Symbol) → Stumpfkappen ok.
        flushRun();
        const col = withOpacity(strokeColorFor(p.cls, p.color), p.cls, p.greyed);
        lines.push({ a: [p.a.x, p.a.y], b: [p.b.x, p.b.y], color: col, widthMm: p.weightMm, dash: p.dash ?? null, z: zc++ });
      }
    } else if (p.kind === "arc") {
      flushRun();
      // Farbe wie im SVG: CSS-Klassen-Regel (z. B. .door-swing → #1a1a1a).
      const col = withOpacity(strokeColorFor(p.cls, undefined), p.cls, p.greyed);
      // Bogen unvortessellliert an Rust übergeben (`RArc`) — die exakte runde
      // Darstellung (analytischer SDF-Shader, `ARC_WGSL`) und ein evtl. Strich-
      // muster übernimmt der native Renderer (`compile_scene`) drüben.
      arcs.push({
        center: [p.center.x, p.center.y],
        from: [p.from.x, p.from.y],
        to: [p.to.x, p.to.y],
        r: p.r,
        color: col,
        widthMm: p.weightMm,
        dash: p.dash ?? null,
      });
    } else {
      // "text": zeilenweise flachen — die ECHTEN Glyphen rastert der Rust-
      // Renderer über einen GPU-Glyphen-Atlas (glyphon, dieselbe Font-Familie
      // wie im Browser). Layout identisch zum SVG-Pfad in PlanView (case
      // "text"): Rich-Text-Zeilen + Live-Zusatzzeilen, Block vertikal um den
      // Anker zentriert, Zeilenvorschub 1.3·Basisgröße.
      flushRun();
      const defCol = withOpacity(toRgba(p.color, 1) ?? [0.1, 0.1, 0.1, 1], undefined, p.greyed);
      // unitPerPt = PT_TO_MM → tspan.fontSize ist direkt die Papier-mm-Größe.
      const docLines = docToLines(p.doc, {
        x: 0,
        y: 0,
        lineHeight: 0,
        unitPerPt: PT_TO_MM,
        basePt: p.basePt,
        color: p.color,
      });
      const baseMm = p.basePt * PT_TO_MM;
      const flat: { content: string; sizeMm: number; color: RRgba; align: RTextAlign }[] = [];
      for (const line of docLines) {
        flat.push({
          // Runs einer Zeile werden zusammengelegt (ein Buffer je Zeile);
          // Größe/Farbe des größten bzw. ersten Runs gelten für die Zeile.
          content: line.tspans.map((t) => t.text).join(""),
          sizeMm: line.tspans.length
            ? Math.max(...line.tspans.map((t) => t.fontSize))
            : baseMm,
          color: withOpacity(
            toRgba(line.tspans[0]?.fill ?? p.color, 1) ?? defCol,
            undefined,
            p.greyed,
          ),
          align: line.align,
        });
      }
      for (const line of p.extraLines) {
        flat.push({ content: line, sizeMm: baseMm * 0.8, color: defCol, align: "center" });
      }
      if (flat.length > 0) {
        const baseH = baseMm * mmToM; // Basisgröße in Modell-Metern, beim gewählten Massstab
        const lineGap = baseH * 1.3;
        const totalH = baseH + (flat.length - 1) * lineGap;
        flat.forEach((line, k) => {
          if (!line.content.trim()) return; // Leerzeile: nur Vorschub
          texts.push({
            // Baseline der Zeile k (Modell-Y nach oben, deshalb minus):
            // Browser: startY = c.y − H/2 + 0.8·fs (Bildschirm-Y nach unten).
            pos: [p.at.x, p.at.y + totalH / 2 - baseH * 0.8 - k * lineGap],
            content: line.content,
            sizeMm: line.sizeMm,
            color: line.color,
            align: line.align,
          });
        });
      }
    }
  }
  flushRun();

  // Gesammelte Umriss-Läufe polygonübergreifend zusammennähen: geschlossene
  // Ketten als Ring (Gehrung auch an der Naht), offene als Polylinie.
  for (const g of edgeRunGroups.values()) {
    for (const chain of stitchRuns(g.runs)) {
      if (chain.pts.length < 2) continue;
      if (chain.closed) {
        outlines.push({ pts: chain.pts, color: g.color, widthMm: g.widthMm, z: g.z });
      } else {
        polylines.push({ pts: chain.pts, color: g.color, widthMm: g.widthMm, z: g.z });
      }
    }
  }

  return { fills, outlines, polylines, arcs, lines, texts, bounds: { ...plan.bounds } };
}
