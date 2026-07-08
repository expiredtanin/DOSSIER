// DXF-Export des Grundrisses. Nutzt DIESELBE Quelle wie der PDF-Export — den
// Vektor-Plan (generatePlan → Primitive) — schreibt aber MODELL-SPACE-Geometrie
// in ECHTEN Metern (kein Papier-mm, keine Y-Spiegelung). So können nachgelagerte
// CAD-Nutzer beim Plot beliebig skalieren; die Datei ist masshaltig 1:1 in Metern.
//
// Layer entstehen aus den Kategorie-Ebenen des Projekts (Code + Name, Farbe,
// Linienstärke). Jede Entity liegt auf dem Layer ihrer Kategorie; Primitive ohne
// direkten Kategorie-Bezug (Tür-Symbole, Kontext, Schraffuren) landen auf
// sprechenden Sammel-Layern. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Plan, Primitive } from "../plan/generatePlan";
import type { LayerCategory, Project, Vec2 } from "../model/types";
import { flattenCategories } from "../model/types";
import { DxfWriter } from "./dxfWriter";
import { buildRandomHatchRuns, zigzagPoints, motifPoints } from "../plan/glPlan/glPlanHatch";

export interface ExportDxfOptions {
  /** Titel/Geschossname (nur als Kommentar-freundlicher Dateiname genutzt). */
  title?: string;
  /** Schraffurlinien mit ausgeben (true) oder nur Umrisse/Flächen (false). */
  includeHatches?: boolean;
  /** Dateiname des Downloads (mit/ohne .dxf). */
  fileName?: string;
}

/** Sammel-Layer-Namen für Primitive ohne eigene Kategorie. */
const LAYER_HATCH = "HATCH";
const LAYER_SYMBOLS = "SYMBOLS";
const LAYER_CONTEXT = "CONTEXT";
const LAYER_DEFAULT = "PLAN";
/** Sammel-Layer für Extrusions-Footprints (truck-Integration) — die Quell-
 *  Drawing2D wird beim Extrudieren entfernt, es gibt also keine categoryCode
 *  mehr nachzuschlagen; eigener Layer statt Absturz in LAYER_DEFAULT. */
const LAYER_EXTRUSION = "EXTRUSION";

/**
 * Baut aus einem Plan + Projekt einen vollständigen DXF-String (Meter-Modell-Space).
 * Reihenfolge der Primitive bleibt erhalten. Rückgabe ist reiner ASCII-Text.
 */
export function buildPlanDxf(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): string {
  const includeHatches = opts.includeHatches ?? true;
  const dxf = new DxfWriter();

  // 1) Layer aus den Kategorie-Ebenen anlegen (Code+Name als Layer-Name, Farbe,
  //    Linienstärke). So trägt die DXF echte, benannte Layer statt eines Flachs.
  const cats = flattenCategories(project.layers);
  const layerNameByCode = new Map<string, string>();
  for (const c of cats) {
    const name = layerName(c);
    layerNameByCode.set(c.code, name);
    dxf.addLayer({
      name,
      color: aciFromHex(c.color),
      trueColor: rgbFromHex(c.color),
      lineWeight: mmToLwe(c.lw),
    });
  }
  // Sammel-Layer für kategorielose Primitive.
  dxf.addLayer({ name: LAYER_SYMBOLS, color: 7, trueColor: 0x111111, lineWeight: 18 });
  dxf.addLayer({ name: LAYER_HATCH, color: 8, trueColor: 0x888888, lineWeight: 13 });
  dxf.addLayer({ name: LAYER_CONTEXT, color: 9, trueColor: 0x9aa3ad, lineWeight: 10 });
  dxf.addLayer({ name: LAYER_DEFAULT, color: 7, trueColor: 0x111111, lineWeight: 18 });
  // Warmes Orange, identisch zum 3D-/Grundriss-Footprint der Extrusionen (EXTRUSION_STROKE/EXTRUSION_RGB).
  dxf.addLayer({ name: LAYER_EXTRUSION, color: aciFromHex("#d98c40"), trueColor: rgbFromHex("#d98c40"), lineWeight: 13 });

  // 2) Rückverweise Primitiv → Kategorie: Wände/2D-Elemente tragen nur ihre ID im
  //    Plan; die Kategorie liegt am Projekt-Objekt. Damit landet jede Wand-/Drawing-
  //    Entity auf dem richtigen Layer.
  const codeByWall = new Map<string, string>();
  for (const w of project.walls) codeByWall.set(w.id, w.categoryCode);
  const codeByDrawing = new Map<string, string>();
  for (const d of project.drawings2d) codeByDrawing.set(d.id, d.categoryCode);
  const codeByColumn = new Map<string, string>();
  for (const c of project.columns ?? []) codeByColumn.set(c.id, c.categoryCode);

  const layerFor = (p: Primitive): string => {
    if (p.kind === "polygon") {
      if (p.wallId) return layerNameByCode.get(codeByWall.get(p.wallId) ?? "") ?? LAYER_DEFAULT;
      if (p.drawingId) return layerNameByCode.get(codeByDrawing.get(p.drawingId) ?? "") ?? LAYER_DEFAULT;
      if (p.columnId) return layerNameByCode.get(codeByColumn.get(p.columnId) ?? "") ?? LAYER_DEFAULT;
      if (p.extrudedSolidId) return LAYER_EXTRUSION;
      return LAYER_DEFAULT;
    }
    if (p.kind === "line") {
      if (p.cls === "context-line") return LAYER_CONTEXT;
      if (p.drawingId) return layerNameByCode.get(codeByDrawing.get(p.drawingId) ?? "") ?? LAYER_DEFAULT;
      // Tür-Blatt/-Rahmen und Wand-Achsen: Symbol-Sammellayer.
      return LAYER_SYMBOLS;
    }
    // Bögen: Tür-Schwenkbogen → Symbole.
    return LAYER_SYMBOLS;
  };

  // 3) Jedes Primitiv in DXF-Entities übersetzen.
  for (const p of plan.primitives) {
    emitPrimitive(dxf, p, layerFor(p), includeHatches);
  }

  return dxf.build();
}

/** Layer-Name aus einer Kategorie: "Code_Name" (bereinigt der Writer selbst). */
function layerName(c: LayerCategory): string {
  return `${c.code}_${c.name}`;
}

/** Schreibt ein Plan-Primitiv als passende DXF-Entity(en). */
function emitPrimitive(
  dxf: DxfWriter,
  p: Primitive,
  layer: string,
  includeHatches: boolean,
): void {
  switch (p.kind) {
    case "line":
      if (p.zigzag) {
        // Zickzack-Linie → offene Polylinie (amplitude/wavelength Papier-mm →
        // Modell-Meter über dieselbe Kopplung wie das Strichmuster oben).
        const amp = p.zigzag.amplitude * DASH_MM_TO_M;
        const wav = p.zigzag.wavelength * DASH_MM_TO_M;
        dxf.addPolyline(layer, zigzagPoints(p.a, p.b, amp, wav), false);
      } else if (p.motif) {
        // Custom-Motiv → offene Polylinie (Papier-mm → Modell-Meter, wie oben).
        dxf.addPolyline(layer, motifPoints(p.a, p.b, p.motif, DASH_MM_TO_M), false);
      } else {
        dxf.addLine(layer, p.a, p.b);
      }
      break;

    case "arc":
      emitArc(dxf, p, layer);
      break;

    case "polygon": {
      const pts = p.pts;
      if (pts.length < 2) break;
      // Kreis-Approximationen (viele Segmente) bleiben als geschlossene Polylinie —
      // masshaltig und robust. Geschlossene Ringe bekommen das Ring-Flag.
      dxf.addPolyline(layer, pts, true);
      // Schraffur als geklippte Linien (optional). Vollfüllung/„none" tragen keine
      // sichtbaren Musterlinien → wir geben nur echte Muster (nicht solid/none) aus.
      // Bild-Schraffur (kind==="image"): DXF trägt keine Rasterbilder →
      // FALLBACK ohne Musterlinien (nur die Umriss-Polylinie oben). Als
      // Folge-Arbeit dokumentiert. Random-Vektor: deterministische Streu-Striche
      // (Modell-Meter, identischer Seed wie Bildschirm/PDF).
      if (
        includeHatches &&
        p.hatch.kind !== "image" &&
        p.hatch.pattern !== "none" &&
        p.hatch.pattern !== "solid"
      ) {
        const cycle = dashCycleMeters(p.hatch.dash);
        const segs: Seg[] =
          p.hatch.lines === "random"
            ? buildRandomHatchRuns(pts, p.hatch)
                .filter((r) => r.length >= 2)
                .map((r) => ({ a: r[0], b: r[r.length - 1] }))
            : hatchSegments(pts, p.hatch);
        for (const seg of segs) {
          if (cycle) {
            for (const d of dashSeg(seg, cycle)) dxf.addLine(LAYER_HATCH, d.a, d.b);
          } else {
            dxf.addLine(LAYER_HATCH, seg.a, seg.b);
          }
        }
      }
      break;
    }
  }
}

/**
 * Bogen-Primitiv → DXF-ARC. DXF-Bögen laufen gegen den Uhrzeigersinn von
 * startAngle nach endAngle. Der Plan-Bogen ist über from/to definiert; die
 * Drehrichtung folgt dem Kreuzprodukt (positiv = CCW). Bei CW werden Start/Ende
 * getauscht, damit der kurze Bogen in der richtigen Richtung entsteht.
 */
function emitArc(
  dxf: DxfWriter,
  p: Extract<Primitive, { kind: "arc" }>,
  layer: string,
): void {
  const a1 = angleDeg(p.center, p.from);
  const a2 = angleDeg(p.center, p.to);
  const v1 = { x: p.from.x - p.center.x, y: p.from.y - p.center.y };
  const v2 = { x: p.to.x - p.center.x, y: p.to.y - p.center.y };
  const cross = v1.x * v2.y - v1.y * v2.x;
  if (cross >= 0) {
    dxf.addArc(layer, p.center, p.r, a1, a2);
  } else {
    dxf.addArc(layer, p.center, p.r, a2, a1);
  }
}

/** Winkel (Grad, 0..360) von `c` nach `p`, gegen den Uhrzeigersinn. */
function angleDeg(c: Vec2, p: Vec2): number {
  const d = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

// ── Schraffur als geklippte Vektorlinien (Meter) ────────────────────────────
// Wie planToPrintSvg, aber in WELT-Metern statt Papier-mm. Die Kachelgrösse der
// Bildschirm-PlanView (8 bzw. 10 Einheiten × scale, 1 Einheit = 1/90 m) wird
// direkt in einen Meter-Linienabstand übersetzt.

interface Seg {
  a: Vec2;
  b: Vec2;
}

// Strichmuster (`dash`, mm-Papier) → Zyklus in WELT-Metern. Gleiche Umrechnung
// wie der Bildschirm/GL-Pfad: 1 mm ≙ (1/0.13) Kachel-Einheiten, 1 Einheit = 1/90 m.
// `null` = durchgezogen (keine Zerlegung). Ungerade Musterlängen werden verdoppelt.
const DASH_MM_TO_M = (1 / 0.13) * (1 / 90);
function dashCycleMeters(dash: number[] | null): number[] | null {
  if (!dash || dash.length === 0) return null;
  const pat = dash.map((d) => Math.max(0, d) * DASH_MM_TO_M).filter((d) => d > 0);
  if (pat.length === 0) return null;
  return pat.length % 2 === 0 ? pat : pat.concat(pat);
}

// Zerlegt EINE Schraffurlinie in ihre durchgezogenen Teilstücke gemäß `cycle`
// ([an, aus, …], Meter). Die Phase startet je Linie neu — visuell identisch zum
// SVG-`<pattern>`, das das Muster je Kachellinie zurücksetzt.
function dashSeg(seg: Seg, cycle: number[]): Seg[] {
  const out: Seg[] = [];
  const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  if (len < 1e-9) return out;
  const ux = (seg.b.x - seg.a.x) / len;
  const uy = (seg.b.y - seg.a.y) / len;
  let pos = 0;
  let idx = 0;
  let on = true;
  while (pos < len - 1e-9) {
    const step = Math.min(cycle[idx % cycle.length], len - pos);
    if (on && step > 1e-9) {
      out.push({
        a: { x: seg.a.x + ux * pos, y: seg.a.y + uy * pos },
        b: { x: seg.a.x + ux * (pos + step), y: seg.a.y + uy * (pos + step) },
      });
    }
    pos += step;
    idx++;
    on = !on;
  }
  return out;
}

function hatchSegments(
  poly: Vec2[],
  hatch: Extract<Primitive, { kind: "polygon" }>["hatch"],
): Seg[] {
  const unitM = 1 / 90;
  const tileM = (hatch.pattern === "insulation" ? 10 : 8) * hatch.scale * unitM;
  const spacing = Math.max(0.02, tileM); // Mindestabstand in Metern
  const angle = (hatch.angle * Math.PI) / 180;
  const segs: Seg[] = [];
  fillParallel(poly, angle, spacing, segs);
  if (hatch.pattern === "crosshatch") fillParallel(poly, angle + Math.PI / 2, spacing, segs);
  if (hatch.pattern === "insulation") fillParallel(poly, angle - Math.PI / 4, spacing, segs);
  return segs;
}

/**
 * Füllt ein Polygon mit parallelen Linien (Winkel/Abstand) und klippt jede Linie
 * per Scanline auf das Polygon. Robust für konvexe wie einfache konkave Polygone.
 */
function fillParallel(poly: Vec2[], angle: number, spacing: number, out: Seg[]): void {
  if (poly.length < 3 || spacing <= 0) return;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const nrm = { x: -dir.y, y: dir.x };
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of poly) {
    const t = p.x * nrm.x + p.y * nrm.y;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const start = Math.ceil(tMin / spacing) * spacing;
  for (let t = start; t <= tMax; t += spacing) {
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const ta = a.x * nrm.x + a.y * nrm.y;
      const tb = b.x * nrm.x + b.y * nrm.y;
      if (ta === tb) continue;
      const f = (t - ta) / (tb - ta);
      if (f < 0 || f > 1) continue;
      const px = a.x + (b.x - a.x) * f;
      const py = a.y + (b.y - a.y) * f;
      xs.push(px * dir.x + py * dir.y);
    }
    if (xs.length < 2) continue;
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const u0 = xs[k];
      const u1 = xs[k + 1];
      if (u1 - u0 < 1e-6) continue;
      out.push({
        a: { x: nrm.x * t + dir.x * u0, y: nrm.y * t + dir.y * u0 },
        b: { x: nrm.x * t + dir.x * u1, y: nrm.y * t + dir.y * u1 },
      });
    }
  }
}

// ── Farb-Umrechnung ─────────────────────────────────────────────────────────

/** "#rrggbb" → 0xRRGGBB (24-Bit True-Color). Fallback dunkelgrau. */
export function rgbFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0x111111;
  return parseInt(m[1], 16);
}

/**
 * Mappt eine Hex-Farbe auf den nächsten AutoCAD-Color-Index (ACI 1..255). Nutzt
 * die feste ACI-Standardpalette (die ersten 9 Indizes sind die Grundfarben) und
 * wählt per euklidischem RGB-Abstand den nächstliegenden. Robust genug, damit
 * Viewer ohne True-Color-Support trotzdem sinnvolle Farben zeigen.
 */
export function aciFromHex(hex: string): number {
  const rgb = rgbFromHex(hex);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  let best = 7;
  let bestDist = Infinity;
  for (const [idx, cr, cg, cb] of ACI_PALETTE) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
  }
  return best;
}

/** Millimeter → DXF-LWEIGHT (1/100 mm), gerundet auf gültige Stufen ≥ 0. */
export function mmToLwe(mm: number): number {
  return Math.max(0, Math.round(mm * 100));
}

/**
 * Verkürzte ACI-Standardpalette [index, r, g, b]. Deckt die geläufigen Töne ab;
 * für die Layer-Farben (meist gedämpfte Grau-/Bautöne) genügt das Nächste-Farbe-
 * Matching. Index 7 (weiss/schwarz) und die Grautöne 250..255 sind enthalten.
 */
const ACI_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 255, 0, 0],
  [2, 255, 255, 0],
  [3, 0, 255, 0],
  [4, 0, 255, 255],
  [5, 0, 0, 255],
  [6, 255, 0, 255],
  [7, 255, 255, 255],
  [8, 128, 128, 128],
  [9, 192, 192, 192],
  [30, 255, 128, 0],
  [40, 255, 191, 127],
  [250, 51, 51, 51],
  [251, 91, 91, 91],
  [252, 132, 132, 132],
  [253, 173, 173, 173],
  [254, 214, 214, 214],
  [255, 255, 255, 255],
];

/** Baut das DXF und löst den Download aus (Browser). */
export function savePlanDxf(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): void {
  const text = buildPlanDxf(plan, project, opts);
  const name = (opts.fileName ?? "grundriss").replace(/\.dxf$/i, "");
  const blob = new Blob([text], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.dxf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
