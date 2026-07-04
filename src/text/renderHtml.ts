// Render-Adapter für das Rich-Text-Modell (richText.ts): einmal nach HTML/CSS
// (für den WYSIWYG-Editor und die Bildschirm-Vorschau auf dem Canvas) und einmal
// nach SVG-<tspan> (für den vektoriellen Grundriss-/Print-Renderer). Beide Wege
// bilden dieselbe Mark→Stil-Zuordnung ab, damit Editor-Vorschau und gezeichneter
// Text identisch aussehen. Reines Modul: keine React-/App-Abhängigkeit.

import type { Marks, Paragraph, RichTextDoc, TextRun } from "./richText";

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
 */
export function runCssProps(marks: Marks, basePt = 12): Record<string, string> {
  const css: Record<string, string> = {};
  if (marks.bold) css["font-weight"] = "700";
  if (marks.italic) css["font-style"] = "italic";
  const deco = textDecoration(marks);
  if (deco) css["text-decoration"] = deco;
  if (marks.font) css["font-family"] = marks.font;
  const sizePt = (marks.sizePt ?? basePt) * (marks.super || marks.sub ? SCRIPT_SCALE : 1);
  css["font-size"] = `${round(sizePt)}pt`;
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
}

/**
 * Rendert das Dokument zu einem sanitisierten HTML-String: ein `<div>` pro
 * Absatz (mit `text-align`), darin ein `<span>` pro Run mit Inline-Styles.
 * Leere Absätze erhalten ein `<br>`, damit die Zeilenhöhe erhalten bleibt.
 */
export function docToHtml(doc: RichTextDoc, opts: HtmlOptions = {}): string {
  const basePt = opts.basePt ?? 12;
  return doc.paragraphs
    .map((p) => paragraphToHtml(p, basePt, opts.color))
    .join("");
}

function paragraphToHtml(p: Paragraph, basePt: number, color?: string): string {
  const styles: string[] = [];
  if (p.align && p.align !== "left") styles.push(`text-align:${p.align}`);
  if (p.lineHeight != null) styles.push(`line-height:${p.lineHeight}`);
  const style = styles.length ? ` style="${styles.join(";")}"` : "";
  if (p.runs.length === 0) return `<div${style}><br></div>`;
  const inner = p.runs.map((r) => runToHtmlSpan(r, basePt, color)).join("");
  return `<div${style}>${inner}</div>`;
}

function runToHtmlSpan(run: TextRun, basePt: number, color?: string): string {
  const css = runCssProps(run.marks, basePt);
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

/** Eine gerenderte Zeile (= Absatz) mit ihren Runs. */
export interface SvgLine {
  tspans: SvgTspan[];
  align: "left" | "center" | "right";
  /** Zeilenhöhe dieses Absatzes (Vielfaches der Basisgrösse), s. `Paragraph.lineHeight`. */
  lineHeight: number;
}

export interface SvgTextOptions {
  /** Ankerpunkt X in Benutzereinheiten. */
  x: number;
  /** Baseline der ERSTEN Zeile, Y in Benutzereinheiten. */
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
}

/**
 * Zerlegt das Dokument in Zeilen/Tspans mit bereits in Benutzereinheiten
 * umgerechneten Grössen. Der Aufrufer positioniert die Zeilen selbst (Baseline
 * der Zeile i = `y + Σ lineHeight[0..i-1]`, s. `docToSvgText`).
 */
export function docToLines(doc: RichTextDoc, opts: SvgTextOptions): SvgLine[] {
  const basePt = opts.basePt ?? 12;
  const color = opts.color ?? "#000000";
  const baseUnit = basePt * opts.unitPerPt;
  return doc.paragraphs.map((p) => ({
    align: p.align ?? "left",
    lineHeight: p.lineHeight != null ? baseUnit * p.lineHeight : opts.lineHeight,
    tspans: p.runs
      .filter((r) => r.text.length > 0)
      .map((r) => runToTspan(r, basePt, opts.unitPerPt, color)),
  }));
}

function runToTspan(run: TextRun, basePt: number, unitPerPt: number, color: string): SvgTspan {
  const m = run.marks;
  const script = m.super || m.sub;
  const sizePt = (m.sizePt ?? basePt) * (script ? SCRIPT_SCALE : 1);
  const fontSize = sizePt * unitPerPt;
  const tspan: SvgTspan = {
    text: run.text,
    fontSize: round(fontSize),
    fill: m.color ?? color,
  };
  if (m.bold) tspan.fontWeight = "700";
  if (m.italic) tspan.fontStyle = "italic";
  if (m.font) tspan.fontFamily = m.font;
  const deco = textDecoration(m);
  if (deco) tspan.textDecoration = deco;
  if (m.super) tspan.baselineShift = round(fontSize * 0.35);
  if (m.sub) tspan.baselineShift = round(-fontSize * 0.2);
  return tspan;
}

/**
 * Baut ein komplettes `<text>`-SVG-Element als String. Jede Zeile ist ein
 * `<tspan x=… dy=…>`, darin ein `<tspan>` je Run. `text-anchor` folgt der
 * Absatz-Ausrichtung (left→start, center→middle, right→end).
 */
export function docToSvgText(doc: RichTextDoc, opts: SvgTextOptions): string {
  const lines = docToLines(doc, opts);
  const parts: string[] = [];
  lines.forEach((line, i) => {
    const dy = i === 0 ? 0 : line.lineHeight;
    const anchor = line.align === "center" ? "middle" : line.align === "right" ? "end" : "start";
    const runSpans = line.tspans.map((t) => tspanToSvg(t)).join("");
    // Leere Zeile: ein Zero-Width-Space, damit dy dennoch wirkt.
    const content = runSpans || "&#8203;";
    parts.push(
      `<tspan x="${round(opts.x)}" dy="${round(dy)}" text-anchor="${anchor}">${content}</tspan>`,
    );
  });
  return `<text x="${round(opts.x)}" y="${round(opts.y)}">${parts.join("")}</text>`;
}

function tspanToSvg(t: SvgTspan): string {
  const attrs: string[] = [`font-size="${t.fontSize}"`, `fill="${escapeAttr(t.fill)}"`];
  if (t.fontWeight) attrs.push(`font-weight="${t.fontWeight}"`);
  if (t.fontStyle) attrs.push(`font-style="${t.fontStyle}"`);
  if (t.fontFamily) attrs.push(`font-family="${escapeAttr(t.fontFamily)}"`);
  if (t.textDecoration) attrs.push(`text-decoration="${t.textDecoration}"`);
  if (t.baselineShift) attrs.push(`dy="${-t.baselineShift}"`);
  const body = escapeText(t.text);
  // Bei baseline-shift den dy nach dem Run zurücksetzen, damit die Grundlinie hält.
  if (t.baselineShift) {
    return `<tspan ${attrs.join(" ")}>${body}</tspan><tspan dy="${t.baselineShift}">&#8203;</tspan>`;
  }
  return `<tspan ${attrs.join(" ")}>${body}</tspan>`;
}
