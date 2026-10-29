// Rich-Text-Dokumentmodell — die wiederverwendbare Grundlage für TextEntity-
// Annotationen (Text-/Stempel-Bauteil). Bewusst frei von App-Store und React:
// ein reines Datenmodell + Operationen, unit-getestet. Konstruktoren und Reintext stehen hier; die
// Bearbeitung (Marks, Normalisieren, Serialisieren, Stile) rechnet der Rust-Kern (`rich_text.rs`).
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

// Die Datentypen (RichTextDoc, Paragraph, TextRun, Marks, Align, TextStylePreset) gehören zum
// Projektmodell und kommen aus dem Rust-Modell ([K4] S4, `model/types.generated.ts`).
import { core } from "../engine/coreWasm";
import type { Align, Marks, Paragraph, RichTextDoc, TextRun, TextStylePreset } from "../model/types.generated";
export type { Align, Marks, Paragraph, RichTextDoc, TextRun, TextStylePreset };

/** Zeilenhöhe als Vielfaches der Basisgrösse, wenn nicht am Absatz gesetzt. */
export const DEFAULT_LINE_HEIGHT = 1.3;

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

// ── Bearbeiten: rechnet der Kern (`core/src/rich_text.rs`, Dokument als JSON) ──────────────────────────
// Offsets sind lineare UTF-16-Positionen über alle Absätze (Umbruch = 1 Zeichen). Kaputte Eingaben
// liefern das Eingabedokument unverändert zurück.

const parseDoc = (json: string, fallback: RichTextDoc): RichTextDoc => (json === "" ? fallback : (JSON.parse(json) as RichTextDoc));

/**
 * Führt benachbarte Runs mit gleichen Marks zusammen und entfernt leere Runs.
 * Idempotent; hält das Dokument nach Editieroperationen kompakt.
 */
export function normalizeDoc(doc: RichTextDoc): RichTextDoc {
  return parseDoc(core().rich_normalize(JSON.stringify(doc)), doc);
}

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
  return parseDoc(core().rich_apply_mark(JSON.stringify(doc), range.start, range.end, mark, JSON.stringify(value ?? null)), doc);
}

/** Ist ein boolsches Mark über den GESAMTEN Bereich aktiv? (Toolbar: „Fett"-Knopf.) */
export function isMarkActive(doc: RichTextDoc, range: TextRange, mark: BoolMark): boolean {
  return core().rich_is_mark_active(JSON.stringify(doc), range.start, range.end, mark);
}

/** Schaltet ein boolsches Mark über den Bereich um: überall aktiv → entfernen, sonst überall setzen. */
export function toggleMark(doc: RichTextDoc, range: TextRange, mark: BoolMark): RichTextDoc {
  return parseDoc(core().rich_toggle_mark(JSON.stringify(doc), range.start, range.end, mark), doc);
}

/**
 * Gemeinsamer Wert eines Nicht-Bool-Marks über den Bereich, oder undefined wenn
 * uneinheitlich/leer. (Toolbar-Anzeige von Grösse/Farbe/Font.)
 */
export function commonMarkValue<K extends "font" | "sizePt" | "color">(
  doc: RichTextDoc,
  range: TextRange,
  mark: K,
): Marks[K] | undefined {
  const v = JSON.parse(core().rich_common_mark_value(JSON.stringify(doc), range.start, range.end, mark)) as Marks[K] | null;
  return v ?? undefined;
}

/** Stabile JSON-Serialisierung (normalisiert, feste Schlüsselreihenfolge): gleiche Dokumente, gleicher String. */
export function serialize(doc: RichTextDoc): string {
  return core().rich_serialize(JSON.stringify(doc));
}

// ── Style-Presets ──────────────────────────────────────────────────────────

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
  return parseDoc(core().rich_apply_preset(JSON.stringify(doc), range.start, range.end, JSON.stringify(preset)), doc);
}
