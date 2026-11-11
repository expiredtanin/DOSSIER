// Sonne für den 3D-Viewport ([64]): aus der Sonnenstudie des Projekts (Ort aus `geoAnchor`, Zeit
// `sunStudy.when`) Azimut/Höhe über den Kern (`sun.rs`) und der Schalter „Schatten im 3D"
// (`sunStudy.shadows3d`, ohne Wert wie „Schatten im Grundriss"). render3d (`web::set_sun`) rechnet
// daraus die Lichtrichtung und rendert die Schattentextur nur neu, wenn sich etwas ändert.

import { projectLatLon, sunPosition } from "../core";
import type { Project } from "../model/types";

export interface Sun3d {
  /** Sonnenstudie vorhanden und Schatten im 3D eingeschaltet. */
  active: boolean;
  /** Grad von Nord im Uhrzeigersinn. */
  azimuth: number;
  /** Grad über dem Horizont (≤ 0: Nacht, keine Schatten). */
  elevation: number;
}

/**
 * Sonne fürs 3D; `active=false` ohne Studie, mit ausgeschaltetem Schalter oder ungültiger Zeit, oder wenn die
 * Klasse `08 Schatten` ausgeblendet ist (`shadowsShown`, [180]).
 */
export function sun3dFor(project: Project, shadowsShown = true): Sun3d {
  const study = project.sunStudy;
  const off: Sun3d = { active: false, azimuth: 0, elevation: 0 };
  if (!shadowsShown || !study || !(study.shadows3d ?? study.show)) return off;
  const when = new Date(study.when);
  if (!Number.isFinite(when.getTime())) return off;
  const { lat, lon } = projectLatLon(project);
  const sun = sunPosition(lat, lon, when);
  if (!Number.isFinite(sun.azimuth) || !Number.isFinite(sun.elevation)) return off;
  return { active: true, azimuth: sun.azimuth, elevation: sun.elevation };
}

/** Schlüssel zum Vergleich (Effekt-Abhängigkeit): nur bei echter Änderung neu an die Engine. */
export function sun3dKey(s: Sun3d): string {
  return s.active ? `${s.azimuth.toFixed(3)}|${s.elevation.toFixed(3)}` : "off";
}
