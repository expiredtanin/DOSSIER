// Flächen- und Kennzahlen-Nachweis ([70]): ein Berichtsmodell (Tabellen mit Zahlen), daraus CSV,
// SVG und PDF (Vektor, jsPDF) — alle Ausgaben haben dieselbe Quelle.
//
//  • `buildAreaReport`: rechnet über den Kern (`analysis/areaTable.ts`) und beschriftet mit `t()`.
//  • `areaReportToCsv` / `parseAreaReportCsv` / `layoutAreaReport` / `areaReportToSvg`: Fassade über den Kern
//    (`area_report.rs`): CSV mit „;" und Punkt als Dezimaltrenner (die Rückwärtsrichtung gibt die Zahlen so
//    zurück, wie sie ausgegeben wurden), Seitenaufteilung in Papier-mm (A4 quer), SVG.
//  • `buildAreaReportPdf` zeichnet dieselben Primitive mit jsPDF.
//
// Die Flächenarten folgen SIA 416, die Kennziffern der IVHB; Herleitung im Kern (`flaechen.rs`).

import { jsPDF } from "jspdf";
import type { Project } from "../model/types";
import { t } from "../i18n";
import { core } from "../engine/coreWasm";
import { computeAreaTable, computeIvhb } from "../analysis/areaTable";
import type { AreaRow, IvhbOptions } from "../analysis/areaTable";

/** Zelle: Text oder Zahl (`d` Nachkommastellen, `null` = nicht berechenbar). */
export type Cell = string | { n: number | null; d: number };

export interface ReportRow {
  cells: Cell[];
  /** Summenzeile (fett, Linie darüber). */
  total?: boolean;
}

export interface ReportSection {
  heading: string;
  columns: string[];
  /** Relative Spaltenbreiten (Länge = columns). */
  widths: number[];
  rows: ReportRow[];
}

export interface AreaReport {
  title: string;
  projectName: string;
  sections: ReportSection[];
  /** Fussnoten (Quellen, Annahmen). */
  notes: string[];
}

export interface AreaReportOptions {
  /** Flächentabelle aufnehmen (Default ja). */
  areas?: boolean;
  /** IVHB-Kennziffern aufnehmen (Default nein). */
  ivhb?: boolean;
  ivhbOptions?: IvhbOptions;
}

const num = (n: number | null | undefined, d: number): Cell => ({ n: n === undefined || n === null || !Number.isFinite(n) ? null : n, d });

const AREA_COLUMNS = ["HNF", "NNF", "NF", "VF", "FF", "NGF", "KF", "GF", "AGF", "GV"];

function areaCells(r: AreaRow): Cell[] {
  return [r.hnf, r.nnf, r.nf, r.vf, r.ff, r.ngf, r.kf, r.gf, r.agf].map((v) => num(v, 2)).concat(num(r.gv, 1));
}

/** Baut den Bericht aus dem Projekt. */
export function buildAreaReport(project: Project, opts: AreaReportOptions = {}): AreaReport {
  const sections: ReportSection[] = [];
  const notes: string[] = [];
  const addNotes = (keys: string[]) => {
    for (const k of keys) {
      const text = t(`areas.note.${k}`);
      if (!notes.includes(text)) notes.push(text);
    }
  };
  if (opts.areas ?? true) {
    const table = computeAreaTable(project);
    const rows: ReportRow[] = table.levels.map((l) => ({ cells: [l.name, ...areaCells(l)] }));
    // Summenzeile: das GV ist das Gebäudevolumen gemäss Quelle (Körper oder Geschosse).
    rows.push({ total: true, cells: [t("areas.total"), ...areaCells(table.total).slice(0, 9), num(table.gv, 1)] });
    sections.push({
      heading: `${t("areas.table")} [m², GV m³]`,
      columns: [t("areas.level"), ...AREA_COLUMNS],
      widths: [3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2.4],
      rows,
    });
    notes.push(t("areas.foot.sia"));
    addNotes(table.notes);
  }
  if (opts.ivhb) {
    const v = computeIvhb(project, opts.ivhbOptions);
    const basis = t(`areas.basis.${v.agfBasis}`);
    const ratio = (key: string, formula: string, numerator: number | null, value: number | null): ReportRow => ({
      cells: [t(`areas.ratio.${key}`), formula, num(numerator, 2), num(v.agsf, 2), num(value, 3)],
    });
    sections.push({
      heading: `${t("areas.ivhb.title")} · ${t("areas.agsf.source")}: ${t(`areas.src.${v.agsfSource}`)}`,
      columns: [t("areas.col.ratio"), t("areas.col.formula"), t("areas.col.numerator"), t("areas.col.agsf"), t("areas.col.value")],
      widths: [4, 3.2, 1.6, 1.6, 1.2],
      rows: [
        ratio("gfz", t("areas.formula.gfz"), v.gfSum, v.gfz),
        ratio("az", t("areas.formula.az", { basis }), v.agf, v.az),
        ratio("bmz", t("areas.formula.bmz"), v.baumasse, v.bmz),
        ratio("uz", t("areas.formula.uz"), v.agbf, v.uz),
        ratio("gz", t("areas.formula.gz"), v.greenArea, v.gz),
      ],
    });
    sections.push({
      heading: t("areas.heights"),
      columns: [t("areas.col.ratio"), "[m]"],
      widths: [6, 1.5],
      rows: [
        { cells: [t("areas.height.total"), num(v.totalHeight, 2)] },
        { cells: [t("areas.height.facade"), num(v.facadeHeight, 2)] },
      ],
    });
    notes.push(t("areas.foot.ivhb"));
    addNotes(v.notes);
  }
  return { title: t("areas.title"), projectName: project.name ?? "", sections, notes };
}

// ── CSV, Seitenaufteilung, SVG: rechnet der Kern (`core/src/area_report.rs`, Bericht als JSON) ─────────────

/** CSV des Berichts: Titel, Projekt, dann je Abschnitt Überschrift, Kopf, Zeilen; Fussnoten mit „* ". */
export function areaReportToCsv(report: AreaReport, delimiter = ";"): string {
  return core().area_report_csv(JSON.stringify(report), delimiter);
}

export interface ParsedSection {
  heading: string;
  columns: string[];
  /** Zahlen als `number` (Zelle leer → `null` an Zahlenstellen), Texte als `string`. */
  rows: (string | number | null)[][];
}

export interface ParsedReport {
  title: string;
  projectName: string;
  sections: ParsedSection[];
  notes: string[];
}

/** Liest eine mit {@link areaReportToCsv} geschriebene CSV zurück (Rundreise). */
export function parseAreaReportCsv(text: string, delimiter = ";"): ParsedReport {
  return JSON.parse(core().area_report_parse_csv(text, delimiter)) as ParsedReport;
}

type Prim =
  | { k: "text"; x: number; y: number; s: string; size: number; bold?: boolean; align?: "left" | "right" }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; w: number };

export interface ReportLayoutOptions {
  /** Blattgrösse in mm (Default A4 quer). */
  width?: number;
  height?: number;
  margin?: number;
}

/** Teilt den Bericht in Seiten mit Zeichen-Primitiven (Papier-mm). */
export function layoutAreaReport(report: AreaReport, o: ReportLayoutOptions = {}): { width: number; height: number; pages: Prim[][] } {
  return JSON.parse(core().area_report_layout(JSON.stringify(report), JSON.stringify(o)));
}

/** SVG der ersten Seite (Papier-mm, viewBox in mm); `page` wählt eine andere. */
export function areaReportToSvg(report: AreaReport, page = 0, o: ReportLayoutOptions = {}): string {
  return core().area_report_svg(JSON.stringify(report), Math.max(0, page), JSON.stringify(o));
}

/** Die eingebaute Helvetica kennt nur WinAnsi: Zeichen ausserhalb ersetzen. */
function pdfSafe(s: string): string {
  return s.replace(/Σ/g, "Sum").replace(/≈/g, "~").replace(/[–−]/g, "-");
}

/** Vektor-PDF des Berichts (A4 quer, eine oder mehrere Seiten). */
export function buildAreaReportPdf(report: AreaReport, o: ReportLayoutOptions = {}): jsPDF {
  const lay = layoutAreaReport(report, o);
  const doc = new jsPDF({ unit: "mm", format: [lay.width, lay.height], orientation: lay.width > lay.height ? "landscape" : "portrait", compress: true });
  lay.pages.forEach((prims, i) => {
    if (i > 0) doc.addPage([lay.width, lay.height], lay.width > lay.height ? "landscape" : "portrait");
    doc.setTextColor(17, 17, 17);
    doc.setDrawColor(17, 17, 17);
    for (const p of prims) {
      if (p.k === "line") {
        doc.setLineWidth(p.w);
        doc.line(p.x1, p.y1, p.x2, p.y2);
      } else {
        doc.setFont("helvetica", p.bold ? "bold" : "normal");
        doc.setFontSize(p.size);
        doc.text(pdfSafe(p.s), p.x, p.y, { align: p.align ?? "left" });
      }
    }
  });
  return doc;
}
