// DXF-/DWG-Export des Grundrisses. Nutzt DIESELBE Quelle wie der PDF-Export — den
// Vektor-Plan (generatePlan → Plan-Puffer) — schreibt aber MODELL-SPACE-Geometrie
// in ECHTEN Metern (kein Papier-mm, keine Y-Spiegelung). So können nachgelagerte
// CAD-Nutzer beim Plot beliebig skalieren; die Datei ist masshaltig 1:1 in Metern.
//
// Layer entstehen aus den Kategorie-Ebenen des Projekts (Code + Name, Farbe,
// Linienstärke). Jede Entity liegt auf dem Layer ihrer Kategorie; Primitive ohne
// direkten Kategorie-Bezug (Tür-Symbole, Kontext, Schraffuren) landen auf
// sprechenden Sammel-Layern.
//
// Seit [K3d] (29.10.) sammelt der Kern (`src-tauri/core/src/plan_dxf.rs`) Ebenen und Entitäten
// direkt aus den Plan-Puffern und dem Projekt-Dokument in die flache Zeichnung (Kodierung s.
// `src-tauri/fileio/src/export.rs`); Rust (acadrust, fileio) schreibt die Datei ([C1]/[C2]).
// DXF = R2018 ASCII (UTF-8), DWG = R2018. Hier bleibt das Text-Layout (Zeilen der Raumstempel,
// Absätze/Wörter der Einzeltexte, Schriftfamilien) — es geht als flache Eingabe an den Kern —
// und die Übergabe an fileio. Das Format-Modul wird nachgeladen: vor `buildPlanDxf`/
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
import type { Project } from "../model/types";
import type { Marks } from "../text/richText";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import { plainText } from "../text/richText";
import { docToLines } from "../text/renderHtml";
import { fileio, loadFileio } from "../engine/fileioWasm";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";
import { planParts, withPlanParts } from "../plan/planParts";
import { planTextEntries } from "../plan/planLazy";
import { fontNameOf } from "./dxfCadParts";

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

/** Entitäten-Arten der Statistik (Reihenfolge wie `plan_dxf::KINDS`). */
const KINDS = ["LINE", "LWPOLYLINE", "ARC", "CIRCLE", "TEXT", "HATCH", "DIMENSION", "INSERT"] as const;
/** Kennung der Kern-Antwort ("DXF1"). */
const DXF_MAGIC = 0x44584631;
/** Kopf der Kern-Antwort: Kennung, nZahlen, nTexte, 8 Modell-, 8 Block-Zähler. */
const HEAD = 19;

/** Flache Zeichnung (Zahlen + Zeichenketten) für die fileio-Bindungen, wie der Kern sie liefert. */
export interface FlatDrawing {
  /** Argumente für die Rust-Bindungen von fileio. */
  args(): [Float64Array, string];
  /** Anzahl Entitäten im Modellbereich je Typ (INSERT/DIMENSION zählen je als eine) und in Blöcken (Summe je Typ). */
  stats(): { model: Record<string, number>; blocks: Record<string, number> };
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

/** Massstab des Exports (endlich und > 0, sonst 1:100). */
function scaleOf(opts: ExportDxfOptions): number {
  return opts.scaleDenominator && Number.isFinite(opts.scaleDenominator) && opts.scaleDenominator > 0 ? opts.scaleDenominator : DEFAULT_SCALE_DENOMINATOR;
}

/**
 * Text-Eingabe für den Kern (`plan_dxf::texts_from`): je Raumstempel die gesetzten Zeilen, je
 * Einzeltext Anker/Winkel/Höhe/Spalte, Schrift und Absätze mit ihren Wörtern (`split(/\s+/)`).
 * Nur die Text-Einträge des Plans werden gelesen.
 */
function textInput(plan: Plan, scale: number, defaultFont: string): { nums: Float64Array; strs: string } {
  const nums: number[] = [];
  const strs: string[] = [];
  const idx = new Map<string, number>();
  const S = (s: string): number => {
    let i = idx.get(s);
    if (i === undefined) {
      i = strs.length;
      strs.push(s);
      idx.set(s, i);
    }
    return i;
  };
  const family = (marks: Marks | undefined): number => S(fontNameOf(marks?.font) ?? defaultFont);
  for (const { i, p } of planTextEntries(plan)) {
    if (p.kind === "text") {
      const lines = stampLines(p, scale);
      nums.push(i, 6, p.at.x, p.at.y, lines.length);
      for (const l of lines) nums.push(S(l.text), l.height, l.align, family(l.marks), l.marks?.bold ? 1 : 0, l.marks?.italic ? 1 : 0, l.down);
    } else if (p.kind === "drawingText") {
      const paragraphs = p.doc ? plainText(p.doc).split("\n") : p.text.split(/\r?\n/);
      const marks = p.marks ?? p.doc?.paragraphs[0]?.runs[0]?.marks;
      const wrap = typeof p.wrapWidth === "number" ? p.wrapWidth : NaN;
      nums.push(i, 7, p.at.x, p.at.y, p.angle, p.heightM, wrap, family(marks), marks?.bold ? 1 : 0, marks?.italic ? 1 : 0, paragraphs.length);
      for (const para of paragraphs) {
        const words = para.split(/\s+/);
        nums.push(S(para), words.length);
        for (const w of words) nums.push(S(w));
      }
    }
  }
  return { nums: Float64Array.from(nums), strs: strs.map((s) => "\0" + s).join("") };
}

/** Kern-Antwort (`plan_dxf::encode`) → flache Zeichnung; leer = Fehler. */
function decodeFlat(bytes: Uint8Array): FlatDrawing {
  const b = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  if (b.byteLength < HEAD * 8) throw new Error("DXF-Export fehlgeschlagen: Plan oder Projekt im Kern unlesbar");
  const h = new Float64Array(b.buffer, b.byteOffset, HEAD);
  if (h[0] !== DXF_MAGIC) throw new Error("DXF-Export fehlgeschlagen: unerwartete Antwort des Kerns");
  const nNums = h[1];
  const nStr = h[2];
  const nF64 = HEAD + nNums + nStr;
  const f = new Float64Array(b.buffer, b.byteOffset, nF64);
  const nums = f.slice(HEAD, HEAD + nNums);
  const units = new Uint16Array(b.buffer, b.byteOffset + nF64 * 8, (b.byteLength - nF64 * 8) >> 1);
  const strings: string[] = new Array(nStr);
  let o = 0;
  for (let k = 0; k < nStr; k++) {
    const n = f[HEAD + nNums + k];
    let s = "";
    for (let j = 0; j < n; j += 8192) s += String.fromCharCode.apply(null, units.subarray(o + j, o + Math.min(n, j + 8192)) as unknown as number[]);
    strings[k] = s;
    o += n;
  }
  const counts = (at: number): Record<string, number> => {
    const r: Record<string, number> = {};
    KINDS.forEach((k, j) => {
      if (h[at + j] > 0) r[k] = h[at + j];
    });
    return r;
  };
  const model = counts(3);
  const blocks = counts(11);
  const joined = strings.join("\0");
  return {
    args: () => [nums, joined],
    stats: () => ({ model: { ...model }, blocks: { ...blocks } }),
  };
}

/**
 * Baut aus einem Plan + Projekt die flache Zeichnung (Meter-Modell-Space) im Kern.
 * Reihenfolge der Primitive bleibt erhalten.
 */
export function collectPlanDrawing(
  plan: Plan,
  project: Project,
  opts: ExportDxfOptions = {},
): FlatDrawing {
  const scale = scaleOf(opts);
  // Standard-Schrift: erste im Projekt hinterlegte Schrift der Textstile, sonst Arial.
  const defaultFont = (project.textStyles ?? []).map((s) => fontNameOf(s.marks.font)).find((f) => f) ?? "Arial";
  const { nums, strs } = textInput(plan, scale, defaultFont);
  const b = plan.bounds;
  const o = Float64Array.of(scale, (opts.includeHatches ?? true) ? 1 : 0, opts.dimUnit === "cm" ? 1 : 0, opts.paperLayout ? 1 : 0, b.minX, b.minY, b.maxX, b.maxY);
  const doc = documentFor(project).id;
  // Eigener Puffer mit Schraffur-JSON (Verlauf-Schraffuren brauchen ihre Farben).
  const bytes = withPlanParts(planParts(plan, true), (segs) => core().plan_dxf_flat(doc, segs, nums, strs, o, defaultFont));
  return decodeFlat(bytes);
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
