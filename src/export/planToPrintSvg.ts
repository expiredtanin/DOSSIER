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
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { HatchRender, Plan, Primitive } from "../plan/generatePlan";
import type { Vec2 } from "../model/types";
import { buildRandomHatchRuns, zigzagPoints, motifPoints } from "../plan/glPlan/glPlanHatch";
import { dashHasDot } from "../geometry/lineSegments";
import { wrapDocToLines, type SvgLine } from "../text/renderHtml";
import { docFromText } from "../text/richText";

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

/** `<polyline>`-Knoten (mm-Koordinaten) — für Zickzack-Linien/-Läufe. */
function polylineNode(
  pts: Vec2[],
  color: string,
  strokeMm: number,
  dash: number[] | null | undefined,
): SVGElement {
  const el = document.createElementNS(SVG_NS, "polyline");
  el.setAttribute("points", pts.map((p) => `${round(p.x)},${round(p.y)}`).join(" "));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", String(strokeMm));
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  if (dash && dash.length) el.setAttribute("stroke-dasharray", dash.map((d) => round(d)).join(" "));
  return el;
}

/**
 * Standard-Stift-Stufen (mm). Beliebige Kategorie-Strichstärken werden auf die
 * NÄCHSTHÖHERE dieser ISO-nahen Stufen gequantelt, damit der Plan saubere,
 * unterscheidbare Linienstärken trägt (dünne Hilfslinien ≠ dicke Umrisse).
 */
const PEN_STEPS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0] as const;

/** Untergrenze einer sichtbaren Druck-Strichstärke (mm) — vermeidet 0-Linien. */
const MIN_PEN_MM = 0.13;

/** Quantelt eine mm-Strichstärke auf die nächste Stift-Stufe (≥ MIN_PEN_MM). */
function quantizePen(mm: number): number {
  const w = Math.max(MIN_PEN_MM, mm);
  for (const step of PEN_STEPS) if (w <= step + 1e-6) return step;
  return PEN_STEPS[PEN_STEPS.length - 1];
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

  // Jedes Primitiv in mm-Knoten übersetzen.
  for (const p of plan.primitives) {
    appendPrimitive(svg, p, map, k);
  }

  return {
    svg,
    widthMm: opts.pageWidthMm,
    heightMm: opts.pageHeightMm,
    content: { x: offsetXmm, y: offsetYmm, w: contentWmm, h: contentHmm },
  };
}

/** Schreibt ein einzelnes Primitiv (mit ggf. Schraffur) in das SVG. */
function appendPrimitive(
  svg: SVGSVGElement,
  p: Primitive,
  map: Mapper,
  mmPerM: number,
): void {
  // Gedimmt (0.3) und Objekt-Transparenz multiplizieren sich; Bilder tragen
  // ihre eigene Deckkraft separat (s. dortiger Zweig).
  const objOpacity = p.kind === "drawingImage" ? 1 : (p.opacity ?? 1);
  const dim = p.greyed ? 0.3 : 1;
  const combined = dim * Math.max(0, objOpacity);
  const opacity = combined < 1 ? String(combined) : undefined;
  switch (p.kind) {
    case "polygon":
      appendPolygon(svg, p, map, mmPerM, opacity);
      break;
    case "line": {
      const a = map(p.a);
      const b = map(p.b);
      // Zickzack-Linie (amplitude/wavelength sind Papier-mm = mm-Zielraum) →
      // Polylinie; sonst gerade (ggf. gestrichelte) Linie wie bisher.
      // Zickzack/Custom-Motiv sind in Papier-mm definiert = mm-Zielraum (scale 1).
      const ln = p.zigzag
        ? polylineNode(
            zigzagPoints(a, b, p.zigzag.amplitude, p.zigzag.wavelength),
            p.color ?? "#111111",
            quantizePen(p.weightMm),
            p.dash,
          )
        : p.motif
          ? polylineNode(
              motifPoints(a, b, p.motif),
              p.color ?? "#111111",
              quantizePen(p.weightMm),
              p.dash,
            )
          : lineNode(a, b, p.color ?? "#111111", quantizePen(p.weightMm), p.dash, mmPerM);
      if (opacity) ln.setAttribute("opacity", opacity);
      svg.appendChild(ln);
      break;
    }
    case "arc": {
      const node = arcNode(p, map, mmPerM);
      if (opacity) node.setAttribute("opacity", opacity);
      svg.appendChild(node);
      break;
    }
    case "drawingCircle": {
      const c = map(p.center);
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(round(c.x)));
      el.setAttribute("cy", String(round(c.y)));
      el.setAttribute("r", String(round(p.r * mmPerM)));
      el.setAttribute("fill", p.fill && p.fill !== "none" ? p.fill : "none");
      el.setAttribute("stroke", p.stroke);
      el.setAttribute("stroke-width", String(quantizePen(p.weightMm)));
      if (p.dash && p.dash.length) {
        el.setAttribute("stroke-dasharray", p.dash.map((x) => round(x)).join(" "));
        if (dashHasDot(p.dash)) el.setAttribute("stroke-linecap", "round");
      }
      if (opacity) el.setAttribute("opacity", opacity);
      svg.appendChild(el);
      break;
    }
    case "drawingArc": {
      const node = drawingArcNode(p, map, mmPerM);
      if (opacity) node.setAttribute("opacity", opacity);
      svg.appendChild(node);
      break;
    }
    case "drawingText": {
      const node = drawingTextNode(p, map, mmPerM);
      if (node) {
        if (opacity) node.setAttribute("opacity", opacity);
        svg.appendChild(node);
      }
      break;
    }
    case "drawingImage": {
      const node = drawingImageNode(p, map, mmPerM);
      if (node) {
        if (p.opacity < 1) node.setAttribute("opacity", String(p.opacity * (p.greyed ? 0.45 : 1)));
        else if (opacity) node.setAttribute("opacity", opacity);
        svg.appendChild(node);
      }
      break;
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

/** Eingebettetes Rasterbild (Data-URL) als achsparalleles `<image>`. */
function drawingImageNode(
  p: Extract<Primitive, { kind: "drawingImage" }>,
  map: Mapper,
  mmPerM: number,
): SVGImageElement | null {
  const w = (p.max.x - p.min.x) * mmPerM;
  const h = (p.max.y - p.min.y) * mmPerM;
  if (w <= 0 || h <= 0) return null;
  const topLeft = map({ x: p.min.x, y: p.max.y });
  const el = document.createElementNS(SVG_NS, "image");
  el.setAttribute("href", p.src);
  el.setAttribute("x", String(round(topLeft.x)));
  el.setAttribute("y", String(round(topLeft.y)));
  el.setAttribute("width", String(round(w)));
  el.setAttribute("height", String(round(h)));
  el.setAttribute("preserveAspectRatio", "none");
  return el;
}

/**
 * Polygon mit Füllung/Umriss/Schraffur. Reihenfolge wie in der PlanView:
 *  • pattern "none"   → reine Füllung (oder „none") + Umriss.
 *  • pattern "solid"  → Vollfüllung in der Hatch-Farbe + Umriss.
 *  • Linien/Kreuz/Dämmung → Grundfüllung, dann geklippte Schraffurlinien, dann Umriss.
 */
function appendPolygon(
  svg: SVGSVGElement,
  p: Extract<Primitive, { kind: "polygon" }>,
  map: Mapper,
  mmPerM: number,
  opacity: string | undefined,
): void {
  const ptsMm = p.pts.map(map);
  const ptsAttr = ptsMm.map((s) => `${round(s.x)},${round(s.y)}`).join(" ");
  const strokeMm = p.strokeWidthMm > 0 ? quantizePen(p.strokeWidthMm) : 0;

  const g = document.createElementNS(SVG_NS, "g");
  if (opacity) g.setAttribute("opacity", opacity);

  const pattern = p.hatch.pattern;
  if (p.hatch.kind === "image" && p.hatch.image) {
    // Bild-Schraffur: gekacheltes <pattern> mit <image> (scaleX/scaleY/rotation)
    // über die Fläche, unabhängig vom `pattern`-Feld. Grundfüllung darunter,
    // Umriss obenauf.
    if (p.fill !== "none") g.appendChild(polyNode(ptsAttr, p.fill, "none", 0));
    const patId = ensureImagePattern(svg, p.hatch.image);
    g.appendChild(polyNode(ptsAttr, `url(#${patId})`, "none", 0));
    if (strokeMm > 0) g.appendChild(polyNode(ptsAttr, "none", p.stroke, strokeMm));
  } else if (pattern === "none") {
    g.appendChild(polyNode(ptsAttr, p.fill, p.stroke, strokeMm));
  } else if (pattern === "solid") {
    g.appendChild(polyNode(ptsAttr, p.hatch.color, p.stroke, strokeMm));
  } else {
    // Grundfüllung (ohne Umriss), dann die geklippten Schraffurlinien, dann der
    // Umriss obenauf (separat, damit er die Schraffur-Enden überdeckt).
    if (p.fill !== "none") {
      g.appendChild(polyNode(ptsAttr, p.fill, "none", 0));
    }
    if (p.hatch.lines === "random") {
      // Random-Vektor (Kies/Splitt): deterministische Streu-Striche. Wird im
      // MODELL-Raum erzeugt (identischer Seed/Geometrie wie Bildschirm/GL/PDF)
      // und dann nach Papier-mm abgebildet.
      for (const run of buildRandomHatchRuns(p.pts, p.hatch)) {
        if (run.length < 2) continue;
        g.appendChild(
          lineNode(
            map(run[0]),
            map(run[run.length - 1]),
            p.hatch.color,
            quantizePen(p.hatch.lineWeight),
            null,
            mmPerM,
          ),
        );
      }
    } else {
      for (const seg of hatchLines(ptsMm, p.hatch, mmPerM)) {
        g.appendChild(
          lineNode(
            seg.a,
            seg.b,
            p.hatch.color,
            quantizePen(p.hatch.lineWeight),
            p.hatch.dash,
            mmPerM,
          ),
        );
      }
    }
    if (strokeMm > 0) {
      g.appendChild(polyNode(ptsAttr, "none", p.stroke, strokeMm));
    }
  }

  svg.appendChild(g);
}

/** Erzeugt einen <polygon>-Knoten (mm-Koordinaten als Attribut-String). */
function polyNode(
  ptsAttr: string,
  fill: string,
  stroke: string,
  strokeMm: number,
): SVGElement {
  const el = document.createElementNS(SVG_NS, "polygon");
  el.setAttribute("points", ptsAttr);
  el.setAttribute("fill", fill);
  if (stroke !== "none" && strokeMm > 0) {
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", String(strokeMm));
    el.setAttribute("stroke-linejoin", "round");
  } else {
    el.setAttribute("stroke", "none");
  }
  return el;
}

/** Erzeugt einen <line>-Knoten in mm; Strichmuster (mm Welt → mm Papier). */
function lineNode(
  a: Vec2,
  b: Vec2,
  color: string,
  strokeMm: number,
  dash: number[] | null | undefined,
  _mmPerM: number,
): SVGElement {
  const el = document.createElementNS(SVG_NS, "line");
  el.setAttribute("x1", String(round(a.x)));
  el.setAttribute("y1", String(round(a.y)));
  el.setAttribute("x2", String(round(b.x)));
  el.setAttribute("y2", String(round(b.y)));
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", String(strokeMm));
  el.setAttribute("stroke-linecap", "round");
  if (dash && dash.length) {
    // Strichmuster ist in mm Papier definiert (wie weightMm), daher direkt.
    el.setAttribute("stroke-dasharray", dash.map((d) => round(d)).join(" "));
  }
  return el;
}

/**
 * Erzeugt einen Bogen als <path> (A-Kommando). Der Bogen-Radius ist in Metern →
 * Papier-mm. Drehrichtung aus dem Kreuzprodukt im Papier-Raum (Y nach unten).
 */
function arcNode(
  p: Extract<Primitive, { kind: "arc" }>,
  map: Mapper,
  mmPerM: number,
): SVGElement {
  const c = map(p.center);
  const from = map(p.from);
  const to = map(p.to);
  const r = p.r * mmPerM;
  const v1 = { x: from.x - c.x, y: from.y - c.y };
  const v2 = { x: to.x - c.x, y: to.y - c.y };
  const cross = v1.x * v2.y - v1.y * v2.x;
  const sweep = cross > 0 ? 1 : 0;
  const d = `M ${round(from.x)} ${round(from.y)} A ${round(r)} ${round(r)} 0 0 ${sweep} ${round(to.x)} ${round(to.y)}`;
  const el = document.createElementNS(SVG_NS, "path");
  el.setAttribute("d", d);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "#111111");
  el.setAttribute("stroke-width", String(quantizePen(p.weightMm)));
  if (p.dash && p.dash.length) {
    el.setAttribute("stroke-dasharray", p.dash.map((x) => round(x)).join(" "));
    // Punktmuster (dash enthält eine 0): runde Kappe → Dots am Bogen.
    if (dashHasDot(p.dash)) el.setAttribute("stroke-linecap", "round");
  }
  return el;
}

/**
 * `drawingArc` → glatter SVG-Bogen. Konvention wie im Bildschirm-Renderer
 * (`planView/primitives.tsx`): die Winkel laufen im MODELL immer gegen den
 * Uhrzeigersinn von `a0` nach `a1`; da die Ziel-Y-Achse gespiegelt ist, wird
 * daraus am Papier ein Uhrzeigersinn-Bogen (sweep-flag 1). `large-arc` aus
 * der normierten Spannweite.
 */
function drawingArcNode(
  p: Extract<Primitive, { kind: "drawingArc" }>,
  map: Mapper,
  mmPerM: number,
): SVGElement {
  const TAU = Math.PI * 2;
  const from = map({ x: p.center.x + p.r * Math.cos(p.a0), y: p.center.y + p.r * Math.sin(p.a0) });
  const to = map({ x: p.center.x + p.r * Math.cos(p.a1), y: p.center.y + p.r * Math.sin(p.a1) });
  const r = p.r * mmPerM;
  const sweep = (((p.a1 - p.a0) % TAU) + TAU) % TAU;
  const largeArc = sweep > Math.PI ? 1 : 0;
  const el = document.createElementNS(SVG_NS, "path");
  el.setAttribute(
    "d",
    `M ${round(from.x)} ${round(from.y)} A ${round(r)} ${round(r)} 0 ${largeArc} 1 ${round(to.x)} ${round(to.y)}`,
  );
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", p.stroke);
  el.setAttribute("stroke-width", String(quantizePen(p.weightMm)));
  if (p.dash && p.dash.length) {
    el.setAttribute("stroke-dasharray", p.dash.map((x) => round(x)).join(" "));
    if (dashHasDot(p.dash)) el.setAttribute("stroke-linecap", "round");
  }
  return el;
}

/** Auf 3 Nachkommastellen runden (kompaktes, exaktes SVG). */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Schraffur als geklippte Vektorlinien ─────────────────────────────────────

interface Seg {
  a: Vec2;
  b: Vec2;
}

/**
 * Erzeugt die Schraffurlinien eines Polygons (in Papier-mm), auf das Polygon
 * geklippt. Die Kachelgrösse der Bildschirm-PlanView (8 px bzw. 14 px bei
 * „insulation", × Maßstab) wird hier in einen mm-Linienabstand übersetzt, damit
 * der Druck der Bildschirm-Dichte nahekommt:
 *   • diagonal/crosshatch: parallele Linienscharen im Winkel `angle`.
 *   • crosshatch: zusätzlich die um 90° gedrehte Schar.
 *   • insulation: vereinfacht als eine dichtere diagonale Schar (echte Wellen-
 *     linie wäre als Pfad möglich; eine Linienschar liest sich im Druck sauber
 *     und bleibt rein vektoriell — offener Punkt im Report).
 */
function hatchLines(polyMm: Vec2[], hatch: HatchRender, mmPerM: number): Seg[] {
  // Kachel der PlanView: 8 viewBox-Einheiten (= px bei dpi-Bezug) × scale. In der
  // PlanView ist 1 viewBox-Einheit = 1/PX_PER_M m = 1/90 m. Auf Papier sind das
  // (1/90)·mmPerM mm. So bleibt die Strich-Dichte massstäblich konsistent.
  const unitMm = (1 / 90) * mmPerM;
  const tileMm = (hatch.pattern === "insulation" ? 10 : 8) * hatch.scale * unitMm;
  const spacing = Math.max(0.5, tileMm); // Mindestabstand, sonst zu dicht

  const angle = (hatch.angle * Math.PI) / 180;
  const segs: Seg[] = [];
  fillParallel(polyMm, angle, spacing, segs);
  if (hatch.pattern === "crosshatch") {
    fillParallel(polyMm, angle + Math.PI / 2, spacing, segs);
  }
  if (hatch.pattern === "insulation") {
    // Zweite, gegenläufige Schar deutet die Dämmungs-Textur an (dichter Filz).
    fillParallel(polyMm, angle - Math.PI / 4, spacing, segs);
  }
  return segs;
}

/**
 * Füllt das Polygon mit parallelen Linien im gegebenen Winkel/Abstand und klippt
 * jede Linie auf das Polygon (Scanline über die Polygon-Schnittpunkte). Robust
 * für konvexe wie konkave (einfache) Polygone.
 */
function fillParallel(
  poly: Vec2[],
  angle: number,
  spacing: number,
  out: Seg[],
): void {
  if (poly.length < 3 || spacing <= 0) return;
  // Linienrichtung d und Normale nrm (Projektionsachse).
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const nrm = { x: -dir.y, y: dir.x };

  // Projektion der Polygonpunkte auf die Normale → [tMin, tMax]-Band der Linien.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of poly) {
    const t = p.x * nrm.x + p.y * nrm.y;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  // Linien an t = tMin + i·spacing; für jede die Schnitt-Intervalle ermitteln.
  const start = Math.ceil(tMin / spacing) * spacing;
  for (let t = start; t <= tMax; t += spacing) {
    const xs: number[] = []; // Parameter entlang dir der Schnittpunkte
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const ta = a.x * nrm.x + a.y * nrm.y;
      const tb = b.x * nrm.x + b.y * nrm.y;
      // Schneidet die Kante das Niveau t?
      if (ta === tb) continue;
      const f = (t - ta) / (tb - ta);
      if (f < 0 || f > 1) continue;
      const px = a.x + (b.x - a.x) * f;
      const py = a.y + (b.y - a.y) * f;
      xs.push(px * dir.x + py * dir.y); // Position entlang dir
    }
    if (xs.length < 2) continue;
    xs.sort((u, v) => u - v);
    // Paarweise Intervalle = Polygon-Inneres entlang der Linie.
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const u0 = xs[k];
      const u1 = xs[k + 1];
      if (u1 - u0 < 1e-6) continue;
      // Punkt = t·nrm + u·dir.
      out.push({
        a: { x: nrm.x * t + dir.x * u0, y: nrm.y * t + dir.y * u0 },
        b: { x: nrm.x * t + dir.x * u1, y: nrm.y * t + dir.y * u1 },
      });
    }
  }
}
