// Druck-SVG aus der RENDER-SZENE (`src/plan/toRenderScene.ts`) — dieselbe Quelle,
// die der native/WASM-Viewport zeichnet (siehe `useWasmPlanRenderer.ts`,
// `nativeSync.ts`: beide rufen `planToRenderScene(plan)` unveraendert auf). Der
// Vektor-PDF-Export ist damit nur ein ANDERES ZIEL derselben Szene (Papier-SVG
// statt GPU-Framebuffer) — kein zweiter, eigenstaendig interpretierender
// Serializer mehr (das war `planToPrintSvg.ts`, jetzt Referenz/Altpfad, siehe
// dessen Kopfkommentar).
//
// Kern-Idee (unveraendert ggue. `planToPrintSvg.ts`, vgl. CONVENTIONS.md,
// docs/design/plans-output.md §3): Welt-Meter werden im gewaehlten Massstab 1:N
// nach Papier-Millimetern abgebildet (1 m = 1000/N mm). Das SVG-Benutzer-
// koordinatensystem ist „mm": die viewBox ist in mm, Strichstaerken sind echte
// physische mm — KEIN non-scaling-stroke.
//
// Reihenfolge (Maler-Algorithmus) EXAKT wie der native Renderer
// (`render2d::tessellate::compile_scene`): Fuellungen/Umrisse/offene
// Polylinien/freie Linien werden ZUSAMMEN nach ihrem `z`-Feld sortiert
// (stabil — Einfuegereihenfolge = `seq` in Rust), danach Boegen (eigene
// Pipeline, immer ÜBER der z-sortierten Geometrie), danach Texte (Text-Pass
// zuoberst, siehe `gpu.rs`). So zeichnet das PDF strukturell dieselbe Stapelung
// wie der Viewport.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  RArc,
  RFill,
  RLine,
  ROutline,
  RPoint,
  RPolyline,
  RRgba,
  RScene,
  RText,
} from "../plan/toRenderScene";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Standard-Stift-Stufen (mm), identisch zu `planToPrintSvg.ts`. Beliebige
 * mm-Strichstaerken werden auf die NAECHSTHOEHERE dieser ISO-nahen Stufen
 * gequantelt.
 */
const PEN_STEPS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0] as const;

/** Untergrenze einer sichtbaren Druck-Strichstaerke (mm). */
const MIN_PEN_MM = 0.13;

/** Quantelt eine mm-Strichstaerke auf die naechste Stift-Stufe (>= MIN_PEN_MM). */
export function quantizePen(mm: number): number {
  const w = Math.max(MIN_PEN_MM, mm);
  for (const step of PEN_STEPS) if (w <= step + 1e-6) return step;
  return PEN_STEPS[PEN_STEPS.length - 1];
}

/**
 * viewBox-Einheiten je Modell-Meter im Bildschirm-Pfad (`PX_PER_M` in
 * `PlanView.tsx` / `glPlanHatch.ts` / `glPlanCompile.ts`). Schraffur-
 * Strichbreiten in der Szene (`RPolyline.widthScreen === true`) sind GENAU in
 * diesen Einheiten kodiert (siehe `toRenderScene.ts`, Kommentar bei
 * `hatchPx`) — dieser Wert MUSS mit dem dortigen uebereinstimmen, sonst
 * driftet die Schraffur-Dichte des PDFs von der des Viewports ab.
 */
const PX_PER_M = 90;

export interface PrintSceneOptions {
  /** Massstab-Nenner N (1:N). 1 m = 1000/N mm auf dem Papier. */
  scaleDenominator: number;
  /** Blattbreite in mm (Papierformat, schon Hoch/Quer beruecksichtigt). */
  pageWidthMm: number;
  /** Blatthoehe in mm. */
  pageHeightMm: number;
  /** Rand um den Plan-Inhalt in mm (weisser Blattrand). */
  marginMm?: number;
}

/** Ergebnis des Print-SVG-Aufbaus: das Element + Blattmasse (mm). */
export interface PrintScene {
  /** Das fertige, in mm bemasste <svg>-Element (fuer svg2pdf). */
  svg: SVGSVGElement;
  /** Blattbreite in mm (= viewBox-Breite). */
  widthMm: number;
  /** Blatthoehe in mm (= viewBox-Hoehe). */
  heightMm: number;
  /** Massstaeblicher Inhalts-Rahmen (mm) innerhalb des Blattes (Plan-Bounds). */
  content: { x: number; y: number; w: number; h: number };
}

/** Welt-Punkt (Modell-Meter) -> Papier-mm-Punkt, im gewaehlten Massstab zentriert. */
interface Mapper {
  (p: RPoint): RPoint;
}

/**
 * Erzeugt das Druck-SVG aus einer render2d-Szene. Reihenfolge/Optik siehe
 * Kopfkommentar; die einzige weitere Eingabe ist der gewaehlte Papier-
 * Massstab N + das Blattformat (der Viewport selbst kennt kein Blatt).
 */
export function sceneToPrintSvg(scene: RScene, opts: PrintSceneOptions): PrintScene {
  const n = opts.scaleDenominator;
  const k = 1000 / n; // mm je Meter auf dem Papier
  // `marginMm` ist Teil des Vertrags (Aufrufer kann einen Rand wuenschen); da
  // der Inhalt zentriert wird, liegt er ohnehin innerhalb des Blattes (siehe
  // `planToPrintSvg.ts`, identisches Verhalten).
  void (opts.marginMm ?? 10);

  const b = scene.bounds;
  const contentWmm = (b.maxX - b.minX) * k;
  const contentHmm = (b.maxY - b.minY) * k;
  const offsetXmm = (opts.pageWidthMm - contentWmm) / 2;
  const offsetYmm = (opts.pageHeightMm - contentHmm) / 2;

  // Plan-Y zeigt nach oben, SVG-Y nach unten -> Spiegelung (b.maxY - p[1]).
  const map: Mapper = (p) => [
    offsetXmm + (p[0] - b.minX) * k,
    offsetYmm + (b.maxY - p[1]) * k,
  ];

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NS);
  // Reine Zahlen (= viewBox-Einheiten), KEINE „mm"-Einheit — siehe
  // `planToPrintSvg.ts` fuer die Begruendung (svg2pdf-Skalierungsfalle).
  svg.setAttribute("width", String(opts.pageWidthMm));
  svg.setAttribute("height", String(opts.pageHeightMm));
  svg.setAttribute("viewBox", `0 0 ${opts.pageWidthMm} ${opts.pageHeightMm}`);

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(opts.pageWidthMm));
  bg.setAttribute("height", String(opts.pageHeightMm));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  // ── Maler-Reihenfolge: Fuellungen/Umrisse/Polylinien/Linien gemeinsam nach
  // `z` sortieren (stabiler Sort => Einfuegereihenfolge bricht Gleichstaende
  // genau wie `seq` in `compile_scene`).
  type Item =
    | { z: number; kind: "fill"; v: RFill }
    | { z: number; kind: "outline"; v: ROutline }
    | { z: number; kind: "polyline"; v: RPolyline }
    | { z: number; kind: "line"; v: RLine };
  const items: Item[] = [
    ...scene.fills.map((v): Item => ({ z: v.z, kind: "fill", v })),
    ...scene.outlines.map((v): Item => ({ z: v.z, kind: "outline", v })),
    ...scene.polylines.map((v): Item => ({ z: v.z, kind: "polyline", v })),
    ...scene.lines.map((v): Item => ({ z: v.z, kind: "line", v })),
  ];
  items.sort((a, c) => a.z - c.z);

  for (const it of items) {
    switch (it.kind) {
      case "fill":
        appendFill(svg, it.v, map);
        break;
      case "outline":
        appendStroke(svg, it.v.pts, true, it.v.color, it.v.widthMm, it.v.dash, map, k, false);
        break;
      case "polyline":
        appendStroke(
          svg,
          it.v.pts,
          false,
          it.v.color,
          it.v.widthMm,
          it.v.dash,
          map,
          k,
          it.v.widthScreen ?? false,
        );
        break;
      case "line":
        appendLine(svg, it.v, map, k);
        break;
    }
  }

  // Boegen: NACH der z-sortierten Geometrie (wie `compile_scene`: eigene
  // Pipeline, immer ueber Fuellung/Umriss/Linie — Tuerschwenk liegt oben).
  for (const a of scene.arcs) appendArc(svg, a, map, k);
  // Texte: zuoberst (wie `gpu.rs`: Text-Pass als letztes im selben Frame).
  for (const t of scene.texts) appendText(svg, t, map);

  return {
    svg,
    widthMm: opts.pageWidthMm,
    heightMm: opts.pageHeightMm,
    content: { x: offsetXmm, y: offsetYmm, w: contentWmm, h: contentHmm },
  };
}

/** [r,g,b,a] (0..1) -> "rgb(r,g,b)" (0..255, gerundet). */
function rgbCss(c: RRgba): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(c[0])},${to255(c[1])},${to255(c[2])})`;
}

/** Setzt `attr`-opacity, falls Alpha spuerbar < 1 ist (vermeidet Rauschen). */
function setOpacityAttr(el: SVGElement, attr: string, alpha: number): void {
  if (alpha < 0.999) el.setAttribute(attr, String(round(alpha)));
}

/** Auf 3 Nachkommastellen runden (kompaktes, exaktes SVG). */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function ptsAttrOf(pts: RPoint[], map: Mapper): string {
  return pts.map((p) => map(p)).map(([x, y]) => `${round(x)},${round(y)}`).join(" ");
}

/** Gefuelltes Polygon (Wand-Poche, Raeume, Decken, Grundfuellung vor Schraffur). */
function appendFill(svg: SVGSVGElement, f: RFill, map: Mapper): void {
  if (f.pts.length < 3) return;
  const el = document.createElementNS(SVG_NS, "polygon");
  el.setAttribute("points", ptsAttrOf(f.pts, map));
  el.setAttribute("fill", rgbCss(f.color));
  setOpacityAttr(el, "fill-opacity", f.color[3]);
  el.setAttribute("stroke", "none");
  svg.appendChild(el);
}

/**
 * Umriss (geschlossener Ring) oder offene Polylinie (2D-Zeichenzug,
 * Schraffur-Musterlinie). `widthScreen`: `widthMm` traegt Bildschirm-viewBox-
 * Einheiten (Schraffur, siehe `PX_PER_M`-Kommentar oben) statt Papier-mm.
 */
function appendStroke(
  svg: SVGSVGElement,
  pts: RPoint[],
  closed: boolean,
  color: RRgba,
  widthMm: number,
  dash: number[] | null | undefined,
  map: Mapper,
  mmPerM: number,
  widthScreen: boolean,
): void {
  if (pts.length < 2 || widthMm <= 0) return;
  // Bildschirm-viewBox-Einheiten -> Welt-Meter (/ PX_PER_M) -> Papier-mm
  // (* mmPerM) — reproduziert exakt die Schraffur-Dichte des SVG-Pfads
  // (`hatchStrokePx`) beim GEWAEHLTEN Papier-Massstab N.
  const effectiveMm = widthScreen ? (widthMm / PX_PER_M) * mmPerM : widthMm;
  const strokeMm = quantizePen(effectiveMm);

  const el = document.createElementNS(SVG_NS, closed ? "polygon" : "polyline");
  el.setAttribute("points", ptsAttrOf(pts, map));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", rgbCss(color));
  setOpacityAttr(el, "stroke-opacity", color[3]);
  el.setAttribute("stroke-width", String(strokeMm));
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("stroke-linecap", "round");
  if (dash && dash.length) {
    // Strichmuster ist bereits in Papier-mm definiert (siehe `toRenderScene.ts`:
    // „unveraendert durchgereicht"), also direkt uebernehmen.
    el.setAttribute("stroke-dasharray", dash.map((d) => round(d)).join(" "));
  }
  svg.appendChild(el);
}

/** Freies Liniensegment (Tuerblatt, Referenzlinie, Symbol). */
function appendLine(svg: SVGSVGElement, l: RLine, map: Mapper, _mmPerM: number): void {
  if (l.widthMm <= 0) return;
  const [ax, ay] = map(l.a);
  const [bx, by] = map(l.b);
  const el = document.createElementNS(SVG_NS, "line");
  el.setAttribute("x1", String(round(ax)));
  el.setAttribute("y1", String(round(ay)));
  el.setAttribute("x2", String(round(bx)));
  el.setAttribute("y2", String(round(by)));
  el.setAttribute("stroke", rgbCss(l.color));
  setOpacityAttr(el, "stroke-opacity", l.color[3]);
  el.setAttribute("stroke-width", String(quantizePen(l.widthMm)));
  el.setAttribute("stroke-linecap", "round");
  if (l.dash && l.dash.length) {
    el.setAttribute("stroke-dasharray", l.dash.map((d) => round(d)).join(" "));
  }
  svg.appendChild(el);
}

/**
 * Kreisbogen als <path> (A-Kommando). Radius in Welt-Metern -> Papier-mm;
 * Drehrichtung aus dem Kreuzprodukt im Papier-Raum (Y nach unten).
 */
function appendArc(svg: SVGSVGElement, a: RArc, map: Mapper, mmPerM: number): void {
  const [cx, cy] = map(a.center);
  const [fx, fy] = map(a.from);
  const [tx, ty] = map(a.to);
  const r = a.r * mmPerM;
  const v1 = { x: fx - cx, y: fy - cy };
  const v2 = { x: tx - cx, y: ty - cy };
  const cross = v1.x * v2.y - v1.y * v2.x;
  const sweep = cross > 0 ? 1 : 0;
  const d = `M ${round(fx)} ${round(fy)} A ${round(r)} ${round(r)} 0 0 ${sweep} ${round(tx)} ${round(ty)}`;
  const el = document.createElementNS(SVG_NS, "path");
  el.setAttribute("d", d);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", rgbCss(a.color));
  setOpacityAttr(el, "stroke-opacity", a.color[3]);
  el.setAttribute("stroke-width", String(quantizePen(a.widthMm)));
  if (a.dash && a.dash.length) {
    el.setAttribute("stroke-dasharray", a.dash.map((x) => round(x)).join(" "));
  }
  svg.appendChild(el);
}

/** SVG-Schriftfamilie fuer Plan-Beschriftung (Vektor-Text im PDF). */
const TEXT_FONT_FAMILY = "Helvetica, Arial, sans-serif";

/**
 * Textzeile als echtes <text>-Element (Vektor-Text, kein Raster). `pos` ist
 * bereits die Baseline (siehe `RText`-Kommentar in `toRenderScene.ts`) — SVG-
 * `<text>` verankert `y` ebenfalls an der Baseline, daher direkte Uebernahme.
 * `sizeMm` ist eine absolute Papier-mm-Groesse (wie `widthMm` bei Strichen)
 * und wird NICHT nochmals mit dem Massstab reskaliert.
 */
function appendText(svg: SVGSVGElement, t: RText, map: Mapper): void {
  if (!t.content) return;
  const [x, y] = map(t.pos);
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("x", String(round(x)));
  el.setAttribute("y", String(round(y)));
  el.setAttribute("font-family", TEXT_FONT_FAMILY);
  el.setAttribute("font-size", String(round(t.sizeMm)));
  el.setAttribute(
    "text-anchor",
    t.align === "left" ? "start" : t.align === "right" ? "end" : "middle",
  );
  el.setAttribute("fill", rgbCss(t.color));
  setOpacityAttr(el, "fill-opacity", t.color[3]);
  el.textContent = t.content;
  svg.appendChild(el);
}
