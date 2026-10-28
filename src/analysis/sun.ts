// Sonnenstand und Schattenwurf im Grundriss (Lageplan-Schattenstudie, [64]/[59]).
//
//  • `sunPosition`: Azimut (° von Nord im Uhrzeigersinn) und Höhe (°) nach dem vereinfachten
//    NOAA-Verfahren (Genauigkeit ~0.1°, ohne Refraktion).
//  • `shadowOfPrism`/`shadowPolygons`: Boden-Schatten (z = 0) von Wänden, freien Körpern und
//    Dächern als Vereinigung konvexer Hüllen (Prisma ∪ verschobenes Prisma). Modell: x = Ost,
//    y = Nord, Höhen über dem Geländenullpunkt (Meter).
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/sun.rs`), die Schatten auf dem Projekt-Dokument.

import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter, pointsOf } from "../geometry/coreFlat";
import type { Project, Vec2 } from "../model/types";
import { lv95ToWgs84 } from "../io/lv95";
import { documentFor } from "../core/document";

export interface SunPosition {
  /** Grad von Nord im Uhrzeigersinn (Ost = 90, Süd = 180). */
  azimuth: number;
  /** Grad über dem Horizont (negativ = Nacht). */
  elevation: number;
}

export function sunPosition(latDeg: number, lonDeg: number, when: Date): SunPosition {
  const r = core().sun_position(latDeg, lonDeg, when.getTime());
  return { azimuth: r[0], elevation: r[1] };
}

/** Breite/Länge des Projekts aus `geoAnchor` (LV95), sonst Zürich als Platzhalter. */
export function projectLatLon(project: Project): { lat: number; lon: number } {
  const a = project.geoAnchor;
  if (a) {
    const p = lv95ToWgs84(a.lv95.e, a.lv95.n);
    return { lat: p.lat, lon: p.lon };
  }
  return { lat: 47.3769, lon: 8.5417 };
}

/** Boden-Schatten eines Prismas `footprint` von `zBottom` bis `zTop` (leer bei Nacht). */
export function shadowOfPrism(footprint: Vec2[], zBottom: number, zTop: number, sun: SunPosition): Vec2[] {
  return pointsOf(core().sun_shadow_of_prism(new FlatWriter().pts(footprint).done(), zBottom, zTop, sun.azimuth, sun.elevation));
}

/** Ein Schatten-Polygon: `[0]` Aussenring, weitere Ringe sind Löcher (Höfe). Ringe offen (ohne Wiederholung des Startpunkts). */
export type ShadowPolygon = Vec2[][];

/**
 * Vereinigter Schatten aller Wände, Körper und Dächer (leer bei Nacht). Rechnet der Kern auf dem
 * Projekt-Dokument (`sun.rs`): Wände und freie Körper als Prismen, Dächer als Punktwolke.
 */
export function shadowPolygons(project: Project, sun: SunPosition): ShadowPolygon[] {
  return documentFor(project).query<ShadowPolygon[]>("shadows", [sun.azimuth, sun.elevation]);
}

/**
 * Zerlegt ein Polygon mit Löchern in lochfreie Teile gleicher Gesamtfläche (für Ausgaben, die
 * nur einfache Polygone füllen, z. B. das Plan-Primitiv); Rechnung im Rust-Kern (`sun.rs`).
 */
export function withoutHoles(poly: ShadowPolygon): Vec2[][] {
  if (!poly[0] || poly[0].length < 3) return [];
  if (poly.length === 1) return [poly[0]];
  return new FlatReader(core().sun_without_holes(new FlatWriter().polygons([poly]).done())).polygons().map((p) => p[0]);
}
