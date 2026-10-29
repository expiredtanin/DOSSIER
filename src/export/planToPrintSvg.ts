// ERSETZT durch `sceneToPrintSvg.ts` (liest die render2d-Szene aus
// `toRenderScene.ts` — dieselbe Quelle wie der Viewport — statt den Plan
// eigenständig zu re-interpretieren). Dieser Serializer wird vom PDF-Export
// (`exportPdf.ts`) NICHT MEHR verwendet und bleibt nur als Referenz/Altpfad
// stehen (z. B. für einen Vergleichs-Screenshot). Neue Änderungen bitte in
// `sceneToPrintSvg.ts` vornehmen.
//
// Druck-SVG aus einem Plan (generatePlan → Primitive). Eigenständiges,
// massstäbliches SVG für den VEKTOR-PDF-Export — NICHT vom Bildschirm-DOM
// abgeleitet, sondern direkt aus den Plan-Primitiven (Polygon/Linie/Bogen).
//
// Kern-Idee (vgl. CONVENTIONS.md, docs/design/plans-output.md §3): Der Plan IST
// Papier-Space. Welt-Meter werden im gewählten Massstab 1:N nach Papier-
// Millimeter abgebildet (1 m = 1000/N mm). Das SVG-Benutzerkoordinatensystem ist
// damit „mm": die viewBox ist in mm, Strichstärken (`stroke-width`) sind echte
// physische mm — KEIN non-scaling-stroke (anders als die Bildschirm-PlanView).
//
// Schraffuren werden NICHT als <pattern> geschrieben (PDF-Konverter übernehmen
// Pattern oft nicht sauber), sondern als echte, auf das Polygon geklippte
// Vektorlinien direkt ins SVG. So bleibt das PDF rein vektoriell und scharf.
//
// Seit [K3d] (29.10.) rechnet der Kern die Knoten aus den Plan-Puffern
// (`src-tauri/core/src/plan_print_svg.rs`, Anweisungsliste); hier bleiben der
// <svg>-Rahmen, die Bild-<pattern> (laufende Ids) und die Einzeltexte
// (Text-Layout `wrapDocToLines`). Ausgabe unverändert (gleiche Knoten/Attribute).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { HatchRender, Plan, Primitive } from "../plan/generatePlan";
import type { Vec2 } from "../model/types";
import { wrapDocToLines, type SvgLine } from "../text/renderHtml";
import { docFromText } from "../text/richText";
import { core } from "../engine/coreWasm";
import { planParts, withPlanParts } from "../plan/planParts";
import { planPrimAt } from "../plan/planLazy";

/** SVG-Namespace für die programmatisch erzeugten Knoten. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** Basis-Kachelmaß (mm) einer Bild-Schraffur bei scaleX/scaleY = 1. */
const IMG_TILE_MM = 20;

/** Monoton wachsender Zähler für eindeutige `<pattern>`-IDs im Dokument. */
let patternSeq = 0;

/** Liefert (oder erzeugt) das gemeinsame `<defs>`-Element des SVG. */
function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  const existing = svg.querySelector("defs");
  if (existing) return existing as SVGDefsElement;
  const defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
  // Vor den Inhalt setzen, damit Referenzen (url(#…)) sicher aufgelöst werden.
  svg.insertBefore(defs, svg.firstChild);
  return defs;
}

/**
 * Legt ein gekacheltes Bild-`<pattern>` an und liefert dessen ID. `scaleX`/
 * `scaleY` verzerren die Kachel unabhängig in L×B (preserveAspectRatio="none"),
 * `rotation` (Grad) dreht das Muster (patternTransform). Einheiten = Papier-mm.
 */
function ensureImagePattern(
  svg: SVGSVGElement,
  image: NonNullable<HatchRender["image"]>,
): string {
  const id = `imgpat-${patternSeq++}`;
  const w = Math.max(0.5, IMG_TILE_MM * (image.scaleX > 0 ? image.scaleX : 1));
  const h = Math.max(0.5, IMG_TILE_MM * (image.scaleY > 0 ? image.scaleY : 1));
  const pattern = document.createElementNS(SVG_NS, "pattern");
  pattern.setAttribute("id", id);
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", String(round(w)));
  pattern.setAttribute("height", String(round(h)));
  if (image.rotation) pattern.setAttribute("patternTransform", `rotate(${image.rotation})`);
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("href", image.src);
  img.setAttribute("x", "0");
  img.setAttribute("y", "0");
  img.setAttribute("width", String(round(w)));
  img.setAttribute("height", String(round(h)));
  img.setAttribute("preserveAspectRatio", "none");
  pattern.appendChild(img);
  ensureDefs(svg).appendChild(pattern);
  return id;
}

/** Ergebnis des Print-SVG-Aufbaus: das Element + Blattmasse (mm). */
export interface PrintSvg {
  /** Das fertige, in mm bemaßte <svg>-Element (für svg2pdf). */
  svg: SVGSVGElement;
  /** Blattbreite in mm (= viewBox-Breite). */
  widthMm: number;
  /** Blatthöhe in mm (= viewBox-Höhe). */
  heightMm: number;
  /** Massstäblicher Inhalts-Rahmen (mm) innerhalb des Blattes (Plan-Bounds). */
  content: { x: number; y: number; w: number; h: number };
}

export interface PrintSvgOptions {
  /** Massstab-Nenner N (1:N). 1 m = 1000/N mm auf dem Papier. */
  scaleDenominator: number;
  /** Blattbreite in mm (Papierformat, schon Hoch/Quer berücksichtigt). */
  pageWidthMm: number;
  /** Blatthöhe in mm. */
  pageHeightMm: number;
  /** Rand um den Plan-Inhalt in mm (weisser Blattrand). */
  marginMm?: number;
}

/** Modell-Meter → Papier-Millimeter im Massstab 1:N. */
function mmPerMeter(n: number): number {
  return 1000 / n;
}

/**
 * Bildet einen Welt-Punkt (Meter) auf Papier-Millimeter ab. Der Inhalt wird so
 * verschoben, dass die Plan-Bounds (in mm) zentriert auf dem Blatt liegen.
 * Plan-Y zeigt nach oben → SVG-Y nach unten (Spiegelung), daher das Minus.
 */
interface Mapper {
  (p: Vec2): Vec2;
}

/**
 * Erzeugt das Druck-SVG aus einem Plan. Reihenfolge der Primitive bleibt
 * erhalten (Zeichenreihenfolge = Stapelung); Schraffuren werden als geklippte
 * Linien zwischen Grundfüllung und Umriss eingefügt.
 */
export function planToPrintSvg(plan: Plan, opts: PrintSvgOptions): PrintSvg {
  const n = opts.scaleDenominator;
  const k = mmPerMeter(n); // mm je Meter
  // `marginMm` ist Teil des Vertrags (Aufrufer kann einen Rand wünschen); da der
  // Inhalt zentriert wird, liegt er ohnehin innerhalb des Blattes. Wir lesen ihn
  // bewusst, ohne ihn aktuell für einen Versatz zu nutzen (zentrierte Lage).
  void (opts.marginMm ?? 10);

  const b = plan.bounds;
  // Inhalts-Maße in mm (massstäblich), unverschoben.
  const contentWmm = (b.maxX - b.minX) * k;
  const contentHmm = (b.maxY - b.minY) * k;

  // Inhalt mittig aufs Blatt setzen. Der nutzbare Bereich ist Blatt minus Rand;
  // wir zentrieren den Plan-Block darin (clippen aber NICHT — bei zu grossem
  // Inhalt läuft er über das Blatt hinaus, was der Aufrufer per Format/Massstab
  // vermeidet; ein Warnhinweis liegt in der UI).
  const offsetXmm = (opts.pageWidthMm - contentWmm) / 2;
  // SVG-Y zeigt nach unten: der oberste Welt-Punkt (maxY) liegt oben auf dem
  // Blatt. Wir mappen maxY → offsetYmm.
  const offsetYmm = (opts.pageHeightMm - contentHmm) / 2;

  const map: Mapper = (p) => ({
    x: offsetXmm + (p.x - b.minX) * k,
    y: offsetYmm + (b.maxY - p.y) * k,
  });

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NS);
  // Breite/Höhe als REINE Zahlen (= viewBox-Einheiten), KEINE „mm"-Einheit: so
  // bildet svg2pdf die viewBox (in mm-Benutzereinheiten) 1:1 auf das mm-Ziel
  // (doc.svg {width,height}) ab. Eine „297mm"-Einheit würde svg2pdf als
  // physische Größe lesen und zusätzlich pt-skalieren (Faktor 25.4/72) → falsch.
  svg.setAttribute("width", String(opts.pageWidthMm));
  svg.setAttribute("height", String(opts.pageHeightMm));
  svg.setAttribute("viewBox", `0 0 ${opts.pageWidthMm} ${opts.pageHeightMm}`);

  // Weisses Blatt (deckt die volle Seite).
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(opts.pageWidthMm));
  bg.setAttribute("height", String(opts.pageHeightMm));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  // Jedes Primitiv in mm-Knoten übersetzen (Kern, Anweisungsliste s. `plan_print_svg.rs`).
  const o = Float64Array.of(n, opts.pageWidthMm, opts.pageHeightMm, b.minX, b.minY, b.maxX, b.maxY);
  const ops = withPlanParts(planParts(plan, true), (segs) => core().plan_print_svg_ops(segs, o));
  if (!ops) throw new Error("Druck-SVG: Plan im Kern unlesbar");
  applyOps(svg, ops.slice(1), plan, map, k);

  return {
    svg,
    widthMm: opts.pageWidthMm,
    heightMm: opts.pageHeightMm,
    content: { x: offsetXmm, y: offsetYmm, w: contentWmm, h: contentHmm },
  };
}

/**
 * Legt die Knoten der Kern-Anweisungsliste an (Format s. `plan_print_svg.rs`): Elemente mit ihren
 * Attributen in Reihenfolge, Gruppen, Bild-Schraffuren (`<pattern>` hier) und Einzeltexte (Layout hier).
 */
function applyOps(svg: SVGSVGElement, ops: string, plan: Plan, map: Mapper, mmPerM: number): void {
  if (!ops) return;
  let g: SVGElement | null = null;
  for (const rec of ops.split("\u001e")) {
    const f = rec.split("\u001f");
    switch (f[0]) {
      case "E": {
        const el = document.createElementNS(SVG_NS, f[2]) as SVGElement;
        for (let i = 3; i + 1 < f.length; i += 2) el.setAttribute(f[i], f[i + 1]);
        (f[1] === "1" && g ? g : svg).appendChild(el);
        break;
      }
      case "G":
        g = document.createElementNS(SVG_NS, "g") as SVGElement;
        if (f[1]) g.setAttribute("opacity", f[1]);
        break;
      case "g":
        if (g) svg.appendChild(g);
        g = null;
        break;
      case "I": {
        // Bild-Schraffur: gekacheltes <pattern> über die Fläche.
        const patId = ensureImagePattern(svg, JSON.parse(f[2]) as NonNullable<HatchRender["image"]>);
        const el = document.createElementNS(SVG_NS, "polygon");
        el.setAttribute("points", f[1]);
        el.setAttribute("fill", `url(#${patId})`);
        el.setAttribute("stroke", "none");
        g?.appendChild(el);
        break;
      }
      case "T": {
        const p = planPrimAt(plan, Number(f[1]));
        if (p?.kind !== "drawingText") break;
        const node = drawingTextNode(p, map, mmPerM);
        if (node) {
          if (f[2]) node.setAttribute("opacity", f[2]);
          svg.appendChild(node);
        }
        break;
      }
    }
  }
}

/**
 * Modellverankerter Einzeltext (Text-Werkzeug/DXF-Import) als `<text>` mit
 * `<tspan>`-Zeilen — analog zur Bildschirm-Darstellung (PlanView.tsx
 * `case "drawingText"`), aber DOM-Knoten statt JSX. Bricht bei gesetzter
 * Spaltenbreite wortweise um (Run-Grenzen bleiben erhalten).
 */
function drawingTextNode(
  p: Extract<Primitive, { kind: "drawingText" }>,
  map: Mapper,
  mmPerM: number,
): SVGTextElement | null {
  const doc = p.doc ?? docFromText(p.text, p.marks ?? {});
  const c = map(p.at);
  const fontSizeMm = p.heightM * mmPerM;
  const unitPerPt = (0.0254 / 72) * mmPerM;
  const basePt = unitPerPt > 0 ? p.heightM / unitPerPt : 0;
  const lineHeight = fontSizeMm * 1.25;
  const wrapWidthUnits = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth * mmPerM : undefined;
  const lines: SvgLine[] = wrapDocToLines(doc, {
    x: 0,
    y: 0,
    lineHeight,
    unitPerPt,
    basePt,
    color: p.color,
    ...(wrapWidthUnits ? { wrapWidthUnits } : {}),
  });
  if (lines.length === 0) return null;

  const el = document.createElementNS(SVG_NS, "text");
  const deg = -(p.angle * 180) / Math.PI;
  if (deg) el.setAttribute("transform", `rotate(${round(deg)} ${round(c.x)} ${round(c.y)})`);
  let y = c.y;
  lines.forEach((line, k) => {
    if (k > 0) y += line.lineHeight;
    const anchor = line.align === "center" ? "middle" : line.align === "right" ? "end" : "start";
    const x = !wrapWidthUnits
      ? c.x
      : line.align === "center"
        ? c.x + wrapWidthUnits / 2
        : line.align === "right"
          ? c.x + wrapWidthUnits
          : c.x;
    const lineTspan = document.createElementNS(SVG_NS, "tspan");
    lineTspan.setAttribute("x", String(round(x)));
    lineTspan.setAttribute("y", String(round(y)));
    lineTspan.setAttribute("text-anchor", anchor);
    if (line.tspans.length === 0) {
      lineTspan.textContent = "​";
    } else {
      for (const ts of line.tspans) {
        const run = document.createElementNS(SVG_NS, "tspan");
        run.setAttribute("font-size", String(round(ts.fontSize)));
        run.setAttribute("fill", ts.fill);
        if (ts.fontWeight) run.setAttribute("font-weight", ts.fontWeight);
        if (ts.fontStyle) run.setAttribute("font-style", ts.fontStyle);
        run.setAttribute("font-family", ts.fontFamily ?? "Helvetica, Arial, sans-serif");
        if (ts.textDecoration) run.setAttribute("text-decoration", ts.textDecoration);
        run.textContent = ts.text;
        lineTspan.appendChild(run);
      }
    }
    el.appendChild(lineTspan);
  });
  return el;
}

/** Auf 3 Nachkommastellen runden (kompaktes, exaktes SVG). */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
