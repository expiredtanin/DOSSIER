// Fenster- und Türliste ([97]): eine Zeile je Öffnung. Gerechnet wird im Rust-Kern
// (`src-tauri/core/src/opening_schedule.rs`, Abfrage `openingSchedule`); hier nur die Beschriftung mit `t()`
// und der Berichtsaufbau, damit CSV, SVG und PDF dieselbe Quelle haben wie der Flächennachweis
// (`areaReport.ts`: `areaReportToCsv` / `areaReportToSvg` / `buildAreaReportPdf`).

import type { Project } from "../model/types";
import { t } from "../i18n";
import { documentFor } from "../core/document";
import type { AreaReport, Cell, ReportRow, ReportSection } from "./areaReport";

/** Eine Zeile der Fenster-/Türliste (Form wie `OpeningScheduleRow` im Kern). */
export interface OpeningScheduleRow {
  kind: "door" | "window";
  id: string;
  wallId: string;
  /** Nummer: eingetragene oder automatische. */
  mark: string;
  markAuto: boolean;
  typeName: string;
  floor: string;
  floorId: string;
  /** Räume links/rechts der Wandrichtung; `null` = kein Raum. */
  roomLeft: string | null;
  roomRight: string | null;
  /** Rohbaumass in Metern. */
  width: number;
  height: number;
  /** Lichtes Mass in Metern (Tür: abzüglich Rahmen). */
  clearWidth: number;
  clearHeight: number;
  sill: number;
  hinge: "start" | "end" | null;
  swing: "left" | "right" | null;
  dir: "in" | "out" | null;
  fireRating: string;
  soundClass: string;
  uValue: number | null;
  burglaryClass: string;
  /** `null` = nicht bestimmbar. */
  external: boolean | null;
  notes: string;
}

/** Alle Fenster und Türen des Projekts (Kern-Abfrage). */
export function openingSchedule(project: Project): OpeningScheduleRow[] {
  return documentFor(project).query<OpeningScheduleRow[]>("openingSchedule");
}

const num = (n: number | null, d: number): Cell => ({ n: n !== null && Number.isFinite(n) ? n : null, d });

/** „Wohnen ↔ Küche" bzw. der eine Raum; leer ohne Räume. */
export function roomsText(r: Pick<OpeningScheduleRow, "roomLeft" | "roomRight">): string {
  const rooms = [r.roomLeft, r.roomRight].filter((x): x is string => !!x);
  return rooms.join(" ↔ ");
}

export function externalText(e: boolean | null): string {
  return e === null ? "" : e ? t("openings.external") : t("openings.internal");
}

/** Aufschlag einer Tür als Text (Band, Aufschlagseite, Richtung). */
export function swingText(r: Pick<OpeningScheduleRow, "hinge" | "swing" | "dir">): string {
  if (!r.hinge || !r.swing || !r.dir) return "";
  return `${t(`openings.hinge.${r.hinge}`)} · ${t(`openings.swing.${r.swing}`)} · ${t(`openings.dir.${r.dir}`)}`;
}

function windowSection(rows: OpeningScheduleRow[]): ReportSection {
  return {
    heading: t("openings.windows"),
    columns: [t("openings.col.mark"), t("openings.col.type"), t("openings.col.floor"), t("openings.col.rooms"), t("openings.col.width"), t("openings.col.height"), t("openings.col.sill"), t("openings.col.sound"), t("openings.col.u"), t("openings.col.rc"), t("openings.col.ext"), t("openings.col.notes")],
    widths: [1.4, 2.4, 1.4, 3.2, 1.2, 1.2, 1.2, 1.6, 1.1, 1.1, 1.4, 3],
    rows: rows.map((r): ReportRow => ({ cells: [r.mark, r.typeName, r.floor, roomsText(r), num(r.width, 2), num(r.height, 2), num(r.sill, 2), r.soundClass, num(r.uValue, 2), r.burglaryClass, externalText(r.external), r.notes] })),
  };
}

function doorSection(rows: OpeningScheduleRow[]): ReportSection {
  return {
    heading: t("openings.doors"),
    columns: [t("openings.col.mark"), t("openings.col.type"), t("openings.col.floor"), t("openings.col.rooms"), t("openings.col.width"), t("openings.col.height"), t("openings.col.clearWidth"), t("openings.col.clearHeight"), t("openings.col.swing"), t("openings.col.fire"), t("openings.col.sound"), t("openings.col.u"), t("openings.col.rc"), t("openings.col.ext"), t("openings.col.notes")],
    widths: [1.4, 2.2, 1.3, 3, 1.1, 1.1, 1.2, 1.2, 2.6, 1.1, 1.5, 1, 1, 1.3, 2.6],
    rows: rows.map((r): ReportRow => ({ cells: [r.mark, r.typeName, r.floor, roomsText(r), num(r.width, 2), num(r.height, 2), num(r.clearWidth, 2), num(r.clearHeight, 2), swingText(r), r.fireRating, r.soundClass, num(r.uValue, 2), r.burglaryClass, externalText(r.external), r.notes] })),
  };
}

/** Bericht „Fenster- und Türliste": ein Abschnitt je Art (nur wenn vorhanden), Masse in Metern. */
export function buildOpeningReport(project: Project): AreaReport {
  const rows = openingSchedule(project);
  const sections: ReportSection[] = [];
  const windows = rows.filter((r) => r.kind === "window");
  const doors = rows.filter((r) => r.kind === "door");
  if (windows.length) sections.push(windowSection(windows));
  if (doors.length) sections.push(doorSection(doors));
  return { title: t("openings.title"), projectName: project.name ?? "", sections, notes: [t("openings.foot")] };
}
