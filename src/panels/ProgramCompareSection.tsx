// Soll/Ist-Vergleich des Raumprogramms und „Räume generieren" ([61]) im Flächenbilanz-Panel.
//
//  • Tabelle: Soll (Anzahl × Fläche), Ist (aus den gezeichneten Räumen, Zuordnung über den Namen),
//    Differenz absolut und in %, Ampel; darunter Summen je Gruppe, je Flächenart und gesamt.
//  • Toleranz der Ampel (Standard ±5 %) liegt im Projekt (`roomProgramTolerance`).
//  • Export CSV/PDF aus demselben Berichtsmodell (`export/programReport.ts`).
//  • „Räume generieren": neues Blatt mit einem Rechteck je Soll-Raum (4:3), s. `analysis/roomProgramSheet.ts`.
// Herleitung der Zahlen: `src-tauri/core/src/room_program.rs`.

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { usePanelHost } from "./host";
import { useStore } from "../state/appStore";
import { addProgramSheet, areaReportToCsv, buildAreaReportPdf, buildProgramReport, buildProgramSheet, compareRoomProgram, defaultSheetLabels, DEFAULT_PROGRAM_TOLERANCE } from "../core";
import type { CompareRow, CompareSum, Light } from "../core";
import type { Project } from "../model/types";
import { downloadCsv } from "./downloadFile";

const fmt = (n: number, d = 1) => n.toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Mit Vorzeichen; was auf die angezeigte Stelle zu 0 rundet, bleibt ohne Vorzeichen. */
const signed = (n: number, d = 1) => (Math.abs(n) < 0.5 * 10 ** -d ? fmt(0, d) : (n > 0 ? "+" : "−") + fmt(Math.abs(n), d));

function Dot({ light }: { light: Light }) {
  return <span className={`pc-dot ${light}`} title={t(`program.compare.light.${light}` as TranslationKey)} role="img" aria-label={t(`program.compare.light.${light}` as TranslationKey)} />;
}

function SumRow({ s, label, total }: { s: CompareSum; label: string; total?: boolean }) {
  return (
    <tr className={total ? "total" : ""}>
      <td colSpan={2}>
        <Dot light={s.light} /> {label}
      </td>
      <td className="num">{fmt(s.soll)}</td>
      <td className="num">{fmt(s.ist)}</td>
      <td className="num">{signed(s.diff)}</td>
      <td className="num">{s.diffPct === null ? "–" : signed(s.diffPct * 100)}</td>
    </tr>
  );
}

export function ProgramCompareSection({ statusLabel }: { statusLabel: (status: CompareRow["status"]) => string }) {
  const host = usePanelHost();
  const project = host.project;
  const setProject = useStore((s) => s.setProject);
  const notify = useStore((s) => s.notify);
  const c = compareRoomProgram(project);
  if (c.rows.length === 0) return null;
  const stem = `${project.name || "projekt"}-raumprogramm`;
  const hasGroups = c.groups.some((g) => g.key !== "");
  const hasKinds = c.kinds.some((k) => k.key !== "");

  const setTolerance = (text: string) => {
    const v = Number(text.trim().replace(",", "."));
    setProject((p: Project) => {
      const { roomProgramTolerance: _old, ...rest } = p;
      return text.trim() !== "" && Number.isFinite(v) && v >= 0 && v <= 100 ? { ...rest, roomProgramTolerance: v / 100 } : rest;
    }, "roomProgramTolerance");
  };

  const exportPdf = () => {
    try {
      buildAreaReportPdf(buildProgramReport(project)).save(`${stem}.pdf`);
    } catch {
      notify(t("program.compare.exportPdf.fail"));
    }
  };

  const generate = () => {
    const sheet = buildProgramSheet(project, defaultSheetLabels());
    if (sheet.drawings.length === 0) {
      notify(t("program.generate.none"), "warning");
      return;
    }
    // Ein setProject = ein Undo-Schritt: Ebene und alle Zeichnungen zusammen.
    setProject((p: Project) => addProgramSheet(p, sheet));
    host.onSelectLevel(sheet.level.id);
    notify(t("program.generate.done", { n: sheet.layout.items.length, name: sheet.level.name }));
  };

  return (
    <div className="pc-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("program.compare.title")}</span>
        <span className="area-actions">
          <button type="button" className="balance-export" onClick={() => downloadCsv(`${stem}.csv`, areaReportToCsv(buildProgramReport(project)))}>
            {t("program.compare.exportCsv")}
          </button>
          <button type="button" className="balance-export" onClick={exportPdf}>
            {t("program.compare.exportPdf")}
          </button>
        </span>
      </div>

      <label className="kz-parcel" title={t("program.compare.tolerance.hint")}>
        <span>{t("program.compare.tolerance")}</span>
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          className="kz-input kz-num"
          value={project.roomProgramTolerance !== undefined ? String(Math.round(project.roomProgramTolerance * 1000) / 10) : ""}
          placeholder={String(DEFAULT_PROGRAM_TOLERANCE * 100)}
          onChange={(e) => setTolerance(e.target.value)}
        />
        <span>%</span>
      </label>

      <div className="area-scroll">
        <table className="area-table pc-table">
          <thead>
            <tr>
              <th>{t("program.compare.col.name")}</th>
              <th className="num" title={t("program.compare.col.count")}>{t("program.count")}</th>
              <th className="num">{t("program.compare.col.soll")}</th>
              <th className="num">{t("program.compare.col.ist")}</th>
              <th className="num">{t("program.compare.col.diff")}</th>
              <th className="num">{t("program.compare.col.pct")}</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.index} title={statusLabel(r.status)}>
                <td>
                  <Dot light={r.light} /> {r.name || "–"}
                </td>
                <td className="num">
                  {r.count}/{r.targetCount}
                </td>
                <td className="num">{fmt(r.soll)}</td>
                <td className="num">{fmt(r.ist)}</td>
                <td className="num">{signed(r.diff)}</td>
                <td className="num">{r.diffPct === null ? "–" : signed(r.diffPct * 100)}</td>
              </tr>
            ))}
            {hasGroups && (
              <>
                <tr className="pc-sub">
                  <td colSpan={6}>{t("program.compare.groups")}</td>
                </tr>
                {c.groups.map((g) => (
                  <SumRow key={"g" + g.key} s={g} label={g.key || t("program.compare.noGroup")} />
                ))}
              </>
            )}
            {hasKinds && (
              <>
                <tr className="pc-sub">
                  <td colSpan={6}>{t("program.compare.kinds")}</td>
                </tr>
                {c.kinds.map((k) => (
                  <SumRow key={"k" + k.key} s={k} label={k.key || t("program.compare.noKind")} />
                ))}
              </>
            )}
            <SumRow s={c.total} label={t("program.compare.total")} total />
          </tbody>
        </table>
      </div>
      {c.extra.length > 0 && <div className="kz-extra">{t("program.compare.extra", { n: c.extra.length, area: fmt(c.extraArea) })}</div>}
      {hasKinds && <div className="kz-extra">{t("program.report.note.sia")}</div>}

      <button type="button" className="kz-add" title={t("program.generate.hint")} onClick={generate}>
        {t("program.generate")}
      </button>
    </div>
  );
}
