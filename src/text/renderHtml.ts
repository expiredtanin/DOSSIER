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
 * der Zeile i = `y + Σ lineHeight[0..i-1]`).
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

/** Geschätzte Zeichenbreite als Vielfaches der Schriftgrösse (gleiche Heuristik
 * wie der bisherige Wortumbruch für einheitlich formatierten Text, s.
 * PlanView.tsx `case "drawingText"`) — kein echtes Font-Metrics-Messen, aber
 * für die Platzierung von Zeilenumbrüchen ausreichend. */
const CHAR_WIDTH_FACTOR = 0.55;

/**
 * Wie {@link docToLines}, bricht aber zusätzlich wortweise auf `wrapWidthUnits`
 * um (in denselben Benutzereinheiten wie `SvgTextOptions.x`) — für Textfelder/
 * -rahmen mit fester Breite (InDesign-artig). Ohne `wrapWidthUnits` identisch
 * zu `docToLines` (eine Zeile je Absatz). Respektiert Run-Grenzen: ein Wort
 * behält die Formatierung seines Runs, auch wenn die Zeile mehrere Runs mischt.
 */
export function wrapDocToLines(
  doc: RichTextDoc,
  opts: SvgTextOptions & { wrapWidthUnits?: number },
): SvgLine[] {
  if (!opts.wrapWidthUnits || opts.wrapWidthUnits <= 0) return docToLines(doc, opts);
  const basePt = opts.basePt ?? 12;
  const color = opts.color ?? "#000000";
  const baseUnit = basePt * opts.unitPerPt;
  const maxWidth = opts.wrapWidthUnits;

  interface Token {
    tspan: SvgTspan;
    widthUnits: number;
    isSpace: boolean;
  }

  const lines: SvgLine[] = [];
  for (const p of doc.paragraphs) {
    const lineHeight = p.lineHeight != null ? baseUnit * p.lineHeight : opts.lineHeight;
    const align = p.align ?? "left";

    const tokens: Token[] = [];
    for (const run of p.runs) {
      if (run.text.length === 0) continue;
      const base = runToTspan(run, basePt, opts.unitPerPt, color);
      for (const part of run.text.split(/(\s+)/).filter((s) => s.length > 0)) {
        const isSpace = /^\s/.test(part);
        tokens.push({
          tspan: { ...base, text: part },
          widthUnits: part.length * base.fontSize * CHAR_WIDTH_FACTOR,
          isSpace,
        });
      }
    }

    if (tokens.length === 0) {
      lines.push({ tspans: [], align, lineHeight });
      continue;
    }

    let current: Token[] = [];
    let currentWidth = 0;
    const flush = () => {
      while (current.length && current[current.length - 1].isSpace) current.pop();
      lines.push({ tspans: current.map((t) => t.tspan), align, lineHeight });
      current = [];
      currentWidth = 0;
    };
    for (const tok of tokens) {
      if (current.length === 0 && tok.isSpace) continue;
      if (current.length > 0 && currentWidth + tok.widthUnits > maxWidth) {
        flush();
        if (tok.isSpace) continue;
      }
      current.push(tok);
      currentWidth += tok.widthUnits;
    }
    flush();
  }
  return lines;
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

