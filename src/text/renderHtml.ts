// Render-Adapter für das Rich-Text-Modell (richText.ts): einmal nach HTML/CSS
// (für den WYSIWYG-Editor und die Bildschirm-Vorschau auf dem Canvas) und einmal
// nach SVG-<tspan> (für den vektoriellen Grundriss-/Print-Renderer). Beide Wege
// bilden dieselbe Mark→Stil-Zuordnung ab, damit Editor-Vorschau und gezeichneter
// Text identisch aussehen. Reines Modul: keine React-/App-Abhängigkeit.
//
// Das Zeilen-Layout (`layoutText`: Run→Tspan, Wortumbruch, Lage x/y/Anker je Zeile) rechnet der Rust-Kern
// (`src-tauri/core/src/text_layout.rs`, Bindung `text_lines`); hier nur die Fassade.

import type { Marks, Paragraph, RichTextDoc, TextRun } from "./richText";
import { core } from "../engine/coreWasm";

// ── Text-Escaping ───────────────────────────────────────────────────────────

/** Escapt Text für HTML/XML/SVG-Inhalt (kein Attribut). */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escapt einen Wert für ein doppelt-gequotetes XML-Attribut. */
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

// ── Gemeinsame Mark→Stil-Zuordnung ──────────────────────────────────────────

/** Kombiniert underline + strike zu einem CSS/SVG-text-decoration-Wert. */
function textDecoration(marks: Marks): string | undefined {
  const parts: string[] = [];
  if (marks.underline) parts.push("underline");
  if (marks.strike) parts.push("line-through");
  return parts.length ? parts.join(" ") : undefined;
}

/** Faktor, um den super-/sub-Text zu verkleinern. */
const SCRIPT_SCALE = 0.7;

/**
 * CSS-Deklarationen (als `{prop: value}`) für einen Run. `basePt` ist die
 * Basisschriftgrösse in pt, falls der Run selbst keine `sizePt` trägt.
 *
 * `sizeUnit`:
 *  • "pt" (Default) — ABSOLUTE CSS-`pt`-Grösse, unabhängig vom umgebenden
 *    Kontext. Richtig für ein schwebendes Dialogfenster ohne "echten"
 *    Massstab (TextEditorDialog).
 *  • "em" — Grösse RELATIV zur geerbten Schriftgrösse des Containers
 *    (`sizePt/basePt` als `em`). Nötig für die beiden Inline-Editoren AUF
 *    der Zeichenfläche/dem Blatt (PlanView/LayoutSheet): die setzen die
 *    Basisgrösse selbst über die CSS-Variable `--rt-font-size` (aus dem
 *    echten Zoom berechnet) auf den Container — mit "pt" hätte JEDER Run
 *    (auch der ohne eigene `sizePt`, der ja `basePt` erbt) eine FESTE
 *    Pixelgrösse erzwungen und diese Container-Vorgabe ignoriert, weil ein
 *    Inline-`style`-Attribut auf dem `<span>` die geerbte Grösse immer
 *    überschreibt — der Text hätte beim Zoomen nie mitskaliert (Bug-Meldung:
 *    "Editor ist immer unterschiedlich gross wie der Text").
 */
export function runCssProps(
  marks: Marks,
  basePt = 12,
  sizeUnit: "pt" | "em" = "pt",
): Record<string, string> {
  const css: Record<string, string> = {};
  if (marks.bold) css["font-weight"] = "700";
  if (marks.italic) css["font-style"] = "italic";
  const deco = textDecoration(marks);
  if (deco) css["text-decoration"] = deco;
  if (marks.font) css["font-family"] = marks.font;
  const sizePt = (marks.sizePt ?? basePt) * (marks.super || marks.sub ? SCRIPT_SCALE : 1);
  css["font-size"] =
    sizeUnit === "em" ? `${round(sizePt / basePt)}em` : `${round(sizePt)}pt`;
  if (marks.color) css["color"] = marks.color;
  if (marks.super) css["vertical-align"] = "super";
  if (marks.sub) css["vertical-align"] = "sub";
  return css;
}

function cssPropsToString(css: Record<string, string>): string {
  return Object.entries(css)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── HTML-Render (Editor / Canvas-Vorschau) ──────────────────────────────────

export interface HtmlOptions {
  /** Basisschriftgrösse in pt für Runs ohne eigene Grösse. */
  basePt?: number;
  /** Standardfarbe (CSS) falls kein Run eine Farbe setzt. */
  color?: string;
  /** s. `runCssProps` — "pt" (Default) oder "em" (Zoom-gebundene Inline-Editoren). */
  sizeUnit?: "pt" | "em";
}

/**
 * Rendert das Dokument zu einem sanitisierten HTML-String: ein `<div>` pro
 * Absatz (mit `text-align`), darin ein `<span>` pro Run mit Inline-Styles.
 * Leere Absätze erhalten ein `<br>`, damit die Zeilenhöhe erhalten bleibt.
 */
export function docToHtml(doc: RichTextDoc, opts: HtmlOptions = {}): string {
  const basePt = opts.basePt ?? 12;
  const sizeUnit = opts.sizeUnit ?? "pt";
  return doc.paragraphs
    .map((p) => paragraphToHtml(p, basePt, sizeUnit, opts.color))
    .join("");
}

function paragraphToHtml(p: Paragraph, basePt: number, sizeUnit: "pt" | "em", color?: string): string {
  const styles: string[] = [];
  if (p.align && p.align !== "left") styles.push(`text-align:${p.align}`);
  if (p.lineHeight != null) styles.push(`line-height:${p.lineHeight}`);
  const style = styles.length ? ` style="${styles.join(";")}"` : "";
  if (p.runs.length === 0) return `<div${style}><br></div>`;
  const inner = p.runs.map((r) => runToHtmlSpan(r, basePt, sizeUnit, color)).join("");
  return `<div${style}>${inner}</div>`;
}

function runToHtmlSpan(run: TextRun, basePt: number, sizeUnit: "pt" | "em", color?: string): string {
  const css = runCssProps(run.marks, basePt, sizeUnit);
  if (color && !css["color"]) css["color"] = color;
  const style = cssPropsToString(css);
  const text = escapeText(run.text) || "";
  return `<span style="${escapeAttr(style)}">${text}</span>`;
}

// ── SVG-Render (Grundriss / Print) ──────────────────────────────────────────

/** Beschreibung eines einzelnen <tspan> (ein Run innerhalb einer Zeile). */
export interface SvgTspan {
  text: string;
  /** Schriftgrösse in Benutzereinheiten (bereits umgerechnet). */
  fontSize: number;
  fontWeight?: "700";
  fontStyle?: "italic";
  fontFamily?: string;
  fill: string;
  textDecoration?: string;
  /** Vertikaler Versatz für Hoch-/Tiefstellung, in Benutzereinheiten. */
  baselineShift?: number;
}

/** Eine gesetzte Zeile (Absatz bzw. umbrochene Teilzeile) mit ihren Runs und ihrer Lage. */
export interface SvgLine {
  tspans: SvgTspan[];
  align: "left" | "center" | "right";
  /** SVG-`text-anchor` zur Ausrichtung. */
  anchor: "start" | "middle" | "end";
  /** Vorschub zu dieser Zeile (Vielfaches der Basisgrösse bzw. `lineHeight`), s. `Paragraph.lineHeight`. */
  lineHeight: number;
  /** x der Zeile (Anker, mit Spalte Mitte/rechts darin). */
  x: number;
  /** Grundlinie der Zeile (Benutzereinheiten, nach unten wachsend). */
  y: number;
}

export interface SvgTextOptions {
  /** Ankerpunkt X in Benutzereinheiten. */
  x: number;
  /** Baseline der ERSTEN Zeile, Y in Benutzereinheiten (weitere Zeilen tiefer). */
  y: number;
  /**
   * Zeilenvorschub (Baseline zu Baseline) in Benutzereinheiten für Zeilen OHNE
   * eigene `lineHeight` (Rückwärts-Kompatibilität/Fallback). Absätze mit
   * gesetzter `Paragraph.lineHeight` berechnen ihren Vorschub stattdessen
   * selbst aus `basePt · unitPerPt · lineHeight`.
   */
  lineHeight: number;
  /**
   * Umrechnung Schriftgrösse: `sizePt` × `unitPerPt` = Grösse in Benutzereinheiten.
   * Der Aufrufer bestimmt so, ob Text in px, mm oder Metern gezeichnet wird.
   */
  unitPerPt: number;
  /** Basis-`sizePt` für Runs ohne eigene Grösse. */
  basePt?: number;
  /** Standardfarbe "#rrggbb" für Runs ohne Farbe. */
  color?: string;
  /**
   * Wortumbruch auf diese Breite (gleiche Einheiten; ≤ 0/fehlt = keiner). Wortbreite geschätzt
   * (UTF-16-Länge × Schriftgrösse × 0.55, kein Font-Messen); Run-Grenzen bleiben.
   */
  wrapWidthUnits?: number;
  /** Spaltenbreite für die Lage: Mitte/rechts ausgerichtete Zeilen liegen darin (0/NaN/fehlt = am Anker). */
  columnWidth?: number;
}

const ALIGNS = ["left", "center", "right"] as const;
const ANCHORS = ["start", "middle", "end"] as const;

/** UTF-16-Einheiten `f[at…at+n)` als Text. */
function unitsText(f: Float64Array, at: number, n: number): string {
  let s = "";
  for (let j = 0; j < n; j += 4096) s += String.fromCharCode.apply(null, Array.from(f.subarray(at + j, at + Math.min(n, j + 4096))));
  return s;
}

/**
 * Gesetzte Zeilen des Kerns (Format s. `src-tauri/core/src/web/text_layout.rs`) → `SvgLine[]`. Die
 * Tspan-Texte sind Ausschnitte der Eingabe (`text(Absatz, Run)`). Feldreihenfolge der Tspans wie früher in TS.
 */
function decodeLines(f: Float64Array, text: (para: number, run: number) => string): SvgLine[] {
  if (f.length < 2) return [];
  let k = 2;
  const styles: Array<Omit<SvgTspan, "text">> = [];
  for (let i = 0; i < f[1]; i++) {
    const [fontSize, bits, shift, nFill, nFam] = [f[k], f[k + 1], f[k + 2], f[k + 3], f[k + 4]];
    k += 5;
    const fill = unitsText(f, k, nFill);
    k += nFill;
    const st: Omit<SvgTspan, "text"> = { fontSize, fill };
    if (bits & 1) st.fontWeight = "700";
    if (bits & 2) st.fontStyle = "italic";
    if (nFam >= 0) {
      st.fontFamily = unitsText(f, k, nFam);
      k += nFam;
    }
    const deco = bits & 12;
    if (deco) st.textDecoration = deco === 4 ? "underline" : deco === 8 ? "line-through" : "underline line-through";
    if (bits & 16) st.baselineShift = shift;
    styles.push(st);
  }
  const out: SvgLine[] = new Array(f[0]);
  for (let i = 0; i < f[0]; i++) {
    const a = f[k];
    const lineHeight = f[k + 1];
    const x = f[k + 2];
    const y = f[k + 3];
    const n = f[k + 4];
    k += 5;
    const tspans: SvgTspan[] = new Array(n);
    for (let j = 0; j < n; j++, k += 5) {
      const src = text(f[k + 1], f[k + 2]);
      tspans[j] = { text: f[k + 3] === 0 && f[k + 4] === src.length ? src : src.slice(f[k + 3], f[k + 4]), ...styles[f[k]] };
    }
    out[i] = { tspans, align: ALIGNS[a] ?? "left", anchor: ANCHORS[a] ?? "start", lineHeight, x, y };
  }
  return out;
}

/** Zuletzt gesetzte Zeilen je Dokument-Objekt und Optionen (Neuzeichnen ohne Änderung). */
const memo = new WeakMap<RichTextDoc, Map<string, SvgLine[]>>();

/**
 * Setzt das Dokument (Kern `text_lines`: Runs → Tspans mit Grössen in Benutzereinheiten, eine Zeile
 * je Absatz bzw. umbrochene Teilzeile, Lage x/y/Anker je Zeile). Der Aufrufer legt nur noch die
 * Knoten an. Kaputte Eingabe → keine Zeilen. Ergebnis nicht verändern (geteilt).
 */
export function layoutText(doc: RichTextDoc, opts: SvgTextOptions): SvgLine[] {
  const { x, y, lineHeight, unitPerPt, basePt, color, wrapWidthUnits, columnWidth } = opts;
  const key = `${lineHeight}|${unitPerPt}|${basePt}|${wrapWidthUnits}|${color}|${x}|${y}|${columnWidth}`;
  let byOpts = memo.get(doc);
  const hit = byOpts?.get(key);
  if (hit) return hit;
  const o = Float64Array.of(lineHeight, unitPerPt, basePt == null ? 0 : 1, basePt ?? 0, wrapWidthUnits ?? NaN, x, y, columnWidth ?? NaN);
  const lines = decodeLines(core().text_lines(JSON.stringify(doc), o, color ?? undefined), (p, r) => doc.paragraphs[p].runs[r].text);
  if (!byOpts) memo.set(doc, (byOpts = new Map()));
  if (byOpts.size > 8) byOpts.clear();
  byOpts.set(key, lines);
  return lines;
}

/**
 * Raumstempel-Block (Kern `stamp_block`): Rich-Text-Zeilen (Vorschub 1.3 × Basisgrösse bzw. die
 * Absatz-Zeilenhöhe) und darunter die Live-Zeilen (0.8 × Basisgrösse), vertikal um `y0` zentriert,
 * alle bei `x0`. `stamp` ist das Plan-Primitiv `text`.
 */
export function stampBlockLines(
  stamp: { at: { x: number; y: number }; doc: RichTextDoc; extraLines: ReadonlyArray<{ text: string; align: string }>; basePt: number; color?: string },
  unitPerPt: number,
  x0: number,
  y0: number,
): SvgLine[] {
  const n = stamp.doc.paragraphs.length;
  const text = (p: number, r: number): string => (p < n ? stamp.doc.paragraphs[p].runs[r].text : stamp.extraLines[p - n].text);
  return decodeLines(core().text_stamp_block(JSON.stringify(stamp), unitPerPt, x0, y0), text);
}

/**
 * Einfacher Text (ohne Rich-Dokument) auf die Spalte `wrap` umbrochen: Absätze an `\n`, Wörter mit
 * einem Leerzeichen verbunden, geschätzte Zeichenbreite 0.55 × `fontSize` (gleiche Einheiten).
 */
export function wrapPlainText(text: string, wrap: number, fontSize: number): string[] {
  const json = core().text_wrap_plain(text, wrap, fontSize);
  return json ? (JSON.parse(json) as string[]) : [text];
}
