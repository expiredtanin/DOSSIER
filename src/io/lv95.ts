// LV95 ↔ WGS84 Koordinaten-Transformation + Ursprungs-Verschiebung.
//
// Schweizer Landeskoordinaten (LV95 / EPSG:2056) liegen im Millionenbereich
// (Ost ~2'600'000 m, Nord ~1'200'000 m). Für die numerische Genauigkeit im
// CAD (float32 in three.js!) verschieben wir importierte Geometrie in die Nähe
// des Modell-Ursprungs (0,0). Der einmal berechnete Offset wird mitgeführt, so
// dass ALLE Objekte eines Imports dieselbe Verschiebung teilen und korrekt
// zueinander liegen.
//
// Die Umrechnung LV95↔WGS84 verwendet die von swisstopo publizierten
// Näherungsformeln („Bezugsrahmenwechsel und Kartenprojektionen", genauigkeit
// im Meter-Bereich, für Kontext-Geometrie völlig ausreichend). Referenz-
// Rundlauf (siehe Unit-Check im Report) < 1 m.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter
// bzw. Dezimalgrad.

/** Geographische Koordinate (WGS84), Dezimalgrad. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Schweizer Landeskoordinate LV95 (EPSG:2056), Meter. */
export interface LV95 {
  /** Ostwert (E), ~2'600'000. */
  e: number;
  /** Nordwert (N), ~1'200'000. */
  n: number;
}

/**
 * WGS84 → LV95 (approximativ, swisstopo-Näherungsformeln).
 * Eingabe Dezimalgrad, Ausgabe Meter (E/N).
 */
export function wgs84ToLv95(lat: number, lon: number): LV95 {
  // Breite/Länge in Sexagesimalsekunden.
  const phi = lat * 3600;
  const lam = lon * 3600;
  // Hilfsgrößen relativ zum Bezugspunkt Bern (46°57'08.66" N, 7°26'22.50" E).
  const p = (phi - 169028.66) / 10000;
  const l = (lam - 26782.5) / 10000;
  const p2 = p * p;
  const l2 = l * l;

  // Ostwert (Y in LV03 + 2'000'000 für LV95).
  const y =
    2600072.37 +
    211455.93 * l -
    10938.51 * l * p -
    0.36 * l * p2 -
    44.54 * l * l2;

  // Nordwert (X in LV03 + 1'000'000 für LV95).
  const x =
    1200147.07 +
    308807.95 * p +
    3745.25 * l2 +
    76.63 * p2 -
    194.56 * l2 * p +
    119.79 * p * p2;

  return { e: y, n: x };
}

/**
 * LV95 → WGS84 (approximativ, swisstopo-Näherungsformeln).
 * Eingabe Meter (E/N), Ausgabe Dezimalgrad.
 */
export function lv95ToWgs84(e: number, n: number): LatLon {
  // Relativ zum Projektions-Ursprung, in 1'000'000-Einheiten.
  const y = (e - 2600000) / 1000000;
  const x = (n - 1200000) / 1000000;
  const y2 = y * y;
  const x2 = x * x;

  // Breite/Länge in 10'000"-Einheiten (Näherungspolynome).
  const lam =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * x2 -
    0.0436 * y * y2;

  const phi =
    16.9023892 +
    3.238272 * x -
    0.270978 * y2 -
    0.002528 * x2 -
    0.0447 * y2 * x -
    0.014 * x * x2;

  // Zurück in Dezimalgrad (Faktor 100/36).
  return {
    lat: (phi * 100) / 36,
    lon: (lam * 100) / 36,
  };
}

/**
 * Eine Ursprungs-Verschiebung: der LV95-Punkt, der im Modell auf (0,0)
 * abgebildet wird. Alle importierten Objekte eines Imports teilen dieselbe
 * Origin, damit sie zueinander lagerichtig bleiben.
 */
export interface GeoOrigin {
  e: number;
  n: number;
}

/** Erzeugt eine Origin aus einem LV95-Zentrum. */
export function makeOrigin(center: LV95): GeoOrigin {
  return { e: center.e, n: center.n };
}

/**
 * LV95 → lokale Modell-Meter (Ost→X, Nord→Y) relativ zur Origin. LV95 ist bereits
 * metrisch und (nahezu) nordorientiert, daher genügt eine reine Translation.
 */
export function lv95ToLocal(pt: LV95, origin: GeoOrigin): { x: number; y: number } {
  return { x: pt.e - origin.e, y: pt.n - origin.n };
}

/**
 * WGS84 → lokale Modell-Meter (über LV95 und die Origin). Praktisch für
 * OSM-Punkte (lon/lat), die zuerst nach LV95 projiziert und dann verschoben
 * werden — so teilen OSM- und swisstopo-Import exakt dasselbe Bezugssystem.
 */
export function wgs84ToLocal(
  lat: number,
  lon: number,
  origin: GeoOrigin,
): { x: number; y: number } {
  return lv95ToLocal(wgs84ToLv95(lat, lon), origin);
}

/**
 * Baut eine LV95-Bounding-Box (quadratisch) um ein Zentrum mit gegebenem Radius
 * (Meter). Reihenfolge [eMin, nMin, eMax, nMax].
 */
export function bboxAround(
  center: LV95,
  radius: number,
): [number, number, number, number] {
  return [
    center.e - radius,
    center.n - radius,
    center.e + radius,
    center.n + radius,
  ];
}

/**
 * Wandelt eine LV95-Bounding-Box in eine WGS84-Box (für Overpass:
 * [south, west, north, east]). Nutzt die vier Ecken und nimmt die Extremwerte,
 * damit die leichte Nord-Rotation der LV95-Projektion abgedeckt ist.
 */
export function lv95BboxToWgs84(
  bbox: [number, number, number, number],
): { south: number; west: number; north: number; east: number } {
  const [eMin, nMin, eMax, nMax] = bbox;
  const corners: LatLon[] = [
    lv95ToWgs84(eMin, nMin),
    lv95ToWgs84(eMax, nMin),
    lv95ToWgs84(eMin, nMax),
    lv95ToWgs84(eMax, nMax),
  ];
  return {
    south: Math.min(...corners.map((c) => c.lat)),
    west: Math.min(...corners.map((c) => c.lon)),
    north: Math.max(...corners.map((c) => c.lat)),
    east: Math.max(...corners.map((c) => c.lon)),
  };
}
