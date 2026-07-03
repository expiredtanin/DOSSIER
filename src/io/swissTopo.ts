// swisstopo / geo.admin-Anbindung für den Standort-Import.
//
//   • geocode(query)   — Ortssuche/Adresse → Kandidaten mit LV95-Koordinaten.
//                        Nutzt api3.geo.admin.ch SearchServer (sendet CORS `*`,
//                        daher Direktabruf; Proxy nur als Fallback).
//   • fetchBuildings() — Gebäude-GRUNDRISSE für eine LV95-Box → Ringe in
//                        lokalen Modell-Metern. Nutzt den geo.admin
//                        MapServer/identify auf `ch.swisstopo.vec25-gebaeude`
//                        (liefert Polygon-`rings` in LV95, aus dem Browser
//                        abrufbar). swissBUILDINGS3D-Kachel-Downloads (STAC)
//                        sind für einen Live-Box-Query im Browser zu schwer und
//                        werden bewusst NICHT verwendet.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, makeOrigin, wgs84ToLv95 } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import type { GeoFeature } from "./geoContext";
import { viaProxy } from "./geoContext";
import type { TerrainGrid } from "../model/terrain";

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

/** Ein Punkt aus dem geo.admin-Höhenprofil (profile.json, sr=2056). */
interface ProfilePoint {
  dist: number;
  easting: number;
  northing: number;
  alts?: { DTM2?: number; DTM25?: number; COMB?: number };
}

/**
 * Gelände-Höhenraster (swissALTI3D-DTM) für Zentrum + Radius laden.
 *
 * Statt schwerer swissALTI3D-Kachel-Downloads (STAC) nutzt der Port den
 * CORS-fähigen geo.admin `profile.json`-Dienst: pro Rasterzeile EIN Request
 * liefert die Höhen entlang einer Ost-West-Linie (nb_points Stützstellen). So
 * entsteht ein reguläres N×N-Höhenraster mit wenigen Requests, direkt aus dem
 * Browser.
 *
 * Die Höhen werden auf den Wert am Zentrum bezogen (z=0 im Zentrum), damit das
 * Gelände beim Modell-Ursprung liegt und lagerichtig zu den Gebäuden (Basis
 * z=0) sitzt. Rückgabe: das Raster in lokalen Metern + die verwendete Origin.
 */
export async function fetchTerrain(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
): Promise<{ origin: GeoOrigin; grid: TerrainGrid | null }> {
  const origin = originIn ?? makeOrigin(center);
  const [eMin, nMin, eMax] = bboxAround(center, radius);
  const span = 2 * radius;
  // Ziel-Rasterweite ~20 m, aber N in [6, 24] begrenzen (Request-Zahl zähmen).
  const n = Math.max(6, Math.min(24, Math.round(span / 20) + 1));

  // Achsen (LV95) + lokale Achsen.
  const eAxis: number[] = [];
  const nAxis: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = eMin + (span * i) / (n - 1);
    const nn = nMin + (span * i) / (n - 1);
    eAxis.push(e);
    nAxis.push(nn);
    xs.push(e - origin.e);
    ys.push(nn - origin.n);
  }

  // Eine Rasterzeile (konstantes N) via profile.json abrufen → Höhen je Spalte.
  const fetchRow = async (north: number): Promise<(number | null)[]> => {
    const geom = JSON.stringify({
      type: "LineString",
      coordinates: [
        [eMin, north],
        [eMax, north],
      ],
    });
    const url =
      `${GEOADMIN}/rest/services/profile.json` +
      `?geom=${encodeURIComponent(geom)}` +
      `&sr=2056&nb_points=${n}&distinct_points=true&offset=0`;
    try {
      const res = await fetch(viaProxy(url));
      if (!res.ok) return new Array(n).fill(null);
      const pts = (await res.json()) as ProfilePoint[];
      const row: (number | null)[] = new Array(n).fill(null);
      // Die Punkte kommen nach Distanz sortiert (West→Ost) — direkt Spalte i.
      pts.forEach((p, i) => {
        if (i >= n) return;
        const z = p.alts?.DTM2 ?? p.alts?.COMB ?? p.alts?.DTM25;
        row[i] = Number.isFinite(z as number) ? (z as number) : null;
      });
      return row;
    } catch {
      return new Array(n).fill(null);
    }
  };

  // Alle Zeilen parallel (n ≤ 24 Requests).
  const rows = await Promise.all(nAxis.map((north) => fetchRow(north)));

  // Höhen-Nullpunkt: Wert am Rasterzentrum (fällt der aus, Mittel aller Werte).
  const mid = Math.floor(n / 2);
  let zRef = rows[mid]?.[mid] ?? null;
  if (zRef == null || !Number.isFinite(zRef)) {
    let sum = 0;
    let cnt = 0;
    for (const r of rows)
      for (const v of r)
        if (v != null && Number.isFinite(v)) {
          sum += v;
          cnt++;
        }
    zRef = cnt > 0 ? sum / cnt : null;
  }
  if (zRef == null) return { origin, grid: null };

  // Höhen relativ zum Zentrum (z=0 im Zentrum).
  const z: (number | null)[][] = rows.map((r) =>
    r.map((v) => (v == null ? null : v - (zRef as number))),
  );
  return { origin, grid: { xs, ys, z, name: "Gelände (swisstopo)" } };
}
