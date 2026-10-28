// Flächen- und Kennzahlen-Nachweis ([70]): ein Berichtsmodell (Tabellen mit Zahlen), daraus CSV,
// SVG und PDF (Vektor, jsPDF) — alle Ausgaben haben dieselbe Quelle.
//
//  • `buildAreaReport`: rechnet über den Kern (`analysis/areaTable.ts`) und beschriftet mit `t()`.
//  • `areaReportToCsv` / `parseAreaReportCsv`: CSV mit „;" und Punkt als Dezimaltrenner; die
//    Rückwärtsrichtung gibt die Zahlen so zurück, wie sie ausgegeben wurden (gerundet).
//  • `layoutAreaReport`: Seitenaufteilung in Papier-mm (A4 quer); `areaReportToSvg` und
//    `buildAreaReportPdf` zeichnen dieselben Primitive.
//
// Die Flächenarten folgen SIA 416, die Kennziffern der IVHB; Herleitung im Kern (`flaechen.rs`).

import { jsPDF } from "jspdf";
import type { Project } from "../model/types";
import { t } from "../i18n";
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

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvField(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Zelle als Text, so wie sie ausgegeben wird (Punkt als Dezimaltrenner, `null` = leer). */
export function cellText(c: Cell): string {
  if (typeof c === "string") return c;
  return c.n === null ? "" : c.n.toFixed(c.d);
}

/** CSV des Berichts: Titel, Projekt, dann je Abschnitt Überschrift, Kopf, Zeilen; Fussnoten mit „* ". */
export function areaReportToCsv(report: AreaReport, delimiter = ";"): string {
  const line = (cells: string[]) => cells.map(csvField).join(delimiter);
  const out: string[] = [line([report.title]), line([report.projectName]), ""];
  for (const s of report.sections) {
    out.push(line([s.heading]), line(s.columns));
    for (const r of s.rows) out.push(line(r.cells.map(cellText)));
    out.push("");
  }
  for (const n of report.notes) out.push(line([`* ${n}`]));
  return out.join("\n") + "\n";
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

/** Zerlegt CSV-Text in Zeilen von Feldern (Anführungszeichen, Trenner, Zeilenumbruch im Feld). */
function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Liest eine mit {@link areaReportToCsv} geschriebene CSV zurück (Rundreise). */
export function parseAreaReportCsv(text: string, delimiter = ";"): ParsedReport {
  const rows = parseCsvRows(text, delimiter);
  // Blöcke zwischen Leerzeilen (eine Leerzeile = ein Feld "").
  const blocks: string[][][] = [];
  let cur: string[][] = [];
  for (const r of rows) {
    if (r.length === 1 && r[0] === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(r);
  }
  if (cur.length) blocks.push(cur);
  const head = blocks.shift() ?? [];
  const result: ParsedReport = { title: head[0]?.[0] ?? "", projectName: head[1]?.[0] ?? "", sections: [], notes: [] };
  for (const b of blocks) {
    if (b[0]?.[0]?.startsWith("* ")) {
      for (const r of b) result.notes.push(r[0]!.slice(2));
      continue;
    }
    result.sections.push({
      heading: b[0]?.[0] ?? "",
      columns: b[1] ?? [],
      rows: b.slice(2).map((r) => r.map((c, i) => (NUMBER.test(c) ? Number(c) : i === 0 || c !== "" ? c : null))),
    });
  }
  return result;
}

// ── Seitenaufteilung (Papier-mm) und Ausgabe ─────────────────────────────────

type Prim =
  | { k: "text"; x: number; y: number; s: string; size: number; bold?: boolean; align?: "left" | "right" }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; w: number };

export interface ReportLayoutOptions {
  /** Blattgrösse in mm (Default A4 quer). */
  width?: number;
  height?: number;
  margin?: number;
}

/** Zeilenumbruch nach Zeichenzahl (Helvetica ≈ 0.5 em je Zeichen). */
function wrap(text: string, maxMm: number, sizePt: number): string[] {
  const per = Math.max(10, Math.floor(maxMm / (sizePt * 0.3528 * 0.5)));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > per) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Teilt den Bericht in Seiten mit Zeichen-Primitiven. */
export function layoutAreaReport(report: AreaReport, o: ReportLayoutOptions = {}): { width: number; height: number; pages: Prim[][] } {
  const width = o.width ?? 297;
  const height = o.height ?? 210;
  const m = o.margin ?? 12;
  const inner = width - 2 * m;
  const rowH = 6;
  const pages: Prim[][] = [[]];
  let y = m;
  const page = () => pages[pages.length - 1]!;
  const ensure = (h: number) => {
    if (y + h > height - m) {
      pages.push([]);
      y = m;
    }
  };

  page().push({ k: "text", x: m, y: y + 5, s: report.title, size: 15, bold: true });
  y += 8;
  if (report.projectName) {
    page().push({ k: "text", x: m, y: y + 4, s: report.projectName, size: 10 });
    y += 6;
  }
  y += 4;

  for (const s of report.sections) {
    ensure(rowH * 3 + 6);
    page().push({ k: "text", x: m, y: y + 4, s: s.heading, size: 10, bold: true });
    y += 7;
    const sum = s.widths.reduce((a, b) => a + b, 0);
    const xs: number[] = [];
    let x = m;
    for (const w of s.widths) {
      xs.push(x);
      x += (w / sum) * inner;
    }
    xs.push(x);
    const drawRow = (cells: string[], bold: boolean, numeric: boolean[], line: "top" | "bottom" | "none") => {
      ensure(rowH);
      if (line === "top") page().push({ k: "line", x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
      cells.forEach((c, i) => {
        const right = numeric[i] === true;
        page().push({ k: "text", x: right ? xs[i + 1]! - 1.5 : xs[i]! + 1.5, y: y + 4.2, s: c, size: 8.5, bold, align: right ? "right" : "left" });
      });
      y += rowH;
      if (line === "bottom") page().push({ k: "line", x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
    };
    const isNum = (i: number) => s.rows.some((r) => typeof r.cells[i] === "object");
    const numeric = s.columns.map((_, i) => isNum(i));
    drawRow(s.columns, true, numeric, "none");
    page().push({ k: "line", x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
    for (const r of s.rows) {
      drawRow(r.cells.map((c) => (typeof c === "string" ? c : c.n === null ? "–" : c.n.toFixed(c.d))), r.total === true, numeric, r.total ? "top" : "none");
    }
    page().push({ k: "line", x1: m, y1: y, x2: m + inner, y2: y, w: 0.35 });
    y += 6;
  }

  for (const n of report.notes) {
    const lines = wrap(n, inner, 7.5);
    ensure(lines.length * 3.4 + 1);
    for (const l of lines) {
      page().push({ k: "text", x: m, y: y + 2.8, s: l, size: 7.5 });
      y += 3.4;
    }
    y += 1;
  }
  const total = pages.length;
  pages.forEach((p, i) => {
    p.push({ k: "text", x: width - m, y: height - m / 2, s: `${i + 1} / ${total}`, size: 7, align: "right" });
  });
  return { width, height, pages };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** SVG der ersten Seite (Papier-mm, viewBox in mm); `page` wählt eine andere. */
export function areaReportToSvg(report: AreaReport, page = 0, o: ReportLayoutOptions = {}): string {
  const lay = layoutAreaReport(report, o);
  const prims = lay.pages[Math.min(page, lay.pages.length - 1)] ?? [];
  const body = prims
    .map((p) =>
      p.k === "line"
        ? `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="#111" stroke-width="${p.w}"/>`
        : `<text x="${p.x}" y="${p.y}" font-size="${(p.size * 0.3528).toFixed(3)}" font-family="Helvetica, Arial, sans-serif" font-weight="${p.bold ? 700 : 400}" text-anchor="${p.align === "right" ? "end" : "start"}" fill="#111">${esc(p.s)}</text>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lay.width}mm" height="${lay.height}mm" viewBox="0 0 ${lay.width} ${lay.height}">\n<rect width="${lay.width}" height="${lay.height}" fill="#fff"/>\n${body}\n</svg>\n`;
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
