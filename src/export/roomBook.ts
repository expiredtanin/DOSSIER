// [158] Raumbuch: Oberflächen je Raum (Boden, Wand, Decke), Nutzung, Bodenaufbau und die Mengen daraus.
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/room_book.rs`, Abfrage `roomBook`); hier nur die
// Beschriftung mit `t()` und der Berichtsaufbau, damit CSV, SVG und PDF dieselbe Quelle haben wie die
// Fenster-/Türliste (`openingSchedule.ts`). Die Blatt-Tabelle (Quelle `roomBook`) rechnet der Kern selbst.

import type { Project, RoomUsage } from "../model/types";
import { t } from "../i18n/translate";
import type { TranslationKey } from "../i18n/translate";
import { documentFor } from "../core/document";
import type { AreaReport, Cell, ReportSection } from "./areaReport";

/** Eine Zeile des Raumbuchs (Form wie `RoomBookRow` im Kern). */
export interface RoomBookRow {
  id: string;
  floor: string;
  floorId: string;
  number: string;
  name: string;
  /** Nettofläche (m²) = Boden- und Deckenfläche. */
  area: number;
  perimeter: number;
  /** Lichte Höhe (m) aus den Decken, sonst Geschosshöhe. */
  clearHeight: number;
  /** Nutzungs-Kennung, leer ohne Angabe. */
  usage: RoomUsage | "";
  wet: boolean;
  /** Anzeigetexte (Material-Name oder Freitext). */
  floorFinish: string;
  wallFinish: string;
  ceilingFinish: string;
  floorBuildUp: string;
  /** Wandfläche netto: Umfang × lichte Höhe − Öffnungen (m²). */
  wallArea: number;
  openingArea: number;
}

/** Menge einer Oberfläche je Material/Freitext. */
export interface FinishQty {
  surface: "floor" | "wall" | "ceiling";
  finish: string;
  area: number;
  rooms: number;
}

export interface RoomBook {
  rows: RoomBookRow[];
  quantities: FinishQty[];
}

/** Wählbare Nutzungen (Reihenfolge der Auswahl, wie `RoomUsage::ALL` im Kern). */
export const ROOM_USAGES: readonly RoomUsage[] = ["living", "sleeping", "kitchen", "dining", "bath", "wc", "shower", "laundry", "circulation", "technical", "storage", "office", "other"];

export function usageLabel(u: RoomUsage | ""): string {
  return u ? t(`roomBook.usage.${u}` as TranslationKey) : "";
}

/** Raumbuch des Projekts (Kern-Abfrage). */
export function roomBook(project: Project): RoomBook {
  return documentFor(project).query<RoomBook>("roomBook");
}

const num = (n: number, d: number): Cell => ({ n: Number.isFinite(n) ? n : null, d });

function roomSection(rows: RoomBookRow[]): ReportSection {
  return {
    heading: t("roomBook.title"),
    columns: [
      t("openings.col.floor"),
      t("roomBook.col.number"),
      t("sheetTable.col.room"),
      t("sheetTable.col.area"),
      t("roomBook.col.usage"),
      t("roomBook.col.floorFinish"),
      t("roomBook.col.wallFinish"),
      t("roomBook.col.ceilingFinish"),
      t("roomBook.col.buildUp"),
      t("roomBook.col.clearHeight"),
      t("roomBook.col.wallArea"),
    ],
    widths: [1.2, 1, 2.4, 1.2, 1.6, 2.4, 2.4, 2.4, 3, 1.2, 1.3],
    rows: rows.map((r) => ({
      cells: [r.floor, r.number, r.name, num(r.area, 2), usageLabel(r.usage), r.floorFinish, r.wallFinish, r.ceilingFinish, r.floorBuildUp, num(r.clearHeight, 2), num(r.wallArea, 2)],
    })),
  };
}

function quantitySection(qs: FinishQty[]): ReportSection {
  return {
    heading: t("roomBook.quantities"),
    columns: [t("roomBook.col.surface"), t("roomBook.col.finish"), t("roomBook.col.rooms"), t("sheetTable.col.area")],
    widths: [1.6, 4, 1.2, 1.4],
    rows: qs.map((q) => ({ cells: [t(`roomBook.surface.${q.surface}`), q.finish, num(q.rooms, 0), num(q.area, 2)] })),
  };
}

/** Bericht „Raumbuch": Räume und (falls Oberflächen angegeben) die Mengen je Material. */
export function buildRoomBookReport(project: Project): AreaReport {
  const b = roomBook(project);
  const sections: ReportSection[] = [];
  if (b.rows.length) sections.push(roomSection(b.rows));
  if (b.quantities.length) sections.push(quantitySection(b.quantities));
  return { title: t("roomBook.title"), projectName: project.name ?? "", sections, notes: [t("roomBook.foot")] };
}
