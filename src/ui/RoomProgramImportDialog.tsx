// Raumprogramm aus einer Tabelle importieren ([61]): Blatt wählen, Kopfzeile und Spalten zuordnen
// (Vorschlag nach den Spaltennamen), Vorschau, ersetzen oder anhängen. Die Datei liest der Rust-Leser
// (`fileio/src/sheet_import.rs`: .xlsx, .ods, .csv/.tsv); die Zuordnung steht in `io/roomProgramImport.ts`.
//
// `RoomProgramImportButton` zeigt den Knopf „Raumprogramm importieren …" samt verstecktem Datei-Feld und
// öffnet danach den Dialog (Overlay über ein Portal, damit er im Panel nicht abgeschnitten wird).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { roomProgramOps, cellText, importedRows, mapRows, PROGRAM_FIELDS, readSheetFile, suggestMapping } from "../core";
import type { CoreOp, ImportMode, Mapping, ProgramField, SheetData, SkipReason } from "../core";
import type { Project, RoomProgramRow } from "../model/types";

const FIELD_KEY: Record<ProgramField, TranslationKey> = {
  name: "program.field.name",
  area: "program.field.area",
  count: "program.field.count",
  kind: "program.field.kind",
  group: "program.field.group",
  note: "program.field.note",
};

const SKIP_KEY: Record<SkipReason, TranslationKey> = {
  empty: "program.import.skip.empty",
  sum: "program.import.skip.sum",
  noName: "program.import.skip.noName",
  noArea: "program.import.skip.noArea",
  header: "program.import.skip.header",
};

/** Spaltenbuchstabe: 0 → A, 26 → AA. */
function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const MAX_PREVIEW_ROWS = 60;
const MAX_PREVIEW_COLS = 12;

export interface RoomProgramImportDialogProps {
  fileName: string;
  sheets: SheetData[];
  /** Zeilen, die das Projekt schon hat (für „anhängen"). */
  existing: number;
  onImport: (rows: RoomProgramRow[], mode: ImportMode) => void;
  onClose: () => void;
}

export function RoomProgramImportDialog({ fileName, sheets, existing, onImport, onClose }: RoomProgramImportDialogProps) {
  const [sheetIdx, setSheetIdx] = useState(() => {
    // Erstes Blatt mit Inhalt.
    const i = sheets.findIndex((s) => s.rows.length > 0);
    return i < 0 ? 0 : i;
  });
  const sheet = sheets[sheetIdx];
  const rows = sheet?.rows ?? [];
  const [mapping, setMapping] = useState<Mapping>(() => suggestMapping(rows));
  const [skipSums, setSkipSums] = useState(true);
  const [mode, setMode] = useState<ImportMode>(existing > 0 ? "append" : "replace");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickSheet = (i: number) => {
    setSheetIdx(i);
    setMapping(suggestMapping(sheets[i]?.rows ?? []));
  };

  const lines = useMemo(() => mapRows(rows, mapping, { skipSums }), [rows, mapping, skipSums]);
  const imported = useMemo(() => importedRows(lines), [lines]);
  const lineByRow = useMemo(() => new Map(lines.map((l) => [l.sheetRow, l] as const)), [lines]);
  const skipped = lines.filter((l) => l.skip && l.skip !== "empty" && l.skip !== "header" && !l.groupHeading).length;
  const unknownKinds = lines.filter((l) => l.unknownKind).length;
  const ready = mapping.columns.name !== undefined && mapping.columns.area !== undefined && imported.length > 0;

  const width = Math.min(MAX_PREVIEW_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
  const fieldOfCol = (c: number): ProgramField | "" => PROGRAM_FIELDS.find((f) => mapping.columns[f] === c) ?? "";
  const setColumn = (c: number, f: ProgramField | "") =>
    setMapping((m) => {
      const columns = { ...m.columns };
      for (const k of PROGRAM_FIELDS) if (columns[k] === c) delete columns[k];
      if (f) columns[f] = c;
      return { ...m, columns };
    });
  const shown = rows.slice(0, MAX_PREVIEW_ROWS);

  const dialog = (
    <div className="imp-overlay" onClick={onClose}>
      <div className="imp-dialog rpi-dialog" role="dialog" aria-modal="true" aria-label={t("program.import.title")} onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("program.import.title")}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="rpi-file">{fileName}</div>
            <div className="rpi-controls">
              {sheets.length > 1 && (
                <label>
                  <span>{t("program.import.sheet")}</span>
                  <select className="rpi-select" value={sheetIdx} onChange={(e) => pickSheet(Number(e.target.value))}>
                    {sheets.map((s, i) => (
                      <option key={i} value={i}>
                        {s.name || `${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <span>{t("program.import.header")}</span>
                <select
                  className="rpi-select"
                  value={mapping.headerRow === null ? "" : String(mapping.headerRow)}
                  onChange={(e) => setMapping((m) => ({ ...m, headerRow: e.target.value === "" ? null : Number(e.target.value) }))}
                >
                  <option value="">{t("program.import.header.none")}</option>
                  {rows.slice(0, 20).map((_, i) => (
                    <option key={i} value={i}>
                      {t("program.import.row", { n: i + 1 })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("program.import.columns")}</div>
            <div className="rpi-scroll">
              <table className="rpi-table">
                <thead>
                  <tr>
                    <th className="rpi-rownr" />
                    {Array.from({ length: width }, (_, c) => (
                      <th key={c}>
                        <select
                          className={"rpi-select rpi-colsel" + (fieldOfCol(c) ? " mapped" : "")}
                          value={fieldOfCol(c)}
                          aria-label={t("program.import.columnOf", { col: colLetter(c) })}
                          onChange={(e) => setColumn(c, e.target.value as ProgramField | "")}
                        >
                          <option value="">{colLetter(c)} · –</option>
                          {PROGRAM_FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {colLetter(c)} · {t(FIELD_KEY[f])}
                            </option>
                          ))}
                        </select>
                      </th>
                    ))}
                    <th>{t("program.import.state")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => {
                    const line = lineByRow.get(i);
                    const before = mapping.headerRow !== null && i < mapping.headerRow;
                    const cls = line?.row ? "ok" : "skip";
                    return (
                      <tr key={i} className={before ? "skip" : cls + (line?.skip === "header" ? " head" : "")}>
                        <td className="rpi-rownr">{i + 1}</td>
                        {Array.from({ length: width }, (_, c) => (
                          <td key={c} className={fieldOfCol(c) ? "mapped" : ""}>
                            {cellText(r[c])}
                          </td>
                        ))}
                        <td className="rpi-state">
                          {line?.row
                            ? line.unknownKind
                              ? t("program.import.unknownKind", { kind: line.unknownKind })
                              : "✓"
                            : line?.groupHeading
                              ? t("program.import.skip.group")
                              : line?.skip
                                ? t(SKIP_KEY[line.skip])
                                : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > shown.length && <div className="imp-note">{t("program.import.more", { n: rows.length - shown.length })}</div>}
          </section>

          <section className="imp-section">
            <label className="imp-check">
              <input type="checkbox" checked={skipSums} onChange={(e) => setSkipSums(e.target.checked)} />
              <span>{t("program.import.skipSums")}</span>
            </label>
            <label className="imp-radio">
              <input type="radio" name="rpi-mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
              <span>{t("program.import.mode.replace")}</span>
            </label>
            <label className="imp-radio">
              <input type="radio" name="rpi-mode" checked={mode === "append"} onChange={() => setMode("append")} disabled={existing === 0} />
              <span>{t("program.import.mode.append", { n: existing })}</span>
            </label>
            <div className={"imp-note" + (ready ? "" : " imp-warn")}>
              {mapping.columns.name === undefined || mapping.columns.area === undefined
                ? t("program.import.needNameArea")
                : t("program.import.summary", { n: imported.length, s: skipped })}
              {unknownKinds > 0 ? ` ${t("program.import.unknownKinds", { n: unknownKinds })}` : ""}
            </div>
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" disabled={!ready} onClick={() => onImport(imported, mode)}>
            {t("program.import.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}

export interface RoomProgramImportButtonProps {
  project: Project;
  /** Übernimmt die Zeilen ins Projekt (ein Undo-Schritt). */
  onApply: (build: (p: Project) => readonly CoreOp[]) => void;
  notify: (message: string, kind?: "info" | "warning" | "error") => void;
}

/** Knopf mit Datei-Auswahl; liest die Tabelle und öffnet den Dialog. */
export function RoomProgramImportButton({ project, onApply, notify }: RoomProgramImportButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<{ name: string; sheets: SheetData[] } | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const sheets = await readSheetFile(new Uint8Array(await file.arrayBuffer()), file.name);
      if (sheets.every((s) => s.rows.length === 0)) throw new Error(t("program.import.empty"));
      setData({ name: file.name, sheets });
    } catch (e) {
      notify(t("program.import.readFail", { msg: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.ods,.csv,.tsv,.txt"
        hidden
        data-testid="program-import-file"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button type="button" className="kz-add" onClick={() => input.current?.click()}>
        {t("program.import")}
      </button>
      {data && (
        <RoomProgramImportDialog
          fileName={data.name}
          sheets={data.sheets}
          existing={project.roomProgram?.length ?? 0}
          onClose={() => setData(null)}
          onImport={(rows, mode) => {
            onApply((p) => roomProgramOps(p, rows, mode));
            notify(t("program.import.done", { n: rows.length }));
            setData(null);
          }}
        />
      )}
    </>
  );
}
