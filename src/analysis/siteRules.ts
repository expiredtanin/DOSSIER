// Baurecht der Parzelle ([63]): zulässige Grundfläche aus Grenzabständen und Baulinien, Prüfung
// des Modells (Grundfläche ausserhalb, Gesamthöhe).
//
//  • Grenzabstand: gesperrt ist alles, was näher als d_i an Kante i liegt (Puffer der Kante mit
//    gerundeten Enden) — so stimmen auch konkave Parzellen und einspringende Ecken.
//  • Baulinie: Halbebene auf der Seite des Parzellen-Schwerpunkts.
//  • Gebäude-Grundfläche: Wände aller Geschosse und freie Körper (ohne Abzugskörper). Vorsprünge
//    (Dachüberstand, Balkone) und ihre Sonderregeln zählen nicht.
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/site_rules.rs`), die Prüfung des Modells auf dem
// Projekt-Dokument; die Flächen-Hilfen (`allowedArea`, `multiPolygonArea`) nehmen flache Daten.

import type { Project, SiteRules, Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";
import { FlatReader, FlatWriter } from "../geometry/coreFlat";

/** Polygone mit Ringen: `[polygon][ring]`, Ring 0 aussen, weitere Löcher; Ringe offen. */
export type Area = Vec2[][][];

/** Fläche einer Mehrfach-Fläche (Löcher abgezogen). */
export function multiPolygonArea(a: Area): number {
  return core().site_multi_polygon_area(new FlatWriter().polygons(a).done());
}

/** Baurecht flach (`web/site_rules.rs`): Parzelle, Grenzabstand je Kante (Rohwert), Baulinien. */
function encodeRules(r: SiteRules): Float64Array {
  const parcel = Array.isArray(r.parcel) ? r.parcel : [];
  const w = new FlatWriter().ring(parcel).num(parcel.length);
  for (let i = 0; i < parcel.length; i++) w.num(r.setbacks?.[i] ?? r.defaultSetback);
  const lines = r.buildingLines ?? [];
  w.num(lines.length);
  for (const l of lines) w.num(l.a.x, l.a.y, l.b.x, l.b.y);
  return w.done();
}

/** Zulässige Grundfläche (leer bei ungültiger Parzelle). */
export function allowedArea(r: SiteRules): Area {
  return new FlatReader(core().site_allowed_area(encodeRules(r))).polygons();
}

/** Grundfläche des Gebäudes (Wände aller Geschosse, freie Körper ohne Abzugskörper). Rechnet der Kern. */
export function buildingFootprint(project: Project): Area {
  return documentFor(project).query<Area>("buildingFootprint");
}

/** Höchster Punkt des Modells über ±0.00 (Wände, freie Körper, Dächer); `null` ohne Bauteile. */
export function modelTop(project: Project): number | null {
  return documentFor(project).query<number | null>("modelTop");
}

export interface SiteCheck {
  parcelArea: number;
  allowed: Area;
  allowedArea: number;
  /** Gebäude-Grundfläche ausserhalb der zulässigen Fläche. */
  violations: Area;
  violationArea: number;
  maxTop: number | null;
  heightExceeded: boolean;
  /** [T6] Geländehöhen an der Fassade (gewachsen/gestaltet, Modellbezug); leer ohne Gelände. */
  facadeTerrain: { x: number; y: number; natural: number | null; designed: number | null }[];
  /** Tiefstes gewachsenes Terrain an der Fassade (massgebendes Terrain, vereinfacht). */
  terrainMin: number | null;
  /** Gesamthöhe über dem massgebenden Terrain; mit Gelände prüft die Höhe dagegen statt gegen ±0.00. */
  heightAboveTerrain: number | null;
}

/** Prüft das Modell gegen `project.siteRules`; `null` ohne (gültiges) Baurecht. Rechnung im Rust-Kern (`site_rules.rs`). */
export function checkSiteRules(project: Project): SiteCheck | null {
  if (!project.siteRules) return null;
  return documentFor(project).query<SiteCheck | null>("siteCheck");
}
