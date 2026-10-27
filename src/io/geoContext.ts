// Gemeinsame Typen + Helfer für den Standort-Import (swisstopo & OSM).
//
// Beide Quellen liefern am Ende dasselbe: geschlossene/offene Polylinien in
// LOKALEN Modell-Metern (bereits um die Origin verschoben, siehe lv95.ts),
// kategorisiert nach Art (Gebäude/Strasse/Wasser/Grün/Parkplatz/Bahn/Wald). Die UI wandelt diese in
// `ContourSet`-Kontext-Objekte pro Kategorie um und legt sie in `project.context`.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { allowHost } from "../net/net";
import Delaunator from "delaunator";
import type { ContextObject, Contour, ImportedMesh } from "../model/types";
import { GEO_CATEGORY_DEFS } from "../model/contextCategories";

/** Fachliche Kategorie einer importierten Kontext-Linie. */
export type GeoCategory =
  | "building"
  | "road"
  | "water"
  | "green"
  | "parking"
  | "railway"
  | "forest";

/** Ein importiertes Polygon/Polylinie in lokalen Modell-Metern. */
export interface GeoFeature {
  category: GeoCategory;
  /** Stützpunkte in lokalen Metern (x=Ost, y=Nord). */
  pts: { x: number; y: number }[];
  /** Geschlossener Ring (Gebäude/Wasser/Grün) vs. offene Linie (Strasse). */
  closed: boolean;
  /**
   * Gebäudehöhe in Metern (nur `building`). Quelle: OSM-Tags (height /
   * building:levels). Fehlt sie, greift {@link DEFAULT_BUILDING_HEIGHT} bei der
   * Extrusion.
   */
  height?: number;
}

/** Default-Gebäudehöhe (m), wenn keine Höhe aus der Quelle vorliegt. */
export const DEFAULT_BUILDING_HEIGHT = 9;

/** Menschlicher Layer-/Objektname je Kategorie (deutsch, für die Kontext-Liste). */
const CATEGORY_LABEL: Record<GeoCategory, string> = {
  building: "Gebäude",
  road: "Strassen",
  water: "Gewässer",
  green: "Grünflächen",
  parking: "Parkplätze",
  railway: "Bahn",
  forest: "Wald",
};

/** Layer-Kennung (englischer Identifier) je Kategorie — für spätere Zuordnung. */
const CATEGORY_LAYER: Record<GeoCategory, string> = {
  building: "context-buildings",
  road: "context-roads",
  water: "context-water",
  green: "context-green",
  parking: "context-parking",
  railway: "context-railway",
  forest: "context-forest",
};

/** Erzeugt eine (kollisionsarme) ID für ein neues Kontext-Objekt. */
function contextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Wandelt importierte Features in `ContextObject`s (je Kategorie EIN
 * ContourSet). Die Konturen liegen auf z=0 (Grundriss-Kontext); geschlossene
 * Ringe (Gebäude/Wasser/Grün) werden als geschlossene Konturen markiert,
 * Strassen als offene Linienzüge. Der Aufrufer legt das Ergebnis über
 * `onAddContextObjects` in `project.context` ab.
 */
export function featuresToContextObjects(
  features: GeoFeature[],
  sourceLabel: string,
): ContextObject[] {
  const byCat = new Map<GeoCategory, Contour[]>();
  for (const f of features) {
    if (f.pts.length < 2) continue;
    const list = byCat.get(f.category) ?? [];
    list.push({
      z: 0,
      pts: f.pts.map((p) => ({ x: p.x, y: p.y })),
      closed: f.closed,
      layer: CATEGORY_LAYER[f.category],
    });
    byCat.set(f.category, list);
  }

  const objs: ContextObject[] = [];
  for (const [cat, contours] of byCat) {
    if (contours.length === 0) continue;
    objs.push({
      id: contextId(`geo-${cat}`),
      type: "contourSet",
      name: `${CATEGORY_LABEL[cat]} (${sourceLabel})`,
      layer: CATEGORY_LAYER[cat],
      categoryCode: GEO_CATEGORY_DEFS[cat].code,
      contours,
    });
  }

  // Gebäude zusätzlich als extrudierte Volumen (Footprint × Höhe) für die
  // 3D-Ansicht. Der flache Footprint bleibt als contourSet erhalten (2D-Plan),
  // das Volumen kommt als importedMesh dazu — beide teilen dieselbe Lage.
  const buildingMesh = buildingsToMesh(
    features.filter((f) => f.category === "building"),
    sourceLabel,
  );
  if (buildingMesh) objs.push(buildingMesh);

  return objs;
}

/**
 * Baut aus allen Gebäude-Features EIN extrudiertes Volumen-Mesh (roh
 * positions/indices in Modell-Metern, three-frei). Jeder geschlossene Footprint
 * wird von z=0 bis z=Höhe hochgezogen (Wände + Deckel + Boden). Ohne Höhe greift
 * {@link DEFAULT_BUILDING_HEIGHT}. Liefert `null`, wenn nichts Brauchbares dabei
 * ist.
 */
export function buildingsToMesh(
  buildings: GeoFeature[],
  sourceLabel: string,
): ImportedMesh | null {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const b of buildings) {
    if (!b.closed) continue;
    const h = Number.isFinite(b.height) && (b.height as number) > 0
      ? (b.height as number)
      : DEFAULT_BUILDING_HEIGHT;
    extrudeRing(b.pts, h, positions, indices);
  }
  if (positions.length < 9 || indices.length < 3) return null;
  return {
    id: contextId("geo-building3d"),
    type: "importedMesh",
    name: `Gebäude 3D (${sourceLabel})`,
    layer: CATEGORY_LAYER.building,
    categoryCode: GEO_CATEGORY_DEFS.building.code,
    positions,
    indices,
  };
}

/**
 * Extrudiert einen geschlossenen (x,y)-Ring zu einem Prisma [0..height] und
 * hängt Vertices/Indizes an die gemeinsamen Arrays an. Erzeugt Seitenwände,
 * Deckel und Boden. Winding ist unkritisch (Kontext-Material rendert doppel-
 * seitig). Entartete Ringe (< 3 Punkte oder ~0 Fläche) werden übersprungen.
 */
function extrudeRing(
  ringIn: { x: number; y: number }[],
  height: number,
  positions: number[],
  indices: number[],
): void {
  // Schließenden Doppelpunkt entfernen.
  const ring = ringIn.slice();
  if (
    ring.length > 1 &&
    Math.abs(ring[0].x - ring[ring.length - 1].x) < 1e-6 &&
    Math.abs(ring[0].y - ring[ring.length - 1].y) < 1e-6
  ) {
    ring.pop();
  }
  const n = ring.length;
  if (n < 3) return;
  if (!ringArea(ring)) return;

  const base = positions.length / 3;
  // n Boden-Vertices (z=0), dann n Deckel-Vertices (z=height).
  for (const p of ring) positions.push(p.x, p.y, 0);
  for (const p of ring) positions.push(p.x, p.y, height);

  // Seitenwände: je Kante ein Quad → 2 Dreiecke.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = base + i;
    const b1 = base + j;
    const t0 = base + n + i;
    const t1 = base + n + j;
    indices.push(b0, b1, t1, b0, t1, t0);
  }

  // Deckel + Boden über eine Polygon-Triangulation des Rings.
  const tris = triangulateRing(ring);
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    // Deckel (obere Vertex-Reihe).
    indices.push(base + n + a, base + n + b, base + n + c);
    // Boden (untere Reihe, umgekehrte Reihenfolge).
    indices.push(base + a, base + c, base + b);
  }
}

/** Doppelte Ringfläche > EPS? (Filtert entartete/kollineare Footprints.) */
function ringArea(ring: { x: number; y: number }[]): boolean {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a2) > 1e-6;
}

/**
 * Trianguliert einen einfachen (evtl. konkaven) Ring. Strategie: Delaunay über
 * die (x,y)-Punkte, dann nur die Dreiecke behalten, deren Schwerpunkt IM Polygon
 * liegt (Point-in-Polygon) — so werden konkave Einbuchtungen respektiert, ohne
 * eine externe Earcut-Abhängigkeit. Fällt bei Bedarf auf eine Fächer-
 * Triangulation zurück. Rückgabe: Dreiecks-Indizes in `ring`.
 */
function triangulateRing(ring: { x: number; y: number }[]): number[] {
  const n = ring.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const coords = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    coords[i * 2] = ring[i].x;
    coords[i * 2 + 1] = ring[i].y;
  }
  let tri: Uint32Array;
  try {
    tri = new Delaunator(coords).triangles;
  } catch {
    return fanTriangulate(n);
  }
  const out: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const cx = (ring[a].x + ring[b].x + ring[c].x) / 3;
    const cy = (ring[a].y + ring[b].y + ring[c].y) / 3;
    if (pointInRing(cx, cy, ring)) out.push(a, b, c);
  }
  return out.length >= 3 ? out : fanTriangulate(n);
}

/** Fächer-Triangulation ab Vertex 0 (Fallback für konvexe/sternförmige Ringe). */
function fanTriangulate(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < n - 1; i++) out.push(0, i, i + 1);
  return out;
}

/** Point-in-Polygon (Ray-Casting) in der (x,y)-Ebene. */
function pointInRing(
  x: number,
  y: number,
  ring: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const hit =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/**
 * Basis-URL des optionalen Geo-Proxys (openbureau-core `/geoproxy`). Wird für
 * Overpass zwingend benutzt (CORS unzuverlässig); für geo.admin nur als
 * Fallback. Konfiguration über `VITE_GEO_PROXY` (z. B. "/geoproxy" bei
 * gleichem Origin oder eine absolute URL auf den API-Server). Leer = kein Proxy.
 */
export function geoProxyBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return (env?.VITE_GEO_PROXY ?? "").replace(/\/$/, "");
}

/**
 * Verpackt eine absolute Upstream-URL für den Geo-Proxy. Ohne konfigurierten
 * Proxy wird die URL unverändert zurückgegeben (Direktabruf).
 */
export function viaProxy(url: string): string {
  const base = geoProxyBase();
  if (base) allowHost(base);
  return base ? `${base}?u=${encodeURIComponent(url)}` : url;
}
