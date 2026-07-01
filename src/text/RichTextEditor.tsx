// WYSIWYG Rich-Text-Editor-Komponente. Kontrolliert: Props `value`/`onChange`
// steuern den Dokumentzustand; keine interne Dokumentkopie. Toolbar mit
// Bold/Italic/Underline/Strikethrough, Schriftgrösse, Farbe und Presets.
//
// Selektions-Mapping: DOM-Textknoten werden in Dokumentreihenfolge durchlaufen;
// zwischen Block-Elementen (div/p) zählt je eine Absatzgrenze als +1. So entsteht
// ein linearer Zeichen-Offset, der mit TextRange kompatibel ist.

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { docToHtml } from "./renderHtml";
import {
  applyMark,
  applyPreset,
  commonMarkValue,
  DEFAULT_PRESETS,
  docLength,
  emptyDoc,
  isMarkActive,
  normalizeDoc,
  serialize,
  toggleMark,
} from "./richText";
import type {
  BoolMark,
  Marks,
  RichTextDoc,
  TextRange,
  TextStylePreset,
} from "./richText";

// ── Props ────────────────────────────────────────────────────────────────────

export interface RichTextEditorProps {
  value: RichTextDoc;
  onChange: (doc: RichTextDoc) => void;
  presets?: TextStylePreset[];
  autoFocus?: boolean;
}

// ── DOM ↔ Modell-Offset-Übersetzung ─────────────────────────────────────────

/**
 * Wandelt eine DOM-Position (Node + Offset innerhalb des Nodes) in einen
 * linearen Modell-Offset um. Die contenteditable enthält pro Absatz ein <div>,
 * darin <span>-Runs; leere Absätze haben ein <br>.
 * Linearer Modell-Offset = Summe der Zeichen in vorigen Absätzen
 *   + Absatz-Index als Trennzeichen-Offset (+1 je Absatzumbruch)
 *   + Zeichen innerhalb des aktuellen Absatzes bis zur Position.
 */
function domOffsetToModelOffset(
  editorEl: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  const divs = Array.from(editorEl.children) as HTMLElement[];
  let modelOffset = 0;

  for (let pIdx = 0; pIdx < divs.length; pIdx++) {
    const div = divs[pIdx];
    if (div === targetNode || div.contains(targetNode)) {
      let found = false;
      let paraOffset = 0;

      const walkPara = (node: Node): boolean => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node === targetNode) {
            paraOffset += targetOffset;
            found = true;
            return true;
          }
          paraOffset += (node as Text).length;
          return false;
        }
        for (const child of Array.from(node.childNodes)) {
          if ((child as Element).tagName === "BR") {
            if (child === targetNode || node === targetNode) {
              found = true;
              return true;
            }
            continue;
          }
          if (walkPara(child)) return true;
        }
        return false;
      };

      if (targetNode === div) {
        const children = Array.from(div.childNodes);
        const limit = Math.min(targetOffset, children.length);
        for (let i = 0; i < limit; i++) {
          const child = children[i];
          if (child.nodeType === Node.TEXT_NODE) {
            paraOffset += (child as Text).length;
          } else {
            paraOffset += (child as Element).textContent?.length ?? 0;
          }
        }
        found = true;
      } else {
        walkPara(div);
      }

      if (!found) {
        paraOffset = div.textContent?.replace(/\n/g, "").length ?? 0;
      }

      return modelOffset + paraOffset;
    }

    const paraText = div.textContent ?? "";
    modelOffset += paraText.length + 1; // +1 für '\n'-Trennzeichen
  }

  return modelOffset;
}

/**
 * Findet für einen linearen Modell-Offset den DOM-Node und Offset darin.
 */
function modelOffsetToDomPos(
  editorEl: HTMLElement,
  modelOffset: number,
): { node: Node; offset: number } | null {
  const divs = Array.from(editorEl.children) as HTMLElement[];
  let remaining = modelOffset;

  for (let pIdx = 0; pIdx < divs.length; pIdx++) {
    const div = divs[pIdx];
    const paraLen = div.textContent?.length ?? 0;

    if (remaining <= paraLen) {
      let found: { node: Node; offset: number } | null = null;
      let chars = remaining;

      const walk = (node: Node): boolean => {
        if (node.nodeType === Node.TEXT_NODE) {
          const len = (node as Text).length;
          if (chars <= len) {
            found = { node, offset: chars };
            return true;
          }
          chars -= len;
          return false;
        }
        if ((node as Element).tagName === "BR") {
          if (chars === 0) {
            found = { node: div, offset: 0 };
            return true;
          }
          return false;
        }
        for (const child of Array.from(node.childNodes)) {
          if (walk(child)) return true;
        }
        return false;
      };

      walk(div);

      if (!found) {
        found = { node: div, offset: div.childNodes.length };
      }
      return found;
    }

    remaining -= paraLen + 1;
  }

  const lastDiv = divs[divs.length - 1];
  if (!lastDiv) return null;
  return { node: lastDiv, offset: lastDiv.childNodes.length };
}

// ── Plain-Text aus Editor-DOM ────────────────────────────────────────────────

function editorInnerText(editorEl: HTMLElement): string {
  const divs = Array.from(editorEl.children) as HTMLElement[];
  if (divs.length === 0) {
    return editorEl.innerText.replace(/\n$/, "");
  }
  return divs
    .map((div) => {
      if (div.children.length === 1 && (div.children[0] as Element).tagName === "BR") {
        return "";
      }
      return div.textContent ?? "";
    })
    .join("\n");
}

// ── Dokument aus bearbeitetem Text rekonstruieren ────────────────────────────

function rebuildDocFromText(oldDoc: RichTextDoc, newPlain: string): RichTextDoc {
  const newLines = newPlain.split("\n");
  const oldParas = oldDoc.paragraphs;

  const paragraphs = newLines.map((line, pIdx) => {
    const oldPara = oldParas[pIdx];
    if (!oldPara) {
      return { runs: line.length ? [{ text: line, marks: {} }] : [] };
    }

    type MarkChar = { ch: string; marks: Marks };
    const oldChars: MarkChar[] = [];
    for (const run of oldPara.runs) {
      for (const ch of run.text) {
        oldChars.push({ ch, marks: run.marks });
      }
    }

    const newChars: MarkChar[] = [];
    let oldIdx = 0;
    for (const ch of line) {
      if (oldIdx < oldChars.length && oldChars[oldIdx].ch === ch) {
        newChars.push(oldChars[oldIdx]);
        oldIdx++;
      } else {
        const nearMarks =
          oldIdx < oldChars.length ? oldChars[oldIdx].marks : (oldChars[oldIdx - 1]?.marks ?? {});
        newChars.push({ ch, marks: nearMarks });
      }
    }

    if (newChars.length === 0) return { runs: [] };

    const runs: { text: string; marks: Marks }[] = [];
    let current = { text: newChars[0].ch, marks: newChars[0].marks };
    for (let i = 1; i < newChars.length; i++) {
      const { ch, marks } = newChars[i];
      if (JSON.stringify(marks) === JSON.stringify(current.marks)) {
        current.text += ch;
      } else {
        runs.push(current);
        current = { text: ch, marks };
      }
    }
    runs.push(current);

    return { runs };
  });

  return normalizeDoc({ version: 1, paragraphs });
}

// ── Absatz-Einfügung / Löschung ──────────────────────────────────────────────

function insertParagraphBreak(doc: RichTextDoc, pos: number): RichTextDoc {
  const paras = doc.paragraphs;
  let remaining = pos;
  let pIdx = 0;
  let charOffset = 0;

  for (let i = 0; i < paras.length; i++) {
    const len = paras[i].runs.reduce((n, r) => n + r.text.length, 0);
    if (remaining <= len) {
      pIdx = i;
      charOffset = remaining;
      break;
    }
    remaining -= len + 1;
    if (i === paras.length - 1) {
      return normalizeDoc({ version: 1, paragraphs: [...paras, { runs: [] }] });
    }
  }

  const para = paras[pIdx];
  type MarkChar = { ch: string; marks: Marks };
  const chars: MarkChar[] = [];
  for (const run of para.runs) {
    for (const ch of run.text) {
      chars.push({ ch, marks: run.marks });
    }
  }

  const buildPara = (chs: MarkChar[]) => {
    if (chs.length === 0) return { runs: [] };
    const runs: { text: string; marks: Marks }[] = [];
    let cur = { text: chs[0].ch, marks: chs[0].marks };
    for (let i = 1; i < chs.length; i++) {
      if (JSON.stringify(chs[i].marks) === JSON.stringify(cur.marks)) {
        cur.text += chs[i].ch;
      } else {
        runs.push(cur);
        cur = { text: chs[i].ch, marks: chs[i].marks };
      }
    }
    runs.push(cur);
    return { runs };
  };

  const before = buildPara(chars.slice(0, charOffset));
  const after = buildPara(chars.slice(charOffset));
  const newParas = [
    ...paras.slice(0, pIdx),
    { ...before, align: para.align },
    { ...after, align: para.align },
    ...paras.slice(pIdx + 1),
  ];
  return normalizeDoc({ version: 1, paragraphs: newParas });
}

function plainTextFromDoc(doc: RichTextDoc): string {
  return doc.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

function deleteCharAt(doc: RichTextDoc, pos: number): RichTextDoc {
  if (pos < 0) return doc;
  const plain = plainTextFromDoc(doc);
  if (pos >= plain.length) return doc;

  if (plain[pos] === "\n") {
    return mergeParaAt(doc, pos);
  }

  const newPlain = plain.slice(0, pos) + plain.slice(pos + 1);
  return rebuildDocFromText(doc, newPlain);
}

function mergeParaAt(doc: RichTextDoc, _pos: number): RichTextDoc {
  const paras = doc.paragraphs;
  let cursor = 0;
  for (let i = 0; i < paras.length - 1; i++) {
    const len = paras[i].runs.reduce((n, r) => n + r.text.length, 0);
    cursor += len;
    if (cursor === _pos) {
      const merged = {
        runs: [...paras[i].runs, ...paras[i + 1].runs],
        align: paras[i].align,
      };
      const newParas = [...paras.slice(0, i), merged, ...paras.slice(i + 2)];
      return normalizeDoc({ version: 1, paragraphs: newParas });
    }
    cursor += 1;
  }
  return doc;
}

// ── Selektion lesen / wiederherstellen ──────────────────────────────────────

function readSelection(editorEl: HTMLElement): TextRange | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return null;

  const start = domOffsetToModelOffset(editorEl, range.startContainer, range.startOffset);
  const end = domOffsetToModelOffset(editorEl, range.endContainer, range.endOffset);
  return { start, end };
}

function restoreSelection(editorEl: HTMLElement, selRange: TextRange | null): void {
  if (!selRange) return;
  const sel = window.getSelection();
  if (!sel) return;

  const startPos = modelOffsetToDomPos(editorEl, selRange.start);
  const endPos = modelOffsetToDomPos(editorEl, selRange.end);
  if (!startPos || !endPos) return;

  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // Ungültige DOM-Position ignorieren.
  }
}

// ── Komponente ───────────────────────────────────────────────────────────────

export function RichTextEditor({
  value,
  onChange,
  presets,
  autoFocus,
}: RichTextEditorProps): JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  // Letzter in innerHTML geschriebener serialisierter Zustand — verhindert
  // Cursor-Sprünge durch unnötige DOM-Updates.
  const lastSerializedRef = useRef<string>("");
  // Verhindert das nächste onInput nach programmatischem innerHTML-Set.
  const suppressNextInput = useRef(false);
  // Ausgewählter Bereich im linearen Modell-Offset-Raum.
  const [selRange, setSelRange] = useState<TextRange | null>(null);
  // Immer aktuelles value/onChange ohne Stale-Closure-Problem (keine useCallback-Deps).
  const valueRef = useRef<RichTextDoc>(value);
  const onChangeRef = useRef<(doc: RichTextDoc) => void>(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  const effectivePresets = presets ?? DEFAULT_PRESETS;

  // ── HTML-Renderer ──────────────────────────────────────────────────────────

  const renderHtml = useCallback((d: RichTextDoc): string => {
    return docToHtml(d, { basePt: 12, color: "var(--ink)" });
  }, []);

  /**
   * Setzt innerHTML direkt. `suppressInput` steuert, ob das daraus folgende
   * Browser-onInput-Ereignis unterdrückt wird (true nur bei programmatischen
   * Edits aus Keyboard-/Toolbar-Handlern, nicht beim externen Prop-Update).
   */
  const setEditorHtml = useCallback(
    (d: RichTextDoc, restoreSel: TextRange | null = null, suppressInput = false) => {
      const el = editorRef.current;
      if (!el) return;
      const serial = serialize(d);
      if (serial !== lastSerializedRef.current) {
        if (suppressInput) suppressNextInput.current = true;
        lastSerializedRef.current = serial;
        el.innerHTML = renderHtml(d);
      }
      if (restoreSel) {
        restoreSelection(el, restoreSel);
      }
    },
    [renderHtml],
  );

  // ── Initiale Render + externe prop-Änderungen ──────────────────────────────

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    // Programmatisches innerHTML-Set feuert kein Browser-onInput — kein suppress nötig.
    const serial = serialize(value);
    lastSerializedRef.current = serial;
    el.innerHTML = renderHtml(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Nur beim Mount.

  useEffect(() => {
    // Externe prop-Änderungen übernehmen ohne Cursor zu versetzen.
    setEditorHtml(value, null);
  }, [value, setEditorHtml]);

  useEffect(() => {
    if (autoFocus) {
      editorRef.current?.focus();
    }
  }, [autoFocus]);

  // ── Selektion verfolgen ────────────────────────────────────────────────────

  const captureSelection = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const range = readSelection(el);
    setSelRange(range);
  }, []);

  // ── Eingabe-Handler ────────────────────────────────────────────────────────

  const handleInput = useCallback(() => {
    if (suppressNextInput.current) {
      suppressNextInput.current = false;
      return;
    }

    const el = editorRef.current;
    if (!el) return;

    const currentSel = readSelection(el);
    const newPlain = editorInnerText(el);
    const newDoc = rebuildDocFromText(valueRef.current, newPlain);

    const serial = serialize(newDoc);
    lastSerializedRef.current = serial;
    onChangeRef.current(newDoc);

    // HTML neu setzen (ohne suppressNextInput — programmatische DOM-Änderungen
    // lösen kein natives input-Event aus) und Selektion wiederherstellen.
    el.innerHTML = renderHtml(newDoc);
    if (currentSel) restoreSelection(el, currentSel);
    setSelRange(currentSel);
  }, [renderHtml]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = editorRef.current;
      if (!el) return;
      const currentSel = readSelection(el);

      if (e.key === "Enter") {
        e.preventDefault();
        const cur = valueRef.current;
        const pos = currentSel?.start ?? plainTextFromDoc(cur).length;
        const newDoc = insertParagraphBreak(cur, pos);
        onChangeRef.current(newDoc);
        const newSel: TextRange = { start: pos + 1, end: pos + 1 };
        setEditorHtml(newDoc, newSel, true);
        setSelRange(newSel);
        return;
      }

      if (e.key === "Backspace") {
        if (currentSel && currentSel.start !== currentSel.end) {
          return;
        }
        const pos = currentSel?.start ?? 0;
        if (pos === 0) return;
        e.preventDefault();
        const cur = valueRef.current;
        const newDoc = deleteCharAt(cur, pos - 1);
        const newPos = pos - 1;
        onChangeRef.current(newDoc);
        const newSel: TextRange = { start: newPos, end: newPos };
        setEditorHtml(newDoc, newSel, true);
        setSelRange(newSel);
        return;
      }

      if (e.key === "Delete") {
        if (currentSel && currentSel.start !== currentSel.end) {
          return;
        }
        const pos = currentSel?.start ?? 0;
        const cur = valueRef.current;
        const plain = plainTextFromDoc(cur);
        if (pos >= plain.length) return;
        e.preventDefault();
        const newDoc = deleteCharAt(cur, pos);
        onChangeRef.current(newDoc);
        const newSel: TextRange = { start: pos, end: pos };
        setEditorHtml(newDoc, newSel, true);
        setSelRange(newSel);
      }
    },
    [setEditorHtml],
  );

  // ── Toolbar-Aktionen ───────────────────────────────────────────────────────

  const effectiveRange = useCallback((): TextRange => {
    if (selRange && selRange.start !== selRange.end) return selRange;
    const len = docLength(valueRef.current);
    return { start: 0, end: Math.max(1, len) };
  }, [selRange]);

  const handleToggleMark = useCallback(
    (mark: BoolMark) => {
      const range = effectiveRange();
      const newDoc = toggleMark(valueRef.current, range, mark);
      onChangeRef.current(newDoc);
      setEditorHtml(newDoc, selRange, true);
    },
    [effectiveRange, selRange, setEditorHtml],
  );

  const handleSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      if (isNaN(v) || v <= 0) return;
      const range = effectiveRange();
      const newDoc = applyMark(valueRef.current, range, "sizePt", v);
      onChangeRef.current(newDoc);
      setEditorHtml(newDoc, selRange, true);
    },
    [effectiveRange, selRange, setEditorHtml],
  );

  const handleColorChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const range = effectiveRange();
      const newDoc = applyMark(valueRef.current, range, "color", e.target.value);
      onChangeRef.current(newDoc);
      setEditorHtml(newDoc, selRange, true);
    },
    [effectiveRange, selRange, setEditorHtml],
  );

  const handlePreset = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      const preset = effectivePresets.find((p) => p.id === id);
      if (!preset) return;
      const range = selRange ?? { start: 0, end: 0 };
      const newDoc = applyPreset(valueRef.current, range, preset);
      onChangeRef.current(newDoc);
      setEditorHtml(newDoc, selRange, true);
      e.target.value = "";
    },
    [effectivePresets, selRange, setEditorHtml],
  );

  // ── Toolbar-Zustand berechnen ──────────────────────────────────────────────

  const queryRange: TextRange =
    selRange && selRange.start !== selRange.end
      ? selRange
      : { start: 0, end: Math.max(1, docLength(value)) };

  const isBold = isMarkActive(value, queryRange, "bold");
  const isItalic = isMarkActive(value, queryRange, "italic");
  const isUnderline = isMarkActive(value, queryRange, "underline");
  const isStrike = isMarkActive(value, queryRange, "strike");

  const currentSize = commonMarkValue(value, queryRange, "sizePt") ?? 12;
  const rawColor = commonMarkValue(value, queryRange, "color") ?? "#ededed";
  const currentColor = rawColor.startsWith("#") ? rawColor : "#ededed";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="rt-editor">
      <div className="rt-toolbar">
        {/* Fett */}
        <button
          type="button"
          className={`rt-btn${isBold ? " rt-btn--active" : ""}`}
          title={t("rt.bold")}
          onMouseDown={(e) => {
            e.preventDefault();
            handleToggleMark("bold");
          }}
        >
          <strong>B</strong>
        </button>

        {/* Kursiv */}
        <button
          type="button"
          className={`rt-btn${isItalic ? " rt-btn--active" : ""}`}
          title={t("rt.italic")}
          onMouseDown={(e) => {
            e.preventDefault();
            handleToggleMark("italic");
          }}
        >
          <em>I</em>
        </button>

        {/* Unterstrichen */}
        <button
          type="button"
          className={`rt-btn${isUnderline ? " rt-btn--active" : ""}`}
          title={t("rt.underline")}
          onMouseDown={(e) => {
            e.preventDefault();
            handleToggleMark("underline");
          }}
        >
          <u>U</u>
        </button>

        {/* Durchgestrichen */}
        <button
          type="button"
          className={`rt-btn${isStrike ? " rt-btn--active" : ""}`}
          title={t("rt.strike")}
          onMouseDown={(e) => {
            e.preventDefault();
            handleToggleMark("strike");
          }}
        >
          <s>S</s>
        </button>

        <div className="rt-toolbar-sep" />

        {/* Schriftgrösse */}
        <label className="rt-toolbar-label" title={t("rt.fontSize")}>
          <input
            type="number"
            className="rt-size-input"
            min={6}
            max={96}
            step={1}
            value={currentSize}
            onChange={handleSizeChange}
            title={t("rt.fontSize")}
          />
          <span className="rt-unit">pt</span>
        </label>

        {/* Farbe */}
        <input
          type="color"
          className="rt-color-input"
          value={currentColor}
          onChange={handleColorChange}
          title={t("rt.color")}
        />

        {/* Presets */}
        {effectivePresets.length > 0 && (
          <select
            className="rt-preset-select"
            defaultValue=""
            onChange={handlePreset}
            title={t("rt.preset")}
          >
            <option value="" disabled>
              {t("rt.preset")} …
            </option>
            {effectivePresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Editierbare Fläche */}
      <div
        ref={editorRef}
        className="rt-surface"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onSelect={captureSelection}
        onKeyUp={captureSelection}
        onMouseUp={captureSelection}
      />
    </div>
  );
}

export default RichTextEditor;
export { emptyDoc };
