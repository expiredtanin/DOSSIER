// Kostenschätzung grob ([209]) als Bericht: dasselbe Berichtsmodell wie der Flächen-Nachweis ([70]), daher
// dieselben Ausgaben (CSV über `areaReportToCsv`, Vektor-PDF über `buildAreaReportPdf`). Gerechnet wird im
// Kern (`analysis/costEstimate.ts` → `kosten.rs`); hier nur Aufbau und Beschriftung mit `t()`.

import type { Project } from "../model/types";
import { t } from "../i18n/translate";
import { computeCostEstimate, formatChf } from "../analysis/costEstimate";
import type { CostResult, CostRow } from "../analysis/costEstimate";
import type { AreaReport, Cell, ReportRow } from "./areaReport";

/** Franken (ganze, Tausender-Apostroph in PDF/Blatt; die CSV bleibt ohne Trenner). */
const chf = (n: number | null | undefined): Cell => ({ n: n === undefined || n === null || !Number.isFinite(n) ? null : n, d: 0, g: true });
const qty = (n: number, d = 1): Cell => ({ n: Number.isFinite(n) ? n : null, d, g: true });
const pctText = (v: number) => `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} %`;

/** Bezeichnung einer Kennwert-Zeile: eigener Name oder eBKP-H-Hauptgruppe. */
export function costGroupLabel(code: string, name?: string | null): string {
  if (name && name.trim()) return name;
  const key = `costs.group.${code}`;
  const s = t(key);
  return s === key ? code : s;
}

export function costUnitLabel(r: Pick<CostRow, "unit">): string {
  return r.unit || t("costs.lump");
}

/** Bericht der Kostenschätzung (Tabelle, Mengen, Kennwerte/Bandbreite, Fussnoten). */
export function buildCostReport(project: Project, result: CostResult = computeCostEstimate(project)): AreaReport {
  const r = result;
  const rows: ReportRow[] = r.rows.map((g) => ({
    cells: [g.code, costGroupLabel(g.code, g.name) + (g.example ? " *" : ""), qty(g.quantity, g.unit ? 1 : 0), costUnitLabel(g), chf(g.rate), chf(g.amount)],
  }));
  const sum = (label: string, n: number, total = false, code = ""): ReportRow => ({ total, cells: [code, label, "", "", "", chf(n)] });
  rows.push(sum(t("costs.row.subtotal"), r.subtotal, true));
  rows.push(sum(`${t("costs.row.fees")} ${pctText(r.feesPct)}`, r.fees, false, "V"));
  rows.push(sum(`${t("costs.row.reserve")} ${pctText(r.reservePct)}`, r.reserve, false, "Y"));
  rows.push(sum(t("costs.row.net"), r.net, true));
  rows.push(sum(`${t("costs.row.vat")} ${pctText(r.vatPct)}`, r.vat, false, "Z"));
  rows.push(sum(t("costs.row.gross"), r.gross, true));

  const q = r.quantities;
  const notes: string[] = [];
  if (r.hasExample) notes.push(t("costs.foot.example"));
  notes.push(t("costs.foot.priceBase", { base: r.priceBase || "–", region: r.regionFactor.toFixed(2), index: r.indexFactor.toFixed(2) }));
  for (const k of r.notes) notes.push(t(`costs.note.${k}`, { pct: pctText(r.accuracyPct) }));
  notes.push(t("costs.foot.ebkp"));

  return {
    title: t("costs.title"),
    projectName: project.name ?? "",
    sections: [
      {
        heading: `${t("costs.table")} · ${t(`costs.method.${r.method}`)}`,
        columns: [t("costs.col.code"), t("costs.col.group"), t("costs.col.quantity"), t("costs.col.unit"), t("costs.col.rate"), t("costs.col.amount")],
        widths: [1, 5, 1.8, 1, 1.6, 2.2],
        rows,
      },
      {
        heading: t("costs.range.title"),
        columns: [t("costs.col.value"), "CHF"],
        widths: [6, 2.2],
        rows: [
          { cells: [t("costs.range.low", { pct: pctText(r.accuracyPct) }), chf(r.low)] },
          { cells: [t("costs.range.high", { pct: pctText(r.accuracyPct) }), chf(r.high)] },
          { cells: [t("costs.perGv"), chf(r.perGv)] },
          { cells: [t("costs.perGf"), chf(r.perGf)] },
        ],
      },
      {
        heading: t("costs.quantities"),
        columns: [t("costs.col.quantityName"), t("costs.col.quantity"), t("costs.col.unit")],
        widths: [6, 1.8, 1],
        rows: [
          { cells: [t("costs.q.gv"), qty(q.gv), "m³"] },
          { cells: [t("costs.q.gf"), qty(q.gf), "m²"] },
          { cells: [t("costs.q.hnf"), qty(q.hnf), "m²"] },
          { cells: [t("costs.q.facade"), qty(q.facade), "m²"] },
          { cells: [t("costs.q.roof"), qty(q.roof), "m²"] },
        ],
      },
    ],
    notes,
  };
}

export { formatChf };
