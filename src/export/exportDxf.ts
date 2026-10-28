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
  /** Schraffuren (echte HATCH-Entitäten: Vollfüllung, Linienmuster) mit ausgeben (true) oder nur Umrisse (false). */
  includeHatches?: boolean;
  /** Dateiname des Downloads (mit/ohne Endung). */
  fileName?: string;
}

/** Ausgabeformat des Modell-Space-Exports. */
export type CadExportFormat = "dxf" | "dxfbin" | "dwg";

/** Dateiendung zum Ausgabeformat (Binär-DXF trägt ebenfalls `.dxf`). */
export function cadExtension(format: CadExportFormat): "dxf" | "dwg" {
  return format === "dwg" ? "dwg" : "dxf";
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

// ── Flache Zeichnung (Gegenstück zu src-tauri/fileio/src/export.rs) ─────────

const FLAT_VERSION = 1;
const REC_LAYER = 1;
const REC_LINE = 2;
const REC_POLYLINE = 3;
const REC_ARC = 4;
const REC_CIRCLE = 5;
const REC_TEXT = 6;
const REC_HATCH = 7;
const REC_GRADIENT = 8;

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

  /**
   * Schraffur als echte HATCH-Entität (äusserer Rand `pts`, geschlossen). `solid` = Vollfüllung;
   * sonst Linienmuster aus `families` (Winkel in Radiant, Linienabstand in Metern; je Schar eine
   * Musterzeile) mit optionalem Strichmuster `dashes` (Meter: an, aus, …; leer = durchgezogen).
   * `rgb` null = Farbe der Ebene.
   */
  addHatch(
    layer: string,
    pts: Vec2[],
    opts: { solid: boolean; rgb: number | null; families?: { angle: number; spacing: number }[]; dashes?: number[] },
  ): void {
    if (pts.length < 3) return;
    const families = opts.solid ? [] : (opts.families ?? []);
    const dashes = opts.solid ? [] : (opts.dashes ?? []);
    this.nums.push(REC_HATCH, this.layer(layer), opts.solid ? 0 : 1, opts.rgb ?? -1, dashes.length, ...dashes, families.length);
    for (const f of families) this.nums.push(f.angle, f.spacing);
    this.nums.push(pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
  }

  /**
   * Zweifarben-Verlauf als echte Gradient-HATCH-Entität (Rand `pts`, geschlossen). `rgb1`/`rgb2` =
   * 0xRRGGBB; `angle` (Radiant) = Richtung von `rgb1` nach `rgb2` (nur linear); `radial`: `rgb1` in der
   * Mitte, `rgb2` am Rand.
   */
  addGradient(layer: string, pts: Vec2[], g: { rgb1: number; rgb2: number; angle: number; radial: boolean }): void {
    if (pts.length < 3) return;
    this.nums.push(REC_GRADIENT, this.layer(layer), g.rgb1, g.rgb2, g.angle, g.radial ? 1 : 0, pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
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

/** Wie {@link buildPlanDxf}, aber als Binär-DXF (R2018, Bytes; deutlich kleiner und schneller zu lesen). */
export function buildPlanDxfBinary(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): Uint8Array {
  return writeCad("dxfbin", collectPlanDrawing(plan, project, opts));
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
  const bytes =
    format === "dxf"
      ? m.export_dxf_flat(flat, strings)
      : format === "dxfbin"
        ? m.export_dxf_binary_flat(flat, strings)
        : m.export_dwg_flat(flat, strings);
  if (bytes.length === 0) {
    const why = m.export_check_flat(flat, strings);
    throw new Error(`${cadExtension(format).toUpperCase()}-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
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
      // Schraffur ([C2], 28.10.) als echte HATCH-Entität UNTER dem Umriss (Zeichenreihenfolge der
      // Datei): Vollfüllung bzw. Linienmuster (diagonal/Kreuz/Dämmung/frei, auch gestrichelt) mit dem
      // Polygon als Rand und der aufgelösten Vordergrundfarbe. Verlauf-Schraffur (kind==="gradient")
      // als echte Gradient-HATCH (zwei Farben, linear/radial); ohne lesbare Farben oder Bild-
      // Schraffur (kind==="image") trägt DXF das nicht → FALLBACK ohne Muster (nur der Umriss). Random-Vektor
      // (deterministische Streu-Striche, Modell-Meter, identischer Seed wie Bildschirm/PDF) hat kein
      // Musteräquivalent → bleibt als einzelne Linien auf dem HATCH-Layer.
      if (includeHatches && p.hatch.kind === "gradient" && pts.length >= 3) {
        const g = p.hatch.gradient;
        const rgb1 = g ? rgbOrNull(g.color1) : null;
        const rgb2 = g ? rgbOrNull(g.color2) : null;
        if (g && rgb1 !== null && rgb2 !== null && Number.isFinite(g.angle)) {
          // Richtung wie der SVG-Verlauf der Ansicht: Vektor (cos, sin) in Plan-Koordinaten = DXF-Winkel.
          dxf.addGradient(LAYER_HATCH, pts, { rgb1, rgb2, angle: (g.angle * Math.PI) / 180, radial: g.type === "radial" });
        }
      } else if (includeHatches && p.hatch.kind !== "image" && pts.length >= 3) {
        const h = p.hatch;
        if (h.pattern === "solid") {
          dxf.addHatch(LAYER_HATCH, pts, { solid: true, rgb: rgbOrNull(h.color) });
        } else if (h.pattern !== "none" && h.lines === "random") {
          const cycle = dashCycleMeters(h.dash);
          const segs: Seg[] = buildRandomHatchRuns(pts, h)
            .filter((r) => r.length >= 2)
            .map((r) => ({ a: r[0], b: r[r.length - 1] }));
          for (const seg of segs) {
            if (cycle) {
              for (const d of dashSeg(seg, cycle)) dxf.addLine(LAYER_HATCH, d.a, d.b);
            } else {
              dxf.addLine(LAYER_HATCH, seg.a, seg.b);
            }
          }
        } else if (h.pattern !== "none") {
          const families = hatchFamilies(h);
          if (families.length > 0) {
            dxf.addHatch(LAYER_HATCH, pts, { solid: false, rgb: rgbOrNull(h.color), families, dashes: dashCycleMeters(h.dash) ?? [] });
          }
        }
      }
      // Kreis-Approximationen (viele Segmente) bleiben als geschlossene Polylinie —
      // masshaltig und robust. Geschlossene Ringe bekommen das Ring-Flag.
      dxf.addPolyline(layer, pts, true);
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

// ── Schraffur-Muster in Metern ───────────────────────────────────────────────
// Die Kachelgrösse der Bildschirm-PlanView (8 bzw. 10 Einheiten × scale, 1 Einheit = 1/90 m) wird
// direkt in einen Meter-Linienabstand übersetzt (`hatchFamilies`); die Zufallsstriche und das
// Strichmuster laufen weiter über geklippte Segmente (`dashSeg`).

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

/**
 * Linienscharen einer Vektor-Schraffur als (Winkel in Radiant, Abstand in Metern): wie Bildschirm
 * und PDF eine Schar (diagonal, frei), Kreuzschraffur zusätzlich um 90° gedreht, Dämmung zusätzlich
 * bei −45°. Kachelgrösse wie `hatchSegments` früher: (8 bzw. 10) × scale / 90 m, mindestens 2 cm.
 */
function hatchFamilies(hatch: Extract<Primitive, { kind: "polygon" }>["hatch"]): { angle: number; spacing: number }[] {
  const unitM = 1 / 90;
  const tileM = (hatch.pattern === "insulation" ? 10 : 8) * hatch.scale * unitM;
  const spacing = Math.max(0.02, tileM); // Mindestabstand in Metern
  if (!Number.isFinite(spacing)) return [];
  const angle = (hatch.angle * Math.PI) / 180;
  const out = [{ angle, spacing }];
  if (hatch.pattern === "crosshatch") out.push({ angle: angle + Math.PI / 2, spacing });
  if (hatch.pattern === "insulation") out.push({ angle: angle - Math.PI / 4, spacing });
  return out;
}

// ── Farb-/Strich-Umrechnung ─────────────────────────────────────────────────
// (Die nächste ACI zur True-Color bestimmt acadrust mit der vollen 255er-Palette.)

/** "#rrggbb" → 0xRRGGBB (24-Bit True-Color). Fallback dunkelgrau. */
export function rgbFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0x111111;
  return parseInt(m[1], 16);
}

/** "#rrggbb" → 0xRRGGBB, bei unlesbarer Farbe (z. B. "none") null = Farbe der Ebene. */
function rgbOrNull(hex: string): number | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return parseInt(h, 16);
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
  const ext = cadExtension(format);
  const name = (opts.fileName ?? "grundriss").replace(/\.(dxf|dwg)$/i, "");
  const blob = new Blob([data as BlobPart], { type: ext === "dxf" ? "application/dxf" : "image/vnd.dwg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
