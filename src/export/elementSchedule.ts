// Bauteilliste und U-Werte ([71], SIA 180 / EN ISO 6946): je Wand, Decke und Dach Typ, Fläche und U-Wert aus
// dem Schichtaufbau (λ je Bauteil). Gerechnet wird im Kern (`src-tauri/core/src/u_value.rs`, Abfragen
// `elementSchedule` und `uValue`); hier nur Beschriftung mit `t()` und das Berichtsmodell für CSV/SVG/PDF
// (wie die Fenster-/Türliste, `openingSchedule.ts`).

import type { Layer, Project } from "../model/types";
import { t } from "../i18n";
import { documentFor } from "../core/document";
import type { AreaReport, Cell, ReportRow } from "./areaReport";

export type ElementKind = "wall" | "ceiling" | "roof";

/** Eine Zeile der Bauteilliste (Form wie `ElementRow` im Kern). */
export interface ElementScheduleRow {
  kind: ElementKind;
  id: string;
  typeName: string;
  floor: string;
  floorId: string;
  /** m². */
  area: number;
  /** Aufbaudicke in Metern. */
  thickness: number;
  /** `null` = unvollständig (Schicht ohne λ) oder kein Aufbau. */
  u: number | null;
  complete: boolean;
  external: boolean | null;
}

/** Ergebnis der U-Wert-Rechnung (Form wie `UValue` im Kern). */
export interface UValueResult {
  /** Gesamtwiderstand m²K/W (Teilsumme, wenn unvollständig). */
  r: number;
  u: number | null;
  complete: boolean;
  /** Schichten ohne λ. */
  missing: number;
  /** Hinterlüftete Schicht: Aussenseite zählt nicht. */
  ventilated: boolean;
}

export function elementSchedule(project: Project): ElementScheduleRow[] {
  return documentFor(project).query<ElementScheduleRow[]>("elementSchedule");
}

/** U-Wert eines Typs (`typeId`) oder eines Schichtaufbaus (`layers`, z. B. beim Bearbeiten). `null` = unbekannter Typ. */
export function uValueOf(project: Project, kind: ElementKind, source: { typeId: string } | { layers: readonly Layer[] }): UValueResult | null {
  return documentFor(project).query<UValueResult | null>("uValue", [], JSON.stringify({ kind, ...source }));
}

/** „0.21" bzw. „–" (unvollständig). */
export function uValueText(u: UValueResult | null): string {
  return u && u.u !== null ? u.u.toFixed(2) : "–";
}

const num = (n: number | null, d: number): Cell => ({ n: n !== null && Number.isFinite(n) ? n : null, d });

function externalText(e: boolean | null): string {
  return e === null ? "" : e ? t("openings.external") : t("openings.internal");
}

/** Bericht „Bauteilliste": ein Abschnitt je Art (nur wenn vorhanden). */
export function buildElementReport(project: Project): AreaReport {
  const rows = elementSchedule(project);
  const sections = (["wall", "ceiling", "roof"] as const)
    .map((kind) => ({ kind, list: rows.filter((r) => r.kind === kind) }))
    .filter((g) => g.list.length > 0)
    .map((g) => ({
      heading: t(`elemSchedule.kind.${g.kind}`),
      columns: [t("elemSchedule.col.type"), t("openings.col.floor"), t("elemSchedule.col.area"), t("elemSchedule.col.thickness"), t("openings.col.u"), t("openings.col.ext")],
      widths: [4, 1.6, 1.4, 1.3, 1.3, 1.4],
      rows: g.list.map((r): ReportRow => ({ cells: [r.typeName, r.floor, num(r.area, 2), num(r.thickness * 100, 1), r.u === null ? t("elemSchedule.incomplete") : num(r.u, 2), externalText(r.external)] })),
    }));
  return { title: t("elemSchedule.title"), projectName: project.name ?? "", sections, notes: [t("elemSchedule.foot")] };
}
