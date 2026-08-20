// Rich-Text-Dokumentmodell — die wiederverwendbare Grundlage für TextEntity-
// Annotationen (Text-/Stempel-Bauteil). Bewusst frei von App-Store und React:
// ein reines Datenmodell + Operationen, unit-getestet.
//
// Aufbau (an DOSSIERs text_editor.py angelehnt: Runs mit text/font/bold/italic/
// underline/strike/sup/sub/color, Grössen in Punkt):
//
//   RichTextDoc  = { version, paragraphs: Paragraph[] }
//   Paragraph    = { runs: TextRun[], align? }
//   TextRun      = { text: string, marks: Marks }
//   Marks        = { bold?, italic?, underline?, strike?, super?, sub?,
//                    font?, sizePt?, color? }
//
// Absätze trennen Zeilen (harte Umbrüche); innerhalb eines Absatzes tragen die
// Runs die Zeichenformatierung. Ein „Zeichen-Offset" adressiert das Dokument
// linear über alle Absätze hinweg, wobei jeder Absatzumbruch als EIN Zeichen
// zählt (wie „\n"). Das erlaubt Bereichs-Operationen (applyMark/toggleMark) über
// Absatzgrenzen hinweg.

/** Zeichen-Marks eines Runs. Alle optional; fehlend = „nicht gesetzt". */
export interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Hochgestellt. super und sub schliessen sich gegenseitig aus. */
  super?: boolean;
  /** Tiefgestellt. */
  sub?: boolean;
  /** Schriftfamilie (CSS font-family-Wert), z. B. "Helvetica". */
  font?: string;
  /** Schriftgrösse in typografischen Punkt (pt). */
  sizePt?: number;
  /** Farbe als "#rrggbb". */
  color?: string;
}

/** Ein zusammenhängender Textabschnitt mit einheitlicher Formatierung. */
export interface TextRun {
  text: string;
  marks: Marks;
}

/** Absatz-Ausrichtung. */
export type Align = "left" | "center" | "right";

/** Zeilenhöhe als Vielfaches der Basisgrösse, wenn nicht am Absatz gesetzt. */
export const DEFAULT_LINE_HEIGHT = 1.3;

/** Ein Absatz: eine Zeile aus Runs plus optionale Ausrichtung/Zeilenhöhe. */
export interface Paragraph {
  runs: TextRun[];
  align?: Align;
  /** Zeilenhöhe als Vielfaches der Basisgrösse (z. B. 1.3 = 130 %). */
  lineHeight?: number;
}

/** Das gesamte Rich-Text-Dokument. */
export interface RichTextDoc {
  version: 1;
  paragraphs: Paragraph[];
}

/** Namen der booleschen Marks (togglebar). */
export type BoolMark = "bold" | "italic" | "underline" | "strike" | "super" | "sub";

/** Ein Zeichen-Bereich [start, end) im linearen Dokument-Offset. */
export interface TextRange {
  start: number;
  end: number;
}

// ── Konstruktoren ──────────────────────────────────────────────────────────

/** Leeres Dokument (ein leerer Absatz). */
export function emptyDoc(): RichTextDoc {
  return { version: 1, paragraphs: [{ runs: [] }] };
}

/**
 * Dokument aus reinem Text. Zeilenumbrüche ("\n") werden zu Absätzen; die
 * übergebenen Marks gelten für den ganzen Text.
 */
export function docFromText(text: string, marks: Marks = {}): RichTextDoc {
  const lines = text.split("\n");
  const paragraphs: Paragraph[] = lines.map((line) => ({
    runs: line.length ? [{ text: line, marks: { ...marks } }] : [],
  }));
  return { version: 1, paragraphs };
}

/** Erzeugt einen Run (defensive Kopie der Marks). */
export function makeRun(text: string, marks: Marks = {}): TextRun {
  return { text, marks: { ...marks } };
}

// ── Extraktion ─────────────────────────────────────────────────────────────

/** Reintext des Dokuments; Absätze werden mit "\n" verbunden. */
export function plainText(doc: RichTextDoc): string {
  return doc.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");
}

/** Gesamtlänge in Zeichen (inkl. Absatzumbrüche als je 1 Zeichen). */
export function docLength(doc: RichTextDoc): number {
  return plainText(doc).length;
}

// ── Marks-Vergleich / Normalisierung ───────────────────────────────────────

const MARK_KEYS: (keyof Marks)[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "super",
  "sub",
  "font",
  "sizePt",
  "color",
];

/** Normalisiert Marks: entfernt „falsy"/leere Einträge, damit Vergleiche stabil sind. */
export function normalizeMarks(marks: Marks): Marks {
  const out: Marks = {};
  for (const key of MARK_KEYS) {
    const value = marks[key];
    if (value === undefined || value === false || value === null) continue;
    if ((key === "font" || key === "color") && value === "") continue;
    // super und sub sind exklusiv — sub gewinnt nicht über super, wir behalten beide
    // Werte nur wenn true; Auflösung geschieht bei toggleMark.
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Strukturvergleich zweier Marks-Objekte (nach Normalisierung). */
export function marksEqual(a: Marks, b: Marks): boolean {
  const na = normalizeMarks(a);
  const nb = normalizeMarks(b);
  for (const key of MARK_KEYS) {
    if ((na as Record<string, unknown>)[key] !== (nb as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Führt benachbarte Runs mit gleichen Marks zusammen und entfernt leere Runs.
 * Idempotent; hält das Dokument nach Editieroperationen kompakt.
 */
export function normalizeDoc(doc: RichTextDoc): RichTextDoc {
  const paragraphs: Paragraph[] = doc.paragraphs.map((p) => {
    const merged: TextRun[] = [];
    for (const run of p.runs) {
      if (run.text.length === 0) continue;
      const norm = { text: run.text, marks: normalizeMarks(run.marks) };
      const last = merged[merged.length - 1];
      if (last && marksEqual(last.marks, norm.marks)) {
        last.text += norm.text;
      } else {
        merged.push(norm);
      }
    }
    const out: Paragraph = { runs: merged };
    if (p.align && p.align !== "left") out.align = p.align;
    return out;
  });
  if (paragraphs.length === 0) paragraphs.push({ runs: [] });
  return { version: 1, paragraphs };
}

// ── Bereichs-Adressierung (linearer Offset ↔ Absatz/Run) ────────────────────

interface ParaSpan {
  index: number;
  /** Start-Offset dieses Absatzes im linearen Dokument. */
  start: number;
  /** End-Offset (exklusive Umbruch) = start + Reintextlänge des Absatzes. */
  end: number;
}

/** Berechnet Start/End-Offsets je Absatz. */
function paragraphSpans(doc: RichTextDoc): ParaSpan[] {
  const spans: ParaSpan[] = [];
  let cursor = 0;
  doc.paragraphs.forEach((p, index) => {
    const len = p.runs.reduce((n, r) => n + r.text.length, 0);
    spans.push({ index, start: cursor, end: cursor + len });
    cursor += len + 1; // +1 für den Absatzumbruch
  });
  return spans;
}

/**
 * Wendet `fn` auf jeden Run an, der (ganz oder teilweise) im Bereich [start,end)
 * liegt; teilt Runs an den Bereichsgrenzen auf. Gibt ein neues, normalisiertes
 * Dokument zurück. Die Callback bekommt die aktuellen Marks des Teil-Runs und
 * liefert die neuen Marks.
 */
export function mapRunsInRange(
  doc: RichTextDoc,
  range: TextRange,
  fn: (marks: Marks) => Marks,
): RichTextDoc {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);
  if (start === end) return normalizeDoc(doc);

  const spans = paragraphSpans(doc);
  const paragraphs: Paragraph[] = doc.paragraphs.map((p, pIdx) => {
    const span = spans[pIdx];
    // Absatz komplett ausserhalb des Bereichs?
    if (span.end <= start || span.start >= end) return p;

    const newRuns: TextRun[] = [];
    let runStart = span.start;
    for (const run of p.runs) {
      const runEnd = runStart + run.text.length;
      const selStart = Math.max(start, runStart);
      const selEnd = Math.min(end, runEnd);
      if (selEnd <= selStart) {
        // Run ausserhalb — unverändert übernehmen.
        newRuns.push(run);
      } else {
        const relStart = selStart - runStart;
        const relEnd = selEnd - runStart;
        if (relStart > 0) {
          newRuns.push(makeRun(run.text.slice(0, relStart), run.marks));
        }
        newRuns.push(makeRun(run.text.slice(relStart, relEnd), fn(run.marks)));
        if (relEnd < run.text.length) {
          newRuns.push(makeRun(run.text.slice(relEnd), run.marks));
        }
      }
      runStart = runEnd;
    }
    return { ...p, runs: newRuns };
  });

  return normalizeDoc({ version: 1, paragraphs });
}

// ── Mark-Operationen ───────────────────────────────────────────────────────

/**
 * Setzt ein Mark auf einen Bereich. `value` bei boolschen Marks true/false;
 * bei font/sizePt/color der jeweilige Wert (oder undefined zum Entfernen).
 * super/sub werden exklusiv gehalten.
 */
export function applyMark<K extends keyof Marks>(
  doc: RichTextDoc,
  range: TextRange,
  mark: K,
  value: Marks[K] | undefined,
): RichTextDoc {
  return mapRunsInRange(doc, range, (marks) => {
    const next: Marks = { ...marks };
    if (value === undefined || value === false) {
      delete next[mark];
    } else {
      (next as Record<string, unknown>)[mark] = value;
      if (mark === "super" && value) delete next.sub;
      if (mark === "sub" && value) delete next.super;
    }
    return next;
  });
}

/**
 * Ist ein boolsches Mark über den GESAMTEN Bereich aktiv? (Für den
 * Toolbar-Zustand: „Fett"-Knopf gedrückt, wenn die ganze Auswahl fett ist.)
 */
export function isMarkActive(doc: RichTextDoc, range: TextRange, mark: BoolMark): boolean {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);
  if (start === end) return false;
  const spans = paragraphSpans(doc);
  let sawAny = false;

  for (let pIdx = 0; pIdx < doc.paragraphs.length; pIdx++) {
    const span = spans[pIdx];
    if (span.end <= start || span.start >= end) continue;
    let runStart = span.start;
    for (const run of doc.paragraphs[pIdx].runs) {
      const runEnd = runStart + run.text.length;
      const selStart = Math.max(start, runStart);
      const selEnd = Math.min(end, runEnd);
      if (selEnd > selStart) {
        sawAny = true;
        if (!run.marks[mark]) return false;
      }
      runStart = runEnd;
    }
  }
  return sawAny;
}

/**
 * Schaltet ein boolsches Mark über den Bereich um: ist es überall aktiv →
 * entfernen, sonst überall setzen.
 */
export function toggleMark(doc: RichTextDoc, range: TextRange, mark: BoolMark): RichTextDoc {
  const active = isMarkActive(doc, range, mark);
  return applyMark(doc, range, mark, active ? undefined : true);
}

/**
 * Liefert den gemeinsamen Wert eines Nicht-Bool-Marks über den Bereich, oder
 * undefined wenn uneinheitlich/leer. (Für Toolbar-Anzeige von Grösse/Farbe/Font.)
 */
export function commonMarkValue<K extends "font" | "sizePt" | "color">(
  doc: RichTextDoc,
  range: TextRange,
  mark: K,
): Marks[K] | undefined {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);
  if (start === end) return undefined;
  const spans = paragraphSpans(doc);
  let value: Marks[K] | undefined;
  let first = true;

  for (let pIdx = 0; pIdx < doc.paragraphs.length; pIdx++) {
    const span = spans[pIdx];
    if (span.end <= start || span.start >= end) continue;
    let runStart = span.start;
    for (const run of doc.paragraphs[pIdx].runs) {
      const runEnd = runStart + run.text.length;
      const selStart = Math.max(start, runStart);
      const selEnd = Math.min(end, runEnd);
      if (selEnd > selStart) {
        const v = run.marks[mark];
        if (first) {
          value = v;
          first = false;
        } else if (v !== value) {
          return undefined;
        }
      }
      runStart = runEnd;
    }
  }
  return value;
}

// ── Serialisierung (stabiles JSON) ─────────────────────────────────────────

/**
 * Stabile JSON-Serialisierung: Schlüssel in fester Reihenfolge, damit gleiche
 * Dokumente denselben String ergeben (Diff-/Test-freundlich).
 */
export function serialize(doc: RichTextDoc): string {
  const norm = normalizeDoc(doc);
  const paragraphs = norm.paragraphs.map((p) => {
    const runs = p.runs.map((r) => {
      const marks: Record<string, unknown> = {};
      for (const key of MARK_KEYS) {
        const v = (r.marks as Record<string, unknown>)[key];
        if (v !== undefined) marks[key] = v;
      }
      return { text: r.text, marks };
    });
    const obj: Record<string, unknown> = { runs };
    if (p.align && p.align !== "left") obj.align = p.align;
    return obj;
  });
  return JSON.stringify({ version: 1, paragraphs });
}

// ── Style-Presets ──────────────────────────────────────────────────────────

/** Ein benannter Stil (Marks-Vorlage), z. B. „Titel". */
export interface TextStylePreset {
  /** Stabiler Schlüssel (englisch), z. B. "title". */
  id: string;
  /** Anzeigename (bereits übersetzt oder Schlüssel für t()). */
  label: string;
  /** Marks, die der Stil auf die Auswahl (oder das ganze Dokument) legt. */
  marks: Marks;
}

/**
 * Standard-Presets, an DOSSIERs Textstile angelehnt. Grössen in pt; die
 * SVG-/Canvas-Renderer rechnen pt → Meter/px selbst um.
 */
export const DEFAULT_PRESETS: TextStylePreset[] = [
  { id: "title", label: "Titel", marks: { bold: true, sizePt: 18 } },
  { id: "subtitle", label: "Untertitel", marks: { italic: true, sizePt: 13 } },
  { id: "label", label: "Beschriftung", marks: { sizePt: 10 } },
  { id: "note", label: "Notiz", marks: { italic: true, sizePt: 8, color: "#8a8580" } },
];

/**
 * Wendet ein Preset auf einen Bereich an (setzt jede Mark des Presets). Ein
 * leerer Bereich wird auf das ganze Dokument angewendet.
 */
export function applyPreset(
  doc: RichTextDoc,
  range: TextRange,
  preset: TextStylePreset,
): RichTextDoc {
  const full: TextRange =
    range.start === range.end ? { start: 0, end: Math.max(1, docLength(doc)) } : range;
  let out = doc;
  for (const key of MARK_KEYS) {
    const v = (preset.marks as Record<string, unknown>)[key];
    if (v !== undefined) {
      out = applyMark(out, full, key as keyof Marks, v as Marks[keyof Marks]);
    }
  }
  return out;
}
