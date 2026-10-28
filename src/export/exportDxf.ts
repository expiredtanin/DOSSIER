// DXF-/DWG-Export des Grundrisses. Nutzt DIESELBE Quelle wie der PDF-Export — den
// Vektor-Plan (generatePlan → Primitive) — schreibt aber MODELL-SPACE-Geometrie
// in ECHTEN Metern (kein Papier-mm, keine Y-Spiegelung). So können nachgelagerte
// CAD-Nutzer beim Plot beliebig skalieren; die Datei ist masshaltig 1:1 in Metern.
//
// Layer entstehen aus den Kategorie-Ebenen des Projekts (Code + Name, Farbe,
// Linienstärke). Jede Entity liegt auf dem Layer ihrer Kategorie; Primitive ohne
// direkten Kategorie-Bezug (Tür-Symbole, Kontext, Schraffuren) landen auf
// sprechenden Sammel-Layern.
//
// Seit [C1]/[C2] (28.10.) schreibt Rust (acadrust, `src-tauri/fileio/src/export.rs`) die Datei:
// dieses Modul sammelt nur Ebenen und Entitäten aus dem `Plan` in eine flache Zeichnung
// (`FlatDrawing`, Kodierung s. export.rs) und übergibt sie. DXF = R2018 ASCII (UTF-8),
// DWG = R2018 — Begründung im Kopf von export.rs. Der frühere TS-Text-Writer
// (`dxfWriter.ts`) ist gelöscht. Das Format-Modul wird nachgeladen: vor `buildPlanDxf`/
// `buildPlanDwg` einmal `await loadFileio()` (savePlanDxf und die CLI tun das).

import type { Plan, Primitive } from "../plan/generatePlan";
import type { LayerCategory, Project, Vec2 } from "../model/types";
import { flattenCategories } from "../model/types";
import { buildRandomHatchRuns, zigzagPoints, motifPoints } from "../plan/glPlan/glPlanHatch";
import { plainText } from "../text/richText";
import { fileio, loadFileio } from "../engine/fileioWasm";

export interface ExportDxfOptions {
  /** Titel/Geschossname (nur als Kommentar-freundlicher Dateiname genutzt). */
  title?: string;
  /** Schraffurlinien mit ausgeben (true) oder nur Umrisse/Flächen (false). */
  includeHatches?: boolean;
  /** Dateiname des Downloads (mit/ohne Endung). */
  fileName?: string;
}

/** Ausgabeformat des Modell-Space-Exports. */
export type CadExportFormat = "dxf" | "dwg";

/** Sammel-Layer-Namen für Primitive ohne eigene Kategorie. */
const LAYER_HATCH = "HATCH";
const LAYER_SYMBOLS = "SYMBOLS";
const LAYER_CONTEXT = "CONTEXT";
const LAYER_DEFAULT = "PLAN";
/** Sammel-Layer für Extrusions-Footprints (truck-Integration) — die Quell-
 *  Drawing2D wird beim Extrudieren entfernt, es gibt also keine categoryCode
 *  mehr nachzuschlagen; eigener Layer statt Absturz in LAYER_DEFAULT. */
const LAYER_EXTRUSION = "EXTRUSION";

// ── Flache Zeichnung (Gegenstück zu src-tauri/fileio/src/export.rs) ─────────

const FLAT_VERSION = 1;
const REC_LAYER = 1;
const REC_LINE = 2;
const REC_POLYLINE = 3;
const REC_ARC = 4;
const REC_CIRCLE = 5;
const REC_TEXT = 6;

/**
 * Sammelt Ebenen und Entitäten als flachen Zahlenpuffer + Zeichenkettenliste. Ebenen sind
 * idempotent über den Namen; eine unbekannte Ebene wird mit Standardwerten (ACI 7, 0.25 mm)
 * angelegt — wie beim früheren Writer. Namen bereinigt Rust (`sanitize_layer_name`).
 */
export class FlatDrawing {
  private nums: number[] = [FLAT_VERSION];
  private strings: string[] = [];
  private layers = new Map<string, number>();

  private str(s: string): number {
    this.strings.push(s.replace(/\0/g, ""));
    return this.strings.length - 1;
  }

  /** Legt eine Ebene an (`rgb` 0xRRGGBB oder null = ACI 7, `lineWeight` in 1/100 mm). */
  addLayer(name: string, rgb: number | null, lineWeight: number): number {
    const known = this.layers.get(name);
    if (known !== undefined) return known;
    const idx = this.layers.size;
    this.layers.set(name, idx);
    this.nums.push(REC_LAYER, this.str(name), rgb ?? -1, lineWeight);
    return idx;
  }

  private layer(name: string): number {
    return this.layers.get(name) ?? this.addLayer(name, null, 25);
  }

  addLine(layer: string, a: Vec2, b: Vec2): void {
    this.nums.push(REC_LINE, this.layer(layer), a.x, a.y, b.x, b.y);
  }

  addPolyline(layer: string, pts: Vec2[], closed: boolean): void {
    if (pts.length < 2) return;
    this.nums.push(REC_POLYLINE, this.layer(layer), closed ? 1 : 0, pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
  }

  /** Bogen gegen den Uhrzeigersinn von `start` nach `end` (Radiant). */
  addArc(layer: string, center: Vec2, r: number, start: number, end: number): void {
    this.nums.push(REC_ARC, this.layer(layer), center.x, center.y, r, start, end);
  }

  addCircle(layer: string, center: Vec2, r: number): void {
    this.nums.push(REC_CIRCLE, this.layer(layer), center.x, center.y, r);
  }

  /** Einzeiliger Text (Höhe in Metern, Drehung in Radiant). */
  addText(layer: string, at: Vec2, height: number, rotation: number, value: string): void {
    this.nums.push(REC_TEXT, this.layer(layer), this.str(value), at.x, at.y, height, rotation);
  }

  /** Argumente für die Rust-Bindungen. */
  args(): [Float64Array, string] {
    return [Float64Array.from(this.nums), this.strings.join("\0")];
  }
}

/**
 * Baut aus einem Plan + Projekt die flache Zeichnung (Meter-Modell-Space).
 * Reihenfolge der Primitive bleibt erhalten.
 */
export function collectPlanDrawing(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): FlatDrawing {
  const includeHatches = opts.includeHatches ?? true;
  const dxf = new FlatDrawing();

  // 1) Layer aus den Kategorie-Ebenen anlegen (Code+Name als Layer-Name, Farbe,
  //    Linienstärke). So trägt die Datei echte, benannte Layer statt eines Flachs.
  const cats = flattenCategories(project.layers);
  const layerNameByCode = new Map<string, string>();
  for (const c of cats) {
    const name = layerName(c);
    layerNameByCode.set(c.code, name);
    dxf.addLayer(name, rgbFromHex(c.color), mmToLwe(c.lw));
  }
  // Sammel-Layer für kategorielose Primitive.
  dxf.addLayer(LAYER_SYMBOLS, 0x111111, 18);
  dxf.addLayer(LAYER_HATCH, 0x888888, 13);
  dxf.addLayer(LAYER_CONTEXT, 0x9aa3ad, 10);
  dxf.addLayer(LAYER_DEFAULT, 0x111111, 18);
  // Warmes Orange, identisch zum 3D-/Grundriss-Footprint der Extrusionen (EXTRUSION_STROKE/EXTRUSION_RGB).
  dxf.addLayer(LAYER_EXTRUSION, rgbFromHex("#d98c40"), 13);

  // 2) Rückverweise Primitiv → Kategorie: Wände/2D-Elemente tragen nur ihre ID im
  //    Plan; die Kategorie liegt am Projekt-Objekt. Damit landet jede Wand-/Drawing-
  //    Entity auf dem richtigen Layer.
  const codeByWall = new Map<string, string>();
  for (const w of project.walls) codeByWall.set(w.id, w.categoryCode);
  const codeByDrawing = new Map<string, string>();
  for (const d of project.drawings2d) codeByDrawing.set(d.id, d.categoryCode);
  const codeByColumn = new Map<string, string>();
  for (const c of project.columns ?? []) codeByColumn.set(c.id, c.categoryCode);
  const drawingLayer = (id: string | undefined, fallback: string): string =>
    id ? (layerNameByCode.get(codeByDrawing.get(id) ?? "") ?? LAYER_DEFAULT) : fallback;

  const layerFor = (p: Primitive): string => {
    if (p.kind === "polygon") {
      if (p.wallId) return layerNameByCode.get(codeByWall.get(p.wallId) ?? "") ?? LAYER_DEFAULT;
      if (p.drawingId) return drawingLayer(p.drawingId, LAYER_DEFAULT);
      if (p.columnId) return layerNameByCode.get(codeByColumn.get(p.columnId) ?? "") ?? LAYER_DEFAULT;
      if (p.extrudedSolidId) return LAYER_EXTRUSION;
      return LAYER_DEFAULT;
    }
    if (p.kind === "line") {
      if (p.cls === "context-line") return LAYER_CONTEXT;
      // Tür-Blatt/-Rahmen und Wand-Achsen: Symbol-Sammellayer.
      return drawingLayer(p.drawingId, LAYER_SYMBOLS);
    }
    // Texte von 2D-Elementen: Ebene ihrer Kategorie.
    if (p.kind === "drawingText") return drawingLayer(p.drawingId, LAYER_SYMBOLS);
    // Bögen: Tür-Schwenkbogen → Symbole.
    return LAYER_SYMBOLS;
  };

  // 3) Jedes Primitiv in Entities übersetzen.
  for (const p of plan.primitives) {
    emitPrimitive(dxf, p, layerFor(p), includeHatches);
  }
  return dxf;
}

/**
 * Baut aus einem Plan + Projekt einen vollständigen DXF-String (R2018 ASCII, Meter-Modell-Space).
 * Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function buildPlanDxf(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): string {
  return new TextDecoder().decode(writeCad("dxf", collectPlanDrawing(plan, project, opts)));
}

/** Wie {@link buildPlanDxf}, aber als DWG (R2018, Bytes). */
export function buildPlanDwg(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): Uint8Array {
  return writeCad("dwg", collectPlanDrawing(plan, project, opts));
}

/** Übergibt die flache Zeichnung an Rust; ein leeres Ergebnis wird zum Fehler mit Grund. */
function writeCad(format: CadExportFormat, drawing: FlatDrawing): Uint8Array {
  const m = fileio();
  const [flat, strings] = drawing.args();
  const bytes = format === "dxf" ? m.export_dxf_flat(flat, strings) : m.export_dwg_flat(flat, strings);
  if (bytes.length === 0) {
    const why = m.export_check_flat(flat, strings);
    throw new Error(`${format.toUpperCase()}-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
  }
  return bytes;
}

/** Layer-Name aus einer Kategorie: "Code_Name" (bereinigt Rust selbst). */
function layerName(c: LayerCategory): string {
  return `${c.code}_${c.name}`;
}

/** Schreibt ein Plan-Primitiv als passende Entity(en). */
function emitPrimitive(
  dxf: FlatDrawing,
  p: Primitive,
  layer: string,
  includeHatches: boolean,
): void {
  switch (p.kind) {
    case "line":
      if (p.zigzag) {
        // Zickzack-Linie → offene Polylinie (amplitude/wavelength Papier-mm →
        // Modell-Meter über dieselbe Kopplung wie das Strichmuster unten).
        const amp = p.zigzag.amplitude * DASH_MM_TO_M;
        const wav = p.zigzag.wavelength * DASH_MM_TO_M;
        dxf.addPolyline(layer, zigzagPoints(p.a, p.b, amp, wav), false);
      } else if (p.motif) {
        // Custom-Motiv → offene Polylinie (Papier-mm → Modell-Meter, wie unten).
        dxf.addPolyline(layer, motifPoints(p.a, p.b, p.motif, DASH_MM_TO_M), false);
      } else {
        dxf.addLine(layer, p.a, p.b);
      }
      break;

    case "arc":
      emitArc(dxf, p, layer);
      break;

    // Gezeichnete Kreise/Bögen (2D-Elemente). `drawingArc` läuft per Konvention
    // immer CCW von a0 nach a1 (s. planView/primitives), genau wie DXF-Bögen.
    case "drawingCircle":
      dxf.addCircle(layer, p.center, p.r);
      break;

    case "drawingArc":
      dxf.addArc(layer, p.center, p.r, p.a0, p.a1);
      break;

    // 2D-Text (neu mit [C2]; der alte Writer liess Texte weg): einzeiliger TEXT,
    // Ankerpunkt = Einfügepunkt, Absätze eines Rich-Text-Felds mit Leerzeichen verbunden.
    case "drawingText": {
      const value = p.doc ? plainText(p.doc) : p.text;
      if (value.trim() && p.heightM > 0) dxf.addText(layer, p.at, p.heightM, p.angle, value);
      break;
    }

    case "polygon": {
      const pts = p.pts;
      if (pts.length < 2) break;
      // Kreis-Approximationen (viele Segmente) bleiben als geschlossene Polylinie —
      // masshaltig und robust. Geschlossene Ringe bekommen das Ring-Flag.
      dxf.addPolyline(layer, pts, true);
      // Schraffur als geklippte Linien (optional). Vollfüllung/„none" tragen keine
      // sichtbaren Musterlinien → wir geben nur echte Muster (nicht solid/none) aus.
      // Bild-/Verlauf-Schraffur (kind==="image"/"gradient"): DXF trägt weder
      // Rasterbilder noch (hier) echte Farbverläufe → FALLBACK ohne
      // Musterlinien (nur die Umriss-Polylinie oben). Random-Vektor:
      // deterministische Streu-Striche (Modell-Meter, identischer Seed wie Bildschirm/PDF).
      if (
        includeHatches &&
        p.hatch.kind !== "image" &&
        p.hatch.kind !== "gradient" &&
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
 * Bogen-Primitiv → ARC. DXF-Bögen laufen gegen den Uhrzeigersinn von
 * Start- nach Endwinkel. Der Plan-Bogen ist über from/to definiert; die
 * Drehrichtung folgt dem Kreuzprodukt (positiv = CCW). Bei CW werden Start/Ende
 * getauscht, damit der kurze Bogen in der richtigen Richtung entsteht.
 */
function emitArc(
  dxf: FlatDrawing,
  p: Extract<Primitive, { kind: "arc" }>,
  layer: string,
): void {
  const a1 = angleRad(p.center, p.from);
  const a2 = angleRad(p.center, p.to);
  const v1 = { x: p.from.x - p.center.x, y: p.from.y - p.center.y };
  const v2 = { x: p.to.x - p.center.x, y: p.to.y - p.center.y };
  const cross = v1.x * v2.y - v1.y * v2.x;
  if (cross >= 0) {
    dxf.addArc(layer, p.center, p.r, a1, a2);
  } else {
    dxf.addArc(layer, p.center, p.r, a2, a1);
  }
}

/** Winkel (Radiant, 0..2π) von `c` nach `p`, gegen den Uhrzeigersinn. */
function angleRad(c: Vec2, p: Vec2): number {
  const a = Math.atan2(p.y - c.y, p.x - c.x);
  return a < 0 ? a + 2 * Math.PI : a;
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

// ── Farb-/Strich-Umrechnung ─────────────────────────────────────────────────
// (Die nächste ACI zur True-Color bestimmt acadrust mit der vollen 255er-Palette.)

/** "#rrggbb" → 0xRRGGBB (24-Bit True-Color). Fallback dunkelgrau. */
export function rgbFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0x111111;
  return parseInt(m[1], 16);
}

/** Millimeter → DXF-LWEIGHT (1/100 mm), gerundet auf gültige Stufen ≥ 0. */
export function mmToLwe(mm: number): number {
  return Math.max(0, Math.round(mm * 100));
}

/** Baut die Datei und löst den Download aus (Browser). Lädt das Format-Modul bei Bedarf. */
export async function savePlanDxf(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions & { format?: CadExportFormat } = {},
): Promise<void> {
  await loadFileio();
  const format = opts.format ?? "dxf";
  const data = writeCad(format, collectPlanDrawing(plan, project, opts));
  const name = (opts.fileName ?? "grundriss").replace(/\.(dxf|dwg)$/i, "");
  const blob = new Blob([data as BlobPart], { type: format === "dxf" ? "application/dxf" : "image/vnd.dwg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
