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
//
// Fachplaner-Export (28.10., [C2]): damit in AutoCAD/BricsCAD weitergearbeitet werden kann, entstehen
// statt loser Linien dort, wo das Modell die Information trägt, CAD-Objekte:
//   - Bemassungen (`Drawing2D {shape:"dimension"}`) → je Segment eine DIMENSION samt Anonymblock `*D…` und
//     Bemassungsstil (DIMSTYLE: Texthöhe/Strich/Abstände in Papier-mm, DIMSCALE = Massstab);
//   - Türen/Fenster (Primitive mit `openingId`) → BLOCK + INSERT in der Wandrichtung, gleiche Geometrie
//     teilt sich einen Block, ATTRIBs (Breite, Höhe, Typ, ID);
//   - Blockinstanzen (`Drawing2D {shape:"block"}`, Möbel/Symbole/Nordpfeil) → BLOCK je Definition + INSERT;
//   - Strichmuster → Linientypen (Name des Projekt-Linienstils), Texte → Textstile mit Schriftname und
//     Ausrichtung (Raumstempel mit Fläche als TEXT, links/Mitte/rechts), optional Papierbereich.
// Alles andere (Wände, Umrisse, Schraffuren) bleibt wie bisher Linie/Polylinie/HATCH.

import type { Plan, Primitive } from "../plan/generatePlan";
import type { Drawing2D, LayerCategory, Opening, Project, Vec2 } from "../model/types";
import type { Marks } from "../text/richText";
import { flattenCategories } from "../model/types";
import { DEFAULT_SCALE_DENOMINATOR, DIM_DEFAULTS_MM, dimTextFrame, dimTextPos, mmToModel } from "../model/dimension";
import { buildRandomHatchRuns, zigzagPoints, motifPoints } from "../plan/glPlan/glPlanHatch";
import { plainText } from "../text/richText";
import { docToLines } from "../text/renderHtml";
import { fileio, loadFileio } from "../engine/fileioWasm";
import { dashToLtypeMeters, fontNameOf, ltypeNameFor, paperFor, primitiveToLocal, roundKey } from "./dxfCadParts";
import type { LocalFrame } from "./dxfCadParts";

export interface ExportDxfOptions {
  /** Titel/Geschossname (nur als Kommentar-freundlicher Dateiname genutzt). */
  title?: string;
  /** Schraffuren (echte HATCH-Entitäten: Vollfüllung, Linienmuster) mit ausgeben (true) oder nur Umrisse (false). */
  includeHatches?: boolean;
  /** Dateiname des Downloads (mit/ohne Endung). */
  fileName?: string;
  /**
   * Massstabsnenner (100 = 1:100): macht aus Papier-Millimetern Modell-Meter — Texthöhe/Striche der
   * Bemassung, Strichmuster der Linientypen, Schriftgrösse der Raumstempel, Massstab des Ansichtsfensters.
   * Default 1:100 (wie `generatePlan`).
   */
  scaleDenominator?: number;
  /** Einheit der Masszahl: Meter (Default, wie im Plan „3.25") oder Zentimeter („325"). */
  dimUnit?: "m" | "cm";
  /** Zusätzlich ein Layout (Papierbereich) mit Ansichtsfenster im Planmassstab anlegen. */
  paperLayout?: boolean;
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
/** Schnittführungs-Symbole (Primitive mit `cls === "section-line"`). */
const LAYER_SECTIONS = "SECTIONS";
/** Sammel-Layer für Extrusions-Footprints (truck-Integration) — die Quell-
 *  Drawing2D wird beim Extrudieren entfernt, es gibt also keine categoryCode
 *  mehr nachzuschlagen; eigener Layer statt Absturz in LAYER_DEFAULT. */
const LAYER_EXTRUSION = "EXTRUSION";
/** Ebene „0": Inhalt von Blöcken (erbt die Ebene des INSERT). */
const LAYER_ZERO = "0";

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
const REC_LTYPE = 9;
const REC_LAYER_LTYPE = 10;
const REC_PEN = 11;
const REC_STYLE = 12;
const REC_TEXT2 = 13;
const REC_DIMSTYLE = 14;
const REC_DIM = 15;
const REC_BLOCK = 16;
const REC_BLOCK_END = 17;
const REC_INSERT = 18;
const REC_LAYOUT = 19;

/** Zustand, den eine Zeichnung und die Blockinhalte, die in sie hineingespleisst werden, teilen. */
interface FlatShared {
  /** Der Zahlenpuffer der Hauptzeichnung: Definitionen (Ebenen, Linientypen, Stile) landen immer hier, in Reihenfolge ihrer Indizes. */
  root: number[];
  strings: string[];
  strIdx: Map<string, number>;
  layers: Map<string, number>;
  ltypes: Map<string, number>;
  styles: Map<string, number>;
  dimStyles: Map<string, number>;
  blocks: Set<string>;
  /** Entitäten in Blockdefinitionen (Zählung für Tests). */
  blockCounts: Record<string, number>;
}

/** Eine Textzeile der Raumstempel/Textfelder für `addText2`. */
export interface TextAlignOpts {
  /** 0 links, 1 Mitte, 2 rechts (Anker = Einfügepunkt). */
  halign?: 0 | 1 | 2;
  /** Textstil-Index aus {@link FlatDrawing.addTextStyle}; −1 = Standard. */
  style?: number;
}

/**
 * Sammelt Ebenen und Entitäten als flachen Zahlenpuffer + Zeichenkettenliste. Ebenen sind
 * idempotent über den Namen; eine unbekannte Ebene wird mit Standardwerten (ACI 7, 0.25 mm)
 * angelegt — wie beim früheren Writer. Namen bereinigt Rust (`sanitize_layer_name`).
 *
 * `new FlatDrawing(parent)` ist ein Blockinhalt: er teilt Ebenen, Linientypen, Stile und Zeichenketten
 * (dedupliziert, gleiche Eingabe ⇒ gleiche Indizes) mit der Hauptzeichnung, hat aber einen eigenen
 * Entitätspuffer, der mit {@link defineBlock} an die Stelle der Blockdefinition kommt.
 */
export class FlatDrawing {
  private sh: FlatShared;
  private nums: number[];
  /** Aktueller Linientyp (PEN) dieses Puffers; −1 = nach Ebene. */
  private pen = -1;
  /** Entitäten dieses Puffers je Typ (Tests). */
  private counts: Record<string, number> = {};

  constructor(parent?: FlatDrawing) {
    if (parent) {
      this.sh = parent.sh;
      this.nums = [];
    } else {
      this.nums = [FLAT_VERSION];
      this.sh = {
        root: this.nums,
        strings: [],
        strIdx: new Map(),
        layers: new Map(),
        ltypes: new Map(),
        styles: new Map(),
        dimStyles: new Map(),
        blocks: new Set(),
        blockCounts: {},
      };
    }
  }

  private str(s: string): number {
    const clean = s.replace(/\0/g, "");
    const known = this.sh.strIdx.get(clean);
    if (known !== undefined) return known;
    this.sh.strings.push(clean);
    this.sh.strIdx.set(clean, this.sh.strings.length - 1);
    return this.sh.strings.length - 1;
  }

  private bump(kind: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
  }

  /** Anzahl Entitäten im Modellbereich je Typ (INSERT/DIMENSION zählen je als eine) und in Blöcken (Summe je Typ). */
  stats(): { model: Record<string, number>; blocks: Record<string, number> } {
    return { model: { ...this.counts }, blocks: { ...this.sh.blockCounts } };
  }

  /** Legt eine Ebene an (`rgb` 0xRRGGBB oder null = ACI 7, `lineWeight` in 1/100 mm). */
  addLayer(name: string, rgb: number | null, lineWeight: number): number {
    const known = this.sh.layers.get(name);
    if (known !== undefined) return known;
    const idx = this.sh.layers.size;
    this.sh.layers.set(name, idx);
    this.sh.root.push(REC_LAYER, this.str(name), rgb ?? -1, lineWeight);
    return idx;
  }

  private layer(name: string): number {
    return this.sh.layers.get(name) ?? this.addLayer(name, null, 25);
  }

  /**
   * Linientyp (Elemente in Metern: Strich +, Lücke −, Punkt 0; mindestens zwei Elemente), idempotent
   * über den Namen. Gibt den Index für {@link setPen}/{@link setLayerLinetype} zurück.
   */
  addLinetype(name: string, elements: number[]): number {
    const known = this.sh.ltypes.get(name);
    if (known !== undefined) return known;
    const idx = this.sh.ltypes.size;
    this.sh.ltypes.set(name, idx);
    this.sh.root.push(REC_LTYPE, this.str(name), elements.length, ...elements);
    return idx;
  }

  /** Standard-Linientyp einer bereits angelegten Ebene. */
  setLayerLinetype(layerName: string, ltype: number): void {
    this.sh.root.push(REC_LAYER_LTYPE, this.layer(layerName), ltype);
  }

  /** Linientyp für die folgenden Linien/Bögen/Kreise/Polylinien (−1 = nach Ebene). Schreibt nur bei Änderung. */
  setPen(ltype: number): void {
    if (ltype === this.pen) return;
    this.pen = ltype;
    this.nums.push(REC_PEN, ltype);
  }

  /** Textstil mit TrueType-Schriftname (CAD löst ihn über das Betriebssystem auf), idempotent über den Namen. */
  addTextStyle(name: string, font: string, bold = false, italic = false): number {
    const known = this.sh.styles.get(name);
    if (known !== undefined) return known;
    const idx = this.sh.styles.size;
    this.sh.styles.set(name, idx);
    this.sh.root.push(REC_STYLE, this.str(name), this.str(font), bold ? 1 : 0, italic ? 1 : 0, 1);
    return idx;
  }

  addLine(layer: string, a: Vec2, b: Vec2): void {
    this.bump("LINE");
    this.nums.push(REC_LINE, this.layer(layer), a.x, a.y, b.x, b.y);
  }

  addPolyline(layer: string, pts: Vec2[], closed: boolean): void {
    if (pts.length < 2) return;
    this.bump("LWPOLYLINE");
    this.nums.push(REC_POLYLINE, this.layer(layer), closed ? 1 : 0, pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
  }

  /** Bogen gegen den Uhrzeigersinn von `start` nach `end` (Radiant). */
  addArc(layer: string, center: Vec2, r: number, start: number, end: number): void {
    this.bump("ARC");
    this.nums.push(REC_ARC, this.layer(layer), center.x, center.y, r, start, end);
  }

  addCircle(layer: string, center: Vec2, r: number): void {
    this.bump("CIRCLE");
    this.nums.push(REC_CIRCLE, this.layer(layer), center.x, center.y, r);
  }

  /** Einzeiliger Text (Höhe in Metern, Drehung in Radiant). */
  addText(layer: string, at: Vec2, height: number, rotation: number, value: string): void {
    this.bump("TEXT");
    this.nums.push(REC_TEXT, this.layer(layer), this.str(value), at.x, at.y, height, rotation);
  }

  /** Einzeiliger Text mit Ausrichtung (Anker = Einfügepunkt, Grundlinie) und Textstil. */
  addText2(layer: string, at: Vec2, height: number, rotation: number, value: string, o: TextAlignOpts = {}): void {
    this.bump("TEXT");
    this.nums.push(REC_TEXT2, this.layer(layer), this.str(value), at.x, at.y, height, rotation, o.halign ?? 0, o.style ?? -1);
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
    this.bump("HATCH");
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
    this.bump("HATCH");
    this.nums.push(REC_GRADIENT, this.layer(layer), g.rgb1, g.rgb2, g.angle, g.radial ? 1 : 0, pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
  }

  /**
   * Bemassungsstil (Papier-Meter, s. `export_dim.rs`), idempotent über `name`. `textStyle` = Index aus
   * {@link addTextStyle} oder −1; `post` = Format mit `<>` als Platzhalter der Zahl (oder leer).
   */
  addDimStyle(
    name: string,
    d: { textStyle: number; scale: number; txt: number; tick: number; exo: number; exe: number; gap: number; dec: number; lfac: number; post?: string },
  ): number {
    const known = this.sh.dimStyles.get(name);
    if (known !== undefined) return known;
    const idx = this.sh.dimStyles.size;
    this.sh.dimStyles.set(name, idx);
    this.sh.root.push(
      REC_DIMSTYLE, this.str(name), d.textStyle, d.scale, d.txt, d.tick, d.exo, d.exe, d.gap, d.dec, d.lfac,
      d.post ? this.str(d.post) : -1,
    );
    return idx;
  }

  /**
   * Ausgerichtete Bemassung (DIMENSION + Anonymblock `*D…`) zwischen `p1` und `p2`; `onLine` = ein Punkt
   * auf der Masslinie (legt Seite und Abstand fest), `textAt` = freie Lage der Masszahl (Mitte).
   */
  addDimension(layer: string, dimStyle: number, p1: Vec2, p2: Vec2, onLine: Vec2, textAt?: Vec2): void {
    this.bump("DIMENSION");
    this.nums.push(REC_DIM, this.layer(layer), dimStyle, p1.x, p1.y, p2.x, p2.y, onLine.x, onLine.y, textAt ? 1 : 0, textAt?.x ?? 0, textAt?.y ?? 0);
  }

  /** Ob ein Block dieses Namens schon definiert ist. */
  hasBlock(name: string): boolean {
    return this.sh.blocks.has(name);
  }

  /**
   * Blockdefinition: der Inhalt `content` (ein `new FlatDrawing(this)`) kommt mit blocklokalen Koordinaten
   * an diese Stelle. `atts` = Attributdefinitionen (unsichtbar; Wert je INSERT).
   */
  defineBlock(name: string, description: string, atts: { tag: string; prompt: string; def: string }[], content: FlatDrawing): void {
    if (this.sh.blocks.has(name)) return;
    this.sh.blocks.add(name);
    this.nums.push(REC_BLOCK, this.str(name), description ? this.str(description) : -1, atts.length);
    for (const a of atts) this.nums.push(this.str(a.tag), this.str(a.prompt), this.str(a.def), 0, 0, 0.1);
    // Der Block beginnt mit „nach Ebene“; danach gilt der Linientyp, mit dem sein Inhalt endete.
    this.nums.push(REC_PEN, -1);
    for (const v of content.nums) this.nums.push(v);
    this.nums.push(REC_BLOCK_END);
    this.pen = content.pen;
    for (const [k, n] of Object.entries(content.counts)) this.sh.blockCounts[k] = (this.sh.blockCounts[k] ?? 0) + n;
  }

  /** Inhalt eines Blocks als Schlüssel: gleiche Zahlen (auf 1 mm gerundet) ⇒ gleicher Block. */
  contentKey(): string {
    return roundKey(this.nums);
  }

  /** Blockeinfügung mit Attributwerten (`tag` → Wert). */
  addInsert(layer: string, name: string, at: Vec2, rotation: number, scale: number, values: { tag: string; value: string }[] = []): void {
    this.bump("INSERT");
    this.nums.push(REC_INSERT, this.layer(layer), this.str(name), at.x, at.y, rotation, scale, scale, values.length);
    for (const v of values) this.nums.push(this.str(v.tag), this.str(v.value));
  }

  /**
   * Papierbereich: Layout `name` (Papier in mm) mit einem Ansichtsfenster auf den Modellbereich.
   * `vp` = Mittelpunkt und Grösse des Fensters auf dem Papier (mm), `view` = Mittelpunkt des Ausschnitts im Modell.
   */
  addLayout(name: string, paperW: number, paperH: number, vp: { cx: number; cy: number; w: number; h: number }, view: Vec2, scaleDenominator: number): void {
    this.nums.push(REC_LAYOUT, this.str(name), paperW, paperH, vp.cx, vp.cy, vp.w, vp.h, view.x, view.y, scaleDenominator);
  }

  /** Argumente für die Rust-Bindungen. */
  args(): [Float64Array, string] {
    return [Float64Array.from(this.nums), this.sh.strings.join("\0")];
  }
}

// ── Plan → flache Zeichnung ─────────────────────────────────────────────────

/** Gemeinsamer Zustand beim Sammeln eines Plans. */
interface Ctx {
  project: Project;
  scale: number;
  includeHatches: boolean;
  dimUnit: "m" | "cm";
  /** Ebenenname je Kategorie-Code. */
  layerNameByCode: Map<string, string>;
  /** Kategorie-Code je Zeichen-Element / Raum (für Ebenen). */
  codeByDrawing: Map<string, string>;
  codeByRoom: Map<string, string>;
  /** Linientyp-Index zu einem Strichmuster (−1 = durchgezogen). */
  ltypeOf: (dxf: FlatDrawing, dash: number[] | null | undefined) => number;
  /** Textstil-Index zu einer Formatierung. */
  styleOf: (dxf: FlatDrawing, marks?: Marks) => number;
}

/** Eine Zeile einer (Rich-)Text-Ausgabe. */
interface OutLine {
  text: string;
  /** Schrifthöhe (Meter). */
  height: number;
  align: 0 | 1 | 2;
  marks?: Marks;
  /** Versatz der Grundlinie vom Anker nach unten (Meter, ≥ 0 für spätere Zeilen). */
  down: number;
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
  const scale = opts.scaleDenominator && Number.isFinite(opts.scaleDenominator) && opts.scaleDenominator > 0 ? opts.scaleDenominator : DEFAULT_SCALE_DENOMINATOR;
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
  dxf.addLayer(LAYER_SECTIONS, 0x111111, 18);
  // Warmes Orange, identisch zum 3D-/Grundriss-Footprint der Extrusionen (EXTRUSION_STROKE/EXTRUSION_RGB).
  dxf.addLayer(LAYER_EXTRUSION, rgbFromHex("#d98c40"), 13);
  dxf.addLayer(LAYER_ZERO, null, 25); // Blockinhalt; „0" gibt es in jeder Datei, der Eintrag legt nur den Index fest

  // 2) Rückverweise Primitiv → Kategorie: Wände/2D-Elemente tragen nur ihre ID im
  //    Plan; die Kategorie liegt am Projekt-Objekt. Damit landet jede Wand-/Drawing-
  //    Entity auf dem richtigen Layer.
  const codeByWall = new Map<string, string>();
  for (const w of project.walls) codeByWall.set(w.id, w.categoryCode);
  const codeByDrawing = new Map<string, string>();
  for (const d of project.drawings2d) codeByDrawing.set(d.id, d.categoryCode);
  const codeByColumn = new Map<string, string>();
  for (const c of project.columns ?? []) codeByColumn.set(c.id, c.categoryCode);
  const codeByRoom = new Map<string, string>();
  for (const r of project.rooms ?? []) codeByRoom.set(r.id, r.categoryCode);
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
      if (p.cls === "section-line") return LAYER_SECTIONS;
      // Tür-Blatt/-Rahmen und Wand-Achsen: Symbol-Sammellayer.
      return drawingLayer(p.drawingId, LAYER_SYMBOLS);
    }
    // Texte von 2D-Elementen: Ebene ihrer Kategorie.
    if (p.kind === "drawingText") return drawingLayer(p.drawingId, LAYER_SYMBOLS);
    if (p.kind === "text") return p.roomId ? (layerNameByCode.get(codeByRoom.get(p.roomId) ?? "") ?? LAYER_SYMBOLS) : LAYER_SYMBOLS;
    // Bögen: Tür-Schwenkbogen → Symbole.
    return LAYER_SYMBOLS;
  };

  // Standard-Schrift: erste im Projekt hinterlegte Schrift der Textstile, sonst Arial.
  const defaultFont = (project.textStyles ?? []).map((s) => fontNameOf(s.marks.font)).find((f) => f) ?? "Arial";
  const ctx: Ctx = {
    project,
    scale,
    includeHatches,
    dimUnit: opts.dimUnit ?? "m",
    layerNameByCode,
    codeByDrawing,
    codeByRoom,
    ltypeOf: (d, dash) => {
      if (!dash || dash.length === 0) return -1;
      const el = dashToLtypeMeters(dash, scale);
      return el ? d.addLinetype(ltypeNameFor(dash, project.lineStyles), el) : -1;
    },
    styleOf: (d, marks) => {
      const family = fontNameOf(marks?.font) ?? defaultFont;
      const bold = !!marks?.bold;
      const italic = !!marks?.italic;
      const plain = family === defaultFont && !bold && !italic;
      const name = plain ? "DOSSIER" : `DOSSIER_${family}${bold ? "_B" : ""}${italic ? "_I" : ""}`;
      return d.addTextStyle(name, family, bold, italic);
    },
  };

  // 3) Gruppen: Bemassungen, Blockinstanzen und Öffnungen werden zu CAD-Objekten statt zu losen Primitiven.
  const dimById = new Map<string, Drawing2D>();
  const blockById = new Map<string, Drawing2D>();
  for (const d of project.drawings2d) {
    if (d.geom?.shape === "dimension") dimById.set(d.id, d);
    else if (d.geom?.shape === "block") blockById.set(d.id, d);
  }
  const openingById = new Map<string, Opening>();
  for (const o of project.openings ?? []) openingById.set(o.id, o);
  const groupKeyOf = (p: Primitive): string | null => {
    const did = "drawingId" in p ? p.drawingId : undefined;
    if (did && dimById.has(did)) return `d:${did}`;
    if (did && blockById.has(did)) return `b:${did}`;
    const oid = "openingId" in p ? p.openingId : undefined;
    if (oid && openingById.has(oid)) return `o:${oid}`;
    return null;
  };
  const groups = new Map<string, Primitive[]>();
  for (const p of plan.primitives) {
    const k = groupKeyOf(p);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  const blockNames = new BlockNames();
  const doneGroups = new Set<string>();

  // 4) Jedes Primitiv in Entities übersetzen.
  for (const p of plan.primitives) {
    const key = groupKeyOf(p);
    if (key) {
      if (doneGroups.has(key)) continue;
      doneGroups.add(key);
      const prims = groups.get(key) ?? [];
      if (key.startsWith("d:")) emitDimensions(dxf, ctx, dimById.get(key.slice(2))!, drawingLayer(key.slice(2), LAYER_DEFAULT));
      else if (key.startsWith("b:")) {
        const d = blockById.get(key.slice(2))!;
        if (!emitBlockInstance(dxf, ctx, d, prims, drawingLayer(d.id, LAYER_DEFAULT), blockNames)) for (const q of prims) emitPrimitive(dxf, ctx, q, layerFor(q), LAYER_HATCH);
      } else {
        const o = openingById.get(key.slice(2))!;
        if (!emitOpening(dxf, ctx, o, prims, layerNameByCode.get(o.categoryCode) ?? LAYER_SYMBOLS, blockNames)) for (const q of prims) emitPrimitive(dxf, ctx, q, layerFor(q), LAYER_HATCH);
      }
      continue;
    }
    emitPrimitive(dxf, ctx, p, layerFor(p), LAYER_HATCH);
  }
  dxf.setPen(-1);

  // 5) Papierbereich (optional): ein Layout mit Ansichtsfenster im Planmassstab auf die Plan-Ausdehnung.
  if (opts.paperLayout) addPaperLayout(dxf, plan, scale);
  return dxf;
}

/** Eindeutige Blocknamen: gleiche Schlüssel teilen sich einen Namen, verschiedene Inhalte mit gleichem Wunschnamen werden nummeriert. */
class BlockNames {
  private byKey = new Map<string, string>();
  private used = new Set<string>();
  /** Name zum Schlüssel; `fresh` = der Block muss noch definiert werden. */
  name(key: string, wish: string): { name: string; fresh: boolean } {
    const known = this.byKey.get(key);
    if (known) return { name: known, fresh: false };
    let name = wish;
    for (let i = 2; this.used.has(name.toLowerCase()); i++) name = `${wish}_${i}`;
    this.used.add(name.toLowerCase());
    this.byKey.set(key, name);
    return { name, fresh: true };
  }
}

/** Papierbereich auf die Ausdehnung des Plans (Meter) im Massstab `scale`. */
function addPaperLayout(dxf: FlatDrawing, plan: Plan, scale: number): void {
  const b = plan.bounds;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || w <= 0 || h <= 0) return;
  const margin = 10;
  const paper = paperFor(w, h, scale, margin);
  dxf.addLayout(
    `Plan 1-${scale}`,
    paper.paperW,
    paper.paperH,
    { cx: paper.paperW / 2, cy: paper.paperH / 2, w: paper.vpW, h: paper.vpH },
    { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    scale,
  );
}

/** Format einer Länge für Attribute: Meter, 2 Nachkommastellen. */
function m2(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "";
}

/** Bemassungskette → je Segment eine DIMENSION; Stil aus den Papier-mm-Feinheiten und dem Massstab. */
function emitDimensions(dxf: FlatDrawing, ctx: Ctx, d: Drawing2D, layer: string): void {
  const g = d.geom;
  if (g.shape !== "dimension") return;
  const th = g.textHeightMm ?? DIM_DEFAULTS_MM.textHeight;
  const tick = g.tickLenMm ?? DIM_DEFAULTS_MM.tickLen;
  const gap = g.gapMm ?? DIM_DEFAULTS_MM.gap;
  const over = g.overshootMm ?? DIM_DEFAULTS_MM.overshoot;
  if (![th, tick, gap, over].every((v) => Number.isFinite(v) && v >= 0) || th <= 0) return;
  const cm = ctx.dimUnit === "cm";
  const isDefault = th === DIM_DEFAULTS_MM.textHeight && tick === DIM_DEFAULTS_MM.tickLen && gap === DIM_DEFAULTS_MM.gap && over === DIM_DEFAULTS_MM.overshoot;
  const variant = isDefault ? "" : `_${th}-${tick}-${gap}-${over}`.replace(/\./g, ",");
  const name = `DOSSIER_1-${ctx.scale}${cm ? "_cm" : ""}${variant}`;
  const style = dxf.addDimStyle(name, {
    textStyle: ctx.styleOf(dxf),
    scale: ctx.scale,
    txt: th / 1000,
    tick: tick / 1000,
    exo: gap / 1000,
    exe: over / 1000,
    gap: (th * 0.6) / 1000, // Unterkante der Zahl 0.6 × Texthöhe über der Masslinie, wie im Plan
    dec: cm ? 0 : 2,
    lfac: cm ? 100 : 1,
  });
  const mm = (v: number) => mmToModel(v, ctx.scale);
  const textH = mm(th);
  for (let i = 0; i + 1 < g.pts.length; i++) {
    const a = g.pts[i];
    const b = g.pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const onLine = { x: a.x + nx * g.offset, y: a.y + ny * g.offset };
    // Von Hand verschobene Masszahl: Mitte = Grundlinienpunkt des Plans + halbe Texthöhe quer zur Linie.
    const o = g.textOffsetsMm?.[i];
    let textAt: Vec2 | undefined;
    if (o && (o.along !== 0 || o.perp !== 0)) {
      const base = dimTextPos(a, b, g.offset, textH, { along: mm(o.along), perp: mm(o.perp) });
      const up = dimTextFrame(a, b, g.offset, textH).up;
      textAt = { x: base.x + up.x * (textH / 2), y: base.y + up.y * (textH / 2) };
    }
    dxf.addDimension(layer, style, a, b, onLine, textAt);
  }
}

/** Blockinstanz (`Drawing2D {shape:"block"}`) → BLOCK je Definition (lokale Geometrie) + INSERT. */
function emitBlockInstance(dxf: FlatDrawing, ctx: Ctx, d: Drawing2D, prims: Primitive[], layer: string, names: BlockNames): boolean {
  const g = d.geom;
  if (g.shape !== "block") return false;
  const def = ctx.project.blockDefs?.find((b) => b.id === g.blockDefId);
  const s = g.scale ?? 1;
  if (!def || !(s > 0) || !Number.isFinite(s) || !Number.isFinite(g.rotation) || !Number.isFinite(g.at.x) || !Number.isFinite(g.at.y)) return false;
  const { name, fresh } = names.name(`blockdef:${def.id}`, def.name.trim() || "Block");
  if (fresh) {
    const frame: LocalFrame = { origin: g.at, rot: g.rotation, scale: s };
    const content = new FlatDrawing(dxf);
    for (const p of prims) {
      const lp = primitiveToLocal(p, frame);
      if (lp) emitPrimitive(content, ctx, lp, LAYER_ZERO, LAYER_ZERO);
    }
    content.setPen(-1);
    dxf.defineBlock(name, def.name, [], content);
  }
  dxf.addInsert(layer, name, g.at, g.rotation, s);
  return true;
}

/** Tür/Fenster → BLOCK (Geometrie in der Wandrichtung, am ersten Pfosten verankert) + INSERT mit Attributen. */
function emitOpening(dxf: FlatDrawing, ctx: Ctx, o: Opening, prims: Primitive[], layer: string, names: BlockNames): boolean {
  const wall = ctx.project.walls.find((w) => w.id === o.hostWallId);
  if (!wall) return false;
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (len < 1e-6 || !Number.isFinite(o.position)) return false;
  const ux = (wall.end.x - wall.start.x) / len;
  const uy = (wall.end.y - wall.start.y) / len;
  const origin = { x: wall.start.x + ux * o.position, y: wall.start.y + uy * o.position };
  const rot = Math.atan2(uy, ux);
  const frame: LocalFrame = { origin, rot, scale: 1 };
  const content = new FlatDrawing(dxf);
  for (const p of prims) {
    const lp = primitiveToLocal(p, frame);
    if (lp) emitPrimitive(content, ctx, lp, LAYER_ZERO, LAYER_ZERO);
  }
  content.setPen(-1);
  const isDoor = o.kind === "door";
  const kindName = !isDoor ? "Fenster" : o.doorType === "wandoeffnung" ? "Wandoeffnung" : "Tuer";
  const cm = (v: number) => String(Math.round(v * 100));
  const wish = `${kindName}_${cm(o.width)}x${cm(o.height)}`;
  const { name, fresh } = names.name(`${kindName}:${content.contentKey()}`, wish);
  const atts = [
    { tag: "ID", prompt: "Kennung", def: "" },
    { tag: "TYP", prompt: "Art", def: kindName },
    { tag: "TYPENAME", prompt: "Typ", def: "" },
    { tag: "BREITE_M", prompt: "Breite [m]", def: "" },
    { tag: "HOEHE_M", prompt: "Hoehe [m]", def: "" },
    ...(isDoor ? [] : [{ tag: "BRUESTUNG_M", prompt: "Bruestung [m]", def: "" }]),
  ];
  if (fresh) {
    const label = !isDoor ? "Fenster" : o.doorType === "wandoeffnung" ? "Wandöffnung" : "Tür";
    dxf.defineBlock(name, `${label} ${m2(o.width)} × ${m2(o.height)} m`, atts, content);
  }
  const typeName = (isDoor ? ctx.project.doorTypes : ctx.project.windowTypes)?.find((t) => t.id === o.typeId)?.name ?? "";
  const label = !isDoor ? "Fenster" : o.doorType === "wandoeffnung" ? "Wandöffnung" : "Tür";
  dxf.addInsert(layer, name, origin, rot, 1, [
    { tag: "ID", value: o.id },
    { tag: "TYP", value: label },
    { tag: "TYPENAME", value: typeName },
    { tag: "BREITE_M", value: m2(o.width) },
    { tag: "HOEHE_M", value: m2(o.height) },
    ...(isDoor ? [] : [{ tag: "BRUESTUNG_M", value: m2(o.sillHeight) }]),
  ]);
  return true;
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

/** Stempel-/Textzeilen eines Primitivs `text` (Raumstempel): Rich-Text-Doc + Live-Zeilen, vertikal um den Anker zentriert wie in der Plan-Ansicht. */
function stampLines(p: Extract<Primitive, { kind: "text" }>, scale: number): OutLine[] {
  const unitPerPt = (0.0254 / 72) * scale; // 1 pt Papier in Modell-Metern
  const baseFs = p.basePt * unitPerPt;
  const lineGap = baseFs * 1.3;
  const docLines = docToLines(p.doc, { x: 0, y: 0, lineHeight: lineGap, unitPerPt, basePt: p.basePt, color: p.color });
  const lines = [
    ...docLines.map((l) => ({ align: l.align, lineHeight: l.lineHeight, ts: l.tspans })),
    ...p.extraLines.map((l) => ({ align: l.align, lineHeight: lineGap, ts: [{ text: l.text, fontSize: baseFs * 0.8, fontFamily: undefined as string | undefined, fontWeight: undefined as string | undefined, fontStyle: undefined as string | undefined }] })),
  ];
  if (lines.length === 0) return [];
  const totalH = baseFs + lines.slice(1).reduce((s, l) => s + l.lineHeight, 0);
  let down = -totalH / 2 + baseFs * 0.8;
  const out: OutLine[] = [];
  lines.forEach((l, k) => {
    if (k > 0) down += l.lineHeight;
    const text = l.ts.map((t) => t.text).join("");
    const first = l.ts[0];
    if (!text.trim() || !first) return;
    out.push({
      text,
      height: Math.max(...l.ts.map((t) => t.fontSize)),
      align: l.align === "center" ? 1 : l.align === "right" ? 2 : 0,
      marks: { font: first.fontFamily, bold: first.fontWeight === "700", italic: first.fontStyle === "italic" },
      down,
    });
  });
  return out;
}

/** Zeilen eines `drawingText`: Absätze bzw. Zeilenumbrüche, bei Spaltenbreite wortweise umbrochen; Zeilenabstand wie die Plan-Ansicht (1.25 × Höhe). */
function drawingTextLines(p: Extract<Primitive, { kind: "drawingText" }>): OutLine[] {
  const paragraphs = p.doc ? plainText(p.doc).split("\n") : p.text.split(/\r?\n/);
  const lines: string[] = [];
  if (p.wrapWidth && p.wrapWidth > 0) {
    const maxChars = Math.max(1, Math.floor(p.wrapWidth / (p.heightM * 0.55)));
    for (const para of paragraphs) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        if (line === "") line = word;
        else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
  } else {
    lines.push(...paragraphs);
  }
  const marks = p.marks ?? p.doc?.paragraphs[0]?.runs[0]?.marks;
  return lines.map((text, k) => ({ text, height: p.heightM, align: 0 as const, marks, down: k * p.heightM * 1.25 }));
}

/** Schreibt ein Plan-Primitiv als passende Entity(en). `hatchLayer` = Ebene der Schraffuren (in Blöcken „0"). */
function emitPrimitive(
  dxf: FlatDrawing,
  ctx: Ctx,
  p: Primitive,
  layer: string,
  hatchLayer: string,
): void {
  const includeHatches = ctx.includeHatches;
  switch (p.kind) {
    case "line":
      if (p.zigzag) {
        // Zickzack-Linie → offene Polylinie (amplitude/wavelength Papier-mm →
        // Modell-Meter über dieselbe Kopplung wie das Strichmuster unten).
        const amp = p.zigzag.amplitude * DASH_MM_TO_M;
        const wav = p.zigzag.wavelength * DASH_MM_TO_M;
        dxf.setPen(-1);
        dxf.addPolyline(layer, zigzagPoints(p.a, p.b, amp, wav), false);
      } else if (p.motif) {
        // Custom-Motiv → offene Polylinie (Papier-mm → Modell-Meter, wie unten).
        dxf.setPen(-1);
        dxf.addPolyline(layer, motifPoints(p.a, p.b, p.motif, DASH_MM_TO_M), false);
      } else {
        dxf.setPen(ctx.ltypeOf(dxf, p.dash));
        dxf.addLine(layer, p.a, p.b);
      }
      break;

    case "arc":
      dxf.setPen(ctx.ltypeOf(dxf, p.dash));
      emitArc(dxf, p, layer);
      break;

    // Gezeichnete Kreise/Bögen (2D-Elemente). `drawingArc` läuft per Konvention
    // immer CCW von a0 nach a1 (s. planView/primitives), genau wie DXF-Bögen.
    case "drawingCircle":
      dxf.setPen(ctx.ltypeOf(dxf, p.dash));
      dxf.addCircle(layer, p.center, p.r);
      break;

    case "drawingArc":
      dxf.setPen(ctx.ltypeOf(dxf, p.dash));
      dxf.addArc(layer, p.center, p.r, p.a0, p.a1);
      break;

    // 2D-Text: TEXT mit Textstil (Schriftname aus den Formatierungen, sonst Projekt-Schrift/Arial), linksbündig an
    // der Grundlinie wie in der Plan-Ansicht; mehrere Absätze/Spaltenbreite als mehrere Zeilen darunter.
    case "drawingText": {
      const lines = drawingTextLines(p);
      const dir = { x: Math.sin(p.angle), y: -Math.cos(p.angle) }; // „nach unten“ im gedrehten Text
      for (const l of lines) {
        if (!l.text.trim() || !(l.height > 0)) continue;
        const at = { x: p.at.x + dir.x * l.down, y: p.at.y + dir.y * l.down };
        dxf.addText2(layer, at, l.height, p.angle, l.text, { style: ctx.styleOf(dxf, l.marks) });
      }
      break;
    }

    // Raumstempel (Name, Nutzung, Fläche): je Zeile ein TEXT, links/Mitte/rechts wie im Plan, um den Anker zentriert.
    case "text": {
      for (const l of stampLines(p, ctx.scale)) {
        dxf.addText2(layer, { x: p.at.x, y: p.at.y - l.down }, l.height, 0, l.text, { halign: l.align, style: ctx.styleOf(dxf, l.marks) });
      }
      break;
    }

    case "polygon": {
      const pts = p.pts;
      if (pts.length < 2) break;
      // Unsichtbare Pick-Bänder (Dach-Traufe, Kontext-Hülle, Schnittlinie): weder Füllung noch Umriss noch Schraffur.
      if (p.stroke === "none" && p.fill === "none" && p.hatch.pattern === "none" && p.hatch.kind !== "gradient") break;
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
          dxf.addGradient(hatchLayer, pts, { rgb1, rgb2, angle: (g.angle * Math.PI) / 180, radial: g.type === "radial" });
        }
      } else if (includeHatches && p.hatch.kind !== "image" && pts.length >= 3) {
        const h = p.hatch;
        if (h.pattern === "solid") {
          dxf.addHatch(hatchLayer, pts, { solid: true, rgb: rgbOrNull(h.color) });
        } else if (h.pattern !== "none" && h.lines === "random") {
          const cycle = dashCycleMeters(h.dash);
          const segs: Seg[] = buildRandomHatchRuns(pts, h)
            .filter((r) => r.length >= 2)
            .map((r) => ({ a: r[0], b: r[r.length - 1] }));
          dxf.setPen(-1);
          for (const seg of segs) {
            if (cycle) {
              for (const d of dashSeg(seg, cycle)) dxf.addLine(hatchLayer, d.a, d.b);
            } else {
              dxf.addLine(hatchLayer, seg.a, seg.b);
            }
          }
        } else if (h.pattern !== "none") {
          const families = hatchFamilies(h);
          if (families.length > 0) {
            dxf.addHatch(hatchLayer, pts, { solid: false, rgb: rgbOrNull(h.color), families, dashes: dashCycleMeters(h.dash) ?? [] });
          }
        }
      }
      // Kreis-Approximationen (viele Segmente) bleiben als geschlossene Polylinie —
      // masshaltig und robust. Geschlossene Ringe bekommen das Ring-Flag.
      dxf.setPen(-1);
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
