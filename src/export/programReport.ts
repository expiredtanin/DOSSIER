// Soll/Ist-Nachweis des Raumprogramms ([61]): derselbe Berichtsaufbau wie der Flächennachweis
// (`areaReport.ts`), damit CSV, SVG und PDF dieselbe Quelle und denselben Seitenaufbau haben.
// Die Zahlen rechnet der Kern (`analysis/roomProgram.ts`); hier nur die Beschriftung mit `t()`.

import type { Project } from "../model/types";
import { t } from "../i18n";
import { compareRoomProgram } from "../analysis/roomProgram";
import type { CompareSum, Light } from "../analysis/roomProgram";
import type { AreaReport, Cell, ReportRow, ReportSection } from "./areaReport";

const num = (n: number | null, d: number): Cell => ({ n: n !== null && Number.isFinite(n) ? n : null, d });
const pct = (p: number | null): Cell => num(p === null ? null : p * 100, 1);

const STATUS_KEY = {
  ok: "program.status.ok",
  "zu klein": "program.status.tooSmall",
  "zu gross": "program.status.tooLarge",
  fehlt: "program.status.missing",
  "zu wenige": "program.status.tooFew",
  "zu viele": "program.status.tooMany",
} as const;

const lightText = (l: Light): string => t(`program.report.light.${l}`);

function sumRows(sums: CompareSum[], emptyLabel: string): ReportRow[] {
  return sums.map((s) => ({ cells: [s.key || emptyLabel, num(s.soll, 2), num(s.ist, 2), num(s.diff, 2), pct(s.diffPct), lightText(s.light)] }));
}

/** Bericht „Raumprogramm Soll/Ist": Tabelle je Raum mit Total, Summen je Gruppe und je Flächenart. */
export function buildProgramReport(project: Project): AreaReport {
  const c = compareRoomProgram(project);
  const sections: ReportSection[] = [];
  const rows: ReportRow[] = c.rows.map((r) => ({
    cells: [
      r.name,
      r.group ?? "",
      r.kind ?? "",
      num(r.targetCount, 0),
      num(r.targetArea, 2),
      num(r.soll, 2),
      num(r.count, 0),
      num(r.ist, 2),
      num(r.diff, 2),
      pct(r.diffPct),
      `${t(STATUS_KEY[r.status])} (${lightText(r.light)})`,
    ],
  }));
  rows.push({ total: true, cells: [t("program.compare.total"), "", "", "", "", num(c.total.soll, 2), "", num(c.total.ist, 2), num(c.total.diff, 2), pct(c.total.diffPct), lightText(c.total.light)] });
  sections.push({
    heading: t("program.report.table"),
    columns: [
      t("program.compare.col.name"),
      t("program.field.group"),
      t("program.field.kind"),
      t("program.field.count"),
      t("program.field.area"),
      t("program.compare.col.soll"),
      t("program.compare.col.count"),
      t("program.compare.col.ist"),
      t("program.compare.col.diff"),
      t("program.compare.col.pct"),
      t("program.compare.col.status"),
    ],
    widths: [3.2, 2.2, 1.4, 1.2, 1.6, 1.6, 1.2, 1.6, 1.6, 1.4, 3.4],
    rows,
  });
  const sumColumns = (first: string) => [first, t("program.compare.col.soll"), t("program.compare.col.ist"), t("program.compare.col.diff"), t("program.compare.col.pct"), t("program.compare.col.status")];
  const sumWidths = [4, 1.6, 1.6, 1.6, 1.4, 2.4];
  if (c.groups.some((g) => g.key !== "")) {
    sections.push({ heading: t("program.compare.groups"), columns: sumColumns(t("program.field.group")), widths: sumWidths, rows: sumRows(c.groups, t("program.compare.noGroup")) });
  }
  if (c.kinds.some((k) => k.key !== "")) {
    sections.push({ heading: t("program.compare.kinds"), columns: sumColumns(t("program.field.kind")), widths: sumWidths, rows: sumRows(c.kinds, t("program.compare.noKind")) });
  }
  const notes = [t("program.report.note.tolerance", { pct: (c.tolerance * 100).toFixed(0), pct2: (c.tolerance * 200).toFixed(0) })];
  if (c.kinds.some((k) => k.key !== "")) notes.push(t("program.report.note.sia"));
  if (c.extra.length > 0) notes.push(t("program.compare.extra", { n: c.extra.length, area: c.extraArea.toFixed(1) }));
  return { title: t("program.report.title"), projectName: project.name ?? "", sections, notes };
}
