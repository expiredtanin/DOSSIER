// Gemeinsame Typen + Helfer für den Standort-Import (swisstopo & OSM).
//
// Beide Quellen liefern am Ende dasselbe: geschlossene/offene Polylinien in
// LOKALEN Modell-Metern (bereits um die Origin verschoben, siehe lv95.ts),
// kategorisiert nach Art (Gebäude/Strasse/Wasser/Grün/Parkplatz/Bahn/Wald). Die UI wandelt diese in
// einzelne 2D-Polylinien (`drawing2d`) auf der Klasse ihrer Kategorie um ([181]: normale, unabhängige Elemente);
// Gebäude-Volumen kommen als Netz-Element in `project.context`.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { allowHost } from "../net/net";
import { core } from "../engine/coreWasm";
import type { ContextObject, Drawing2D, ImportedMesh } from "../model/types";
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

/** Id-Präfix des extrudierten Gebäudenetzes eines Geo-Imports ([227]: wird beim Hinzufügen aufs Gelände gesetzt). */
const GEO_BUILDING_MESH_PREFIX = "geo-building3d";

/** Ist `o` das Gebäudenetz eines Geo-Imports (Kataster, swisstopo, OSM; {@link buildingsToMesh})? */
export function isGeoBuildingMesh(o: ContextObject): boolean {
  return o.type === "importedMesh" && o.id.startsWith(GEO_BUILDING_MESH_PREFIX);
}

/** Erzeugt eine (kollisionsarme) ID für ein neues Kontext-Objekt. */
function contextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** Importierte Linie als freies 2D-Element, noch ohne Zeichnungsebene (`levelId` setzt der Aufrufer). */
export type ImportedLine = Omit<Drawing2D, "levelId">;

/** Ergebnis von {@link featuresToImport}: Kontext-Elemente (Volumen) und einzelne 2D-Linien. */
export interface GeoImport {
  objects: ContextObject[];
  lines: ImportedLine[];
}

/**
 * Wandelt importierte Features in normale, unabhängige Elemente ([181]): jede Linie/jeder Ring wird EINE
 * 2D-Polylinie (`drawing2d`) auf der Klasse ihrer Kategorie (Stift aus der Klasse), einzeln wähl-, verschieb-,
 * lösch- und editierbar; Gebäude zusätzlich als extrudiertes Volumen (`importedMesh`) für 3D. Geschlossene
 * Ringe (Gebäude/Wasser/Grün) sind geschlossene Polylinien, Strassen offene. Der Aufrufer ergänzt die
 * Zeichnungsebene und legt das Ergebnis über `onImport` ab.
 */
export function featuresToImport(features: GeoFeature[], sourceLabel: string): GeoImport {
  const lines: ImportedLine[] = [];
  for (const f of features) {
    if (f.pts.length < 2) continue;
    lines.push({
      id: contextId(`geo-${f.category}`),
      type: "drawing2d",
      categoryCode: GEO_CATEGORY_DEFS[f.category].code,
      geom: {
        shape: "polyline",
        pts: f.pts.map((p) => ({ x: p.x, y: p.y })),
        closed: f.closed,
      },
    });
  }

  // Gebäude zusätzlich als extrudierte Volumen (Footprint × Höhe) für die 3D-Ansicht; die flachen
  // Umrisse sind die Linien oben, das Volumen ein eigenes Netz-Element mit derselben Lage.
  const objects: ContextObject[] = [];
  const buildingMesh = buildingsToMesh(
    features.filter((f) => f.category === "building"),
    sourceLabel,
  );
  if (buildingMesh) objects.push(buildingMesh);
  return { objects, lines };
}

/**
 * Baut aus allen Gebäude-Features EIN extrudiertes Volumen-Mesh (roh
 * positions/indices in Modell-Metern). Jeder geschlossene Footprint wird von
 * z=0 bis z=Höhe hochgezogen (Wände + Deckel + Boden; Triangulation und
 * Extrusion rechnet der Kern, `core/src/geo_mesh.rs`). Ohne Höhe greift
 * {@link DEFAULT_BUILDING_HEIGHT}. Liefert `null`, wenn nichts Brauchbares dabei ist.
 */
export function buildingsToMesh(
  buildings: GeoFeature[],
  sourceLabel: string,
): ImportedMesh | null {
  const data: number[] = [0];
  for (const b of buildings) {
    if (!b.closed) continue;
    const h = Number.isFinite(b.height) && (b.height as number) > 0
      ? (b.height as number)
      : DEFAULT_BUILDING_HEIGHT;
    data[0]++;
    data.push(h, b.pts.length);
    for (const p of b.pts) data.push(p.x, p.y);
  }
  const r = core().geo_extrude_footprints(Float64Array.from(data));
  const nPos = r.length > 0 ? r[0] * 3 : 0;
  const positions = Array.from(r.subarray(1, 1 + nPos));
  const indices = Array.from(r.subarray(1 + nPos));
  if (positions.length < 9 || indices.length < 3) return null;
  return {
    id: contextId(GEO_BUILDING_MESH_PREFIX),
    type: "importedMesh",
    name: `Gebäude 3D (${sourceLabel})`,
    categoryCode: GEO_CATEGORY_DEFS.building.code,
    source: sourceLabel,
    positions,
    indices,
  };
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
