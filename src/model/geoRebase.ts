// Ursprungs-Verschiebung des GESAMTEN Projekts (Neuer Bezugspunkt) — reine,
// verlustfreie Translation aller Modell-Koordinaten um einen festen Vektor
// (dx,dy). Genutzt, um nach einem Kataster-/3D-Import (der weit weg vom
// Modell-Ursprung landen kann, s. `Project.geoAnchor`) einen neuen, praktischen
// Bezugspunkt zu setzen: die komplette Zeichnung wandert relativ zueinander
// unverändert, nur ihre absoluten Koordinaten verschieben sich. `geoAnchor`
// (falls gesetzt) wandert MIT, sodass der LV95-Bezug exakt erhalten bleibt —
// beim Export ist die Verschiebung damit jederzeit rekonstruierbar.
//
// Bewusst NUR Translation (keine Rotation): mehrere Felder im Modell sind an
// die Achsen gebunden (z. B. `Roof.ridgeAxis: "x"|"y"`) und mehrere Winkel-Felder
// (Column.rotation, Text-/Bild-Rotation, Tür-Schwenk) müssten bei einer Drehung
// mitgeführt werden — eine Rotation ist ein eigener, grösserer Schritt.
//
// Die Rechnung liegt im Rust-Kern ([K4] S3, `src-tauri/core/src/geo_translate.rs`, Wurzel-Abfragen
// `translatePatch`/`translateOps`); hier bleiben die Fassaden und der Ursprung aus dem Geo-Anker.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import type { Project } from "./types";

/**
 * Verschiebt SÄMTLICHE Modell-Koordinaten eines Projekts um den festen Vektor
 * (dx,dy) — Wände, Decken, Dächer, Öffnungen-Host (folgt automatisch der Wand),
 * Treppen, Räume, Stützen, Extrusionen, freie 2D-Geometrie, Kontext-Schicht
 * (Import/Terrain/Konturen), Schnitt-/Ansichtslinien sowie den Geo-Anker
 * (`geoAnchor.model`, damit der LV95-Bezug exakt erhalten bleibt). Richtungs-
 * Vektoren (z. B. `Stair.dir`) und Winkel-Felder bleiben unangetastet — eine
 * reine Translation ändert keine Orientierung. Unveränderte Teile behalten ihre Identität;
 * (0,0) liefert das Projekt selbst.
 */
export function translateProject(project: Project, dx: number, dy: number): Project {
  if (dx === 0 && dy === 0) return project;
  const patch = documentFor(project).queryRoot<Partial<Project>>("translatePatch", JSON.stringify([dx, dy]));
  return { ...project, ...patch };
}

/**
 * Ops für {@link translateProject}: je geändertem Element ein `replace` (Reihenfolge und Identität
 * unveränderter Elemente bleiben), `geoAnchor` als Feld. Das Ergebnis von `applyOps` ist gleich
 * `translateProject(project, dx, dy)`.
 */
export function translateOps(project: Project, dx: number, dy: number): CoreOp[] {
  if (dx === 0 && dy === 0) return [];
  return documentFor(project).queryRoot<CoreOp[]>("translateOps", JSON.stringify([dx, dy]));
}

/**
 * Der LV95-Ursprung eines Projekts: die reale Landeskoordinate, die auf den
 * Modell-Nullpunkt (0,0) abgebildet wird. Aus `geoAnchor` abgeleitet
 * (`origin = lv95 − model`), oder `null`, wenn KEIN Standort-Bezug existiert.
 */
export function projectGeoOrigin(project: Project): { e: number; n: number } | null {
  const a = project.geoAnchor;
  if (!a) return null;
  return { e: a.lv95.e - a.model.x, n: a.lv95.n - a.model.y };
}

/**
 * Kopie des Projekts mit SÄMTLICHER Geometrie auf die REALEN Weltkoordinaten
 * (LV95) verschoben — für georeferenzierte MODELL-Exporte (IFC/DXF): das Modell
 * wird lokal nahe (0,0) bearbeitet, der Export schreibt aber die wahren
 * Landeskoordinaten, damit die Datei in anderer CAD-/BIM-Software lagerichtig
 * sitzt. Ohne `geoAnchor` (kein Bezug) bleibt das Projekt unverändert (Identität).
 * NICHT für Papier-/Layout-Exporte (die bleiben in lokalen Koordinaten).
 */
export function projectToWorldCoords(project: Project): Project {
  const origin = projectGeoOrigin(project);
  if (!origin) return project;
  return translateProject(project, origin.e, origin.n);
}
