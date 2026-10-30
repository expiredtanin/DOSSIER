// Tabellen auf Layout-Blättern ([111]): lebendige Listen des Modells (Fenster/Türen, Flächen SIA 416,
// Raumprogramm, Bauteile mit U-Wert) als Primitive in Papier-mm. Gerechnet wird im Kern
// (`src-tauri/core/src/sheet_table.rs`, Abfrage `sheetTables`); hier nur die Beschriftung mit `t()`, die Kern-
// Fassade und das Zeichnen ins jsPDF (Vektortext) — dieselben Primitive wie Blattansicht und DXF.

import type { jsPDF } from "jspdf";
import type { Layout, LayoutTable, LayoutTableSource, Project } from "../model/types";
import { t } from "../i18n";
import { documentFor } from "../core/document";

export type { LayoutTable, LayoutTableSource };

export type TablePrim =
  | { k: "text"; x: number; y: number; s: string; size: number; bold: boolean; italic: boolean; font: "sans" | "serif" | "mono"; align: "l" | "r" }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; w: number };

export interface TableOut {
  id: string;
  prims: TablePrim[];
  widthMm: number;
  /** Tatsächlich gezeichnete Höhe. */
  heightMm: number;
  total: number;
  shown: number;
  /** Zeilen, die weder hier noch in einer Folgetabelle Platz finden. */
  hidden: number;
}

export interface TableColumn {
  id: string;
  key: string;
  numeric: boolean;
  default: boolean;
}

interface Catalog {
  sources: Record<LayoutTableSource, TableColumn[]>;
  valueKeys: string[];
}

export const TABLE_SOURCES: readonly LayoutTableSource[] = ["openings", "areas", "rooms", "elements", "earthworks"];

export function tableSourceLabel(s: LayoutTableSource): string {
  return t(`sheetTable.source.${s}`);
}

let catalogCache: Catalog | null = null;

/** Spalten je Quelle (Kern-Katalog; ändert sich nie zur Laufzeit). */
export function tableCatalog(project: Project): Catalog {
  catalogCache ??= documentFor(project).query<Catalog>("sheetTableCatalog");
  return catalogCache;
}

/** Beschriftungen in der aktuellen Sprache für alle Spalten und Werttexte. */
export function tableLabels(project: Project): Record<string, string> {
  const cat = tableCatalog(project);
  const labels: Record<string, string> = {};
  for (const cols of Object.values(cat.sources)) for (const c of cols) labels[c.key] = t(c.key);
  for (const k of cat.valueKeys) labels[k] = t(k);
  return labels;
}

/** Alle Tabellen eines Blatts als Primitive (folgt dem Modell). */
export function sheetTables(project: Project, layoutId: string): TableOut[] {
  if (!(project.layouts ?? []).some((l) => l.id === layoutId && (l.tables ?? []).length > 0)) return [];
  return documentFor(project).query<TableOut[]>("sheetTables", [], JSON.stringify({ layoutId, labels: tableLabels(project) }));
}

/** Neue Tabelle mit sinnvollen Vorgaben (links, Breite nach Blatt, unter den vorhandenen). */
export function createTable(id: string, source: LayoutTableSource, sheetW: number, sheetH: number, existing: readonly LayoutTable[]): LayoutTable {
  const width = Math.max(40, Math.min(sheetW - 20, 180));
  const y = Math.min(10 + existing.length * 12, Math.max(10, sheetH - 40));
  return { id, source, xMm: 10, yMm: y, widthMm: width };
}

const PDF_FONT = { sans: "helvetica", serif: "times", mono: "courier" } as const;
const PT_PER_MM = 72 / 25.4;

/** Zeichnet die Tabellen eines Blatts als Vektor (Text + Linien) auf die aktuelle jsPDF-Seite. */
export function drawTablesPdf(doc: jsPDF, tables: readonly TableOut[]): void {
  doc.setTextColor(17, 17, 17);
  doc.setDrawColor(17, 17, 17);
  for (const tb of tables) {
    for (const p of tb.prims) {
      if (p.k === "line") {
        doc.setLineWidth(p.w);
        doc.line(p.x1, p.y1, p.x2, p.y2);
      } else {
        doc.setFont(PDF_FONT[p.font], p.bold && p.italic ? "bolditalic" : p.bold ? "bold" : p.italic ? "italic" : "normal");
        doc.setFontSize(p.size * PT_PER_MM);
        doc.text(p.s, p.x, p.y, { align: p.align === "r" ? "right" : "left" });
      }
    }
  }
}

export function layoutTables(layout: Layout): LayoutTable[] {
  return layout.tables ?? [];
}
