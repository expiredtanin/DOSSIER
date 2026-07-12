// swisstopo / geo.admin-Anbindung für den Standort-Import.
//
//   • geocode(query)   — Ortssuche/Adresse → Kandidaten mit LV95-Koordinaten.
//                        Nutzt api3.geo.admin.ch SearchServer (sendet CORS `*`,
//                        daher Direktabruf; Proxy nur als Fallback).
//   • fetchBuildings() — Gebäude-GRUNDRISSE (vereinfachter 1:25'000-Kartografie-
//                        Layer, KEINE Höhe) für eine LV95-Box → Ringe in
//                        lokalen Modell-Metern. Nutzt den geo.admin
//                        MapServer/identify auf `ch.swisstopo.vec25-gebaeude`.
//                        Schneller "Vorschau"-Pfad; für echte Gebäudegeometrie
//                        (Wände+Dach, reale Höhe) s. `swissBuildings3d.ts`
//                        (STAC-API, entgegen einer früheren Annahme hier DOCH
//                        gut browser-tauglich — s. Recherche in PENDENZEN.md).
//
// Echtes Höhenraster (0.5 m/2 m): s. `swissAlti3d.ts::fetchTerrainXyz`
// (ersetzt die frühere `fetchTerrain`-profile.json-Näherung in dieser Datei).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, makeOrigin, wgs84ToLv95 } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import type { GeoFeature } from "./geoContext";
import { viaProxy } from "./geoContext";

const GEOADMIN = "https://api3.geo.admin.ch";

/** Ein Geocode-Treffer: Anzeigename + LV95-Position. */
export interface GeocodeCandidate {
  label: string;
  lv95: LV95;
}

/** Entfernt HTML-Auszeichnung aus den SearchServer-Labels. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Ortssuche (Adresse oder Ortsname) → bis zu `limit` Kandidaten mit
 * LV95-Koordinaten. Wirft bei Netzfehler.
 */
export async function geocode(
  query: string,
  limit = 8,
): Promise<GeocodeCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const url =
    `${GEOADMIN}/rest/services/api/SearchServer` +
    `?searchText=${encodeURIComponent(q)}` +
    `&type=locations&sr=2056&limit=${limit}`;

  const res = await fetch(viaProxy(url));
  if (!res.ok) throw new Error(`Geocode fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as {
    results?: {
      attrs?: {
        label?: string;
        y?: number; // Ostwert (E) in sr=2056
        x?: number; // Nordwert (N) in sr=2056
        lat?: number;
        lon?: number;
      };
    }[];
  };

  const out: GeocodeCandidate[] = [];
  for (const r of data.results ?? []) {
    const a = r.attrs;
    if (!a) continue;
    // Bei sr=2056 liefert der SearchServer y=E, x=N (LV95). Fallback: aus lat/lon.
    let e = a.y;
    let n = a.x;
    if (
      e == null ||
      n == null ||
      !Number.isFinite(e) ||
      !Number.isFinite(n) ||
      e < 2_000_000
    ) {
      if (a.lat != null && a.lon != null) {
        const p = wgs84ToLv95(a.lat, a.lon);
        e = p.e;
        n = p.n;
      }
    }
    if (e == null || n == null) continue;
    out.push({ label: stripHtml(a.label ?? q), lv95: { e, n } });
  }
  return out;
}

/** Esri-Polygon-Geometrie, wie sie identify bei returnGeometry=true liefert. */
interface EsriPolygon {
  rings?: number[][][]; // [ring][point][x,y] in LV95
}

/**
 * Gebäude-Grundrisse für ein Zentrum + Radius (Meter) laden.
 * Rückgabe: Ringe in LOKALEN Metern relativ zur (aus dem Zentrum abgeleiteten
 * oder übergebenen) Origin — plus die verwendete Origin, damit weitere Quellen
 * dasselbe Bezugssystem teilen.
 */
export async function fetchBuildings(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
): Promise<{ origin: GeoOrigin; features: GeoFeature[] }> {
  const origin = originIn ?? makeOrigin(center);
  const [eMin, nMin, eMax, nMax] = bboxAround(center, radius);
  const geom = `${eMin},${nMin},${eMax},${nMax}`;

  const url =
    `${GEOADMIN}/rest/services/api/MapServer/identify` +
    `?geometryType=esriGeometryEnvelope` +
    `&geometry=${geom}` +
    `&mapExtent=${geom}` +
    `&imageDisplay=500,500,96` +
    `&tolerance=0` +
    `&layers=all:ch.swisstopo.vec25-gebaeude` +
    `&returnGeometry=true&sr=2056&limit=200`;

  const res = await fetch(viaProxy(url));
  if (!res.ok) throw new Error(`Gebäude-Abruf fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as {
    results?: { geometry?: EsriPolygon }[];
  };

  const features: GeoFeature[] = [];
  for (const r of data.results ?? []) {
    const rings = r.geometry?.rings;
    if (!rings) continue;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const pts = ring.map(([e, n]) => ({ x: e - origin.e, y: n - origin.n }));
      features.push({ category: "building", pts, closed: true });
    }
  }
  return { origin, features };
}

// Das frühere `fetchTerrain` (grobe `profile.json`-Näherung, ~20 m Raster-
// weite über wenige Profillinien) ist durch `swissAlti3d.ts::fetchTerrainXyz`
// ersetzt (echtes swissALTI3D-Raster bei 0.5 m/2 m nativer Punktdichte, STAC-
// API, s. Referenz git.kgva.ch/karim/DOSSIER rhino/swisstopo.py).
