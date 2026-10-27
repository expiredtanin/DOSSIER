// OpenStreetMap-Anbindung (Overpass API) für den Standort-Import.
//
// Holt für eine LV95-Box Gebäude / Strassen / Wasser / Grünflächen / Parkplätze /
// Bahnlinien / Wald und wandelt sie in Polylinien in LOKALEN Modell-Metern (über
// LV95 + Origin, siehe
// lv95.ts). Overpass sendet je nach Mirror unzuverlässige CORS-Header, daher
// läuft der Abruf über den openbureau-core Geo-Proxy (`viaProxy`), sofern
// `VITE_GEO_PROXY` gesetzt ist — sonst Direktabruf gegen den CORS-fähigen
// Mirror.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { netFetch } from "../net/net";
import { lv95BboxToWgs84, makeOrigin, wgs84ToLocal } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { bboxAround } from "./lv95";
import type { GeoCategory, GeoFeature } from "./geoContext";
import { viaProxy } from "./geoContext";

// Direkter Mirror mit CORS `*` (Fallback, falls kein Proxy konfiguriert ist).
const OVERPASS = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

/** Welche OSM-Kategorien der Aufrufer möchte. */
export interface OsmSelection {
  buildings: boolean;
  roads: boolean;
  water: boolean;
  green: boolean;
  parking: boolean;
  railway: boolean;
  forest: boolean;
}

/** Ein Overpass-Element mit inline-Geometrie (`out geom`). */
interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: {
    type: string;
    role: string;
    geometry?: { lat: number; lon: number }[];
  }[];
}

/** Baut die Overpass-QL-Abfrage aus der WGS84-Box + Auswahl. */
function buildQuery(
  bbox: { south: number; west: number; north: number; east: number },
  sel: OsmSelection,
): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts: string[] = [];
  if (sel.buildings) parts.push(`way["building"](${b});`);
  if (sel.roads) parts.push(`way["highway"](${b});`);
  if (sel.water) {
    parts.push(`way["natural"="water"](${b});`);
    parts.push(`way["waterway"](${b});`);
    parts.push(`relation["natural"="water"](${b});`);
  }
  if (sel.green) {
    parts.push(`way["leisure"="park"](${b});`);
    parts.push(`way["landuse"~"grass|meadow|recreation_ground"](${b});`);
  }
  if (sel.parking) parts.push(`way["amenity"="parking"](${b});`);
  if (sel.railway) parts.push(`way["railway"~"rail|tram"](${b});`);
  if (sel.forest) {
    parts.push(`way["landuse"="forest"](${b});`);
    parts.push(`way["natural"="wood"](${b});`);
  }
  return `[out:json][timeout:40];(${parts.join("")});out geom;`;
}

/** Ordnet ein Element anhand seiner Tags einer Kategorie zu (oder null). */
function categorize(
  tags: Record<string, string> | undefined,
  sel: OsmSelection,
): GeoCategory | null {
  if (!tags) return null;
  if (sel.buildings && tags.building) return "building";
  if (sel.water && (tags.natural === "water" || tags.waterway)) return "water";
  if (sel.forest && (tags.natural === "wood" || tags.landuse === "forest"))
    return "forest";
  if (
    sel.green &&
    (tags.leisure === "park" ||
      /grass|meadow|recreation_ground/.test(tags.landuse ?? ""))
  )
    return "green";
  if (sel.parking && tags.amenity === "parking") return "parking";
  if (sel.railway && /rail|tram/.test(tags.railway ?? "")) return "railway";
  if (sel.roads && tags.highway) return "road";
  return null;
}

/** Geschlossene Kategorien (Flächen) vs. offene (Strassen/Bahn). */
function isClosedCategory(cat: GeoCategory): boolean {
  return cat !== "road" && cat !== "railway";
}

/**
 * Gebäudehöhe (m) aus OSM-Tags: bevorzugt `height` (numerisch, evtl. mit
 * Einheit), sonst `building:levels` × 3 m Geschosshöhe. Ohne Angabe `undefined`
 * (die Extrusion nutzt dann die Default-Höhe).
 */
function osmBuildingHeight(
  tags: Record<string, string> | undefined,
): number | undefined {
  if (!tags) return undefined;
  const raw = tags.height ?? tags["building:height"];
  if (raw) {
    const m = parseFloat(raw.replace(",", "."));
    if (Number.isFinite(m) && m > 0) return m;
  }
  const lvl = tags["building:levels"] ?? tags["building:levels:aboveground"];
  if (lvl) {
    const l = parseFloat(lvl.replace(",", "."));
    if (Number.isFinite(l) && l > 0) return l * 3;
  }
  return undefined;
}

/**
 * OSM-Features für Zentrum + Radius (Meter) laden. `originIn` erlaubt es, exakt
 * dieselbe Origin wie ein vorheriger swisstopo-Import zu verwenden.
 */
export async function fetchOsm(
  center: LV95,
  radius: number,
  sel: OsmSelection,
  originIn?: GeoOrigin,
): Promise<{ origin: GeoOrigin; features: GeoFeature[] }> {
  const origin = originIn ?? makeOrigin(center);
  if (
    !sel.buildings &&
    !sel.roads &&
    !sel.water &&
    !sel.green &&
    !sel.parking &&
    !sel.railway &&
    !sel.forest
  ) {
    return { origin, features: [] };
  }

  const bbox = lv95BboxToWgs84(bboxAround(center, radius));
  const query = buildQuery(bbox, sel);

  const res = await netFetch(viaProxy(OVERPASS), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`OSM-Abruf fehlgeschlagen (${res.status})`);
  const data = (await res.json()) as { elements?: OverpassElement[] };

  const features: GeoFeature[] = [];
  const push = (
    geometry: { lat: number; lon: number }[] | undefined,
    cat: GeoCategory,
    height?: number,
  ) => {
    if (!geometry || geometry.length < 2) return;
    const pts = geometry.map((g) => wgs84ToLocal(g.lat, g.lon, origin));
    const closed = isClosedCategory(cat);
    if (closed && pts.length < 3) return;
    features.push({ category: cat, pts, closed, height });
  };

  for (const el of data.elements ?? []) {
    const cat = categorize(el.tags, sel);
    if (!cat) continue;
    const h = cat === "building" ? osmBuildingHeight(el.tags) : undefined;
    if (el.type === "way") {
      push(el.geometry, cat, h);
    } else if (el.type === "relation") {
      // Multipolygon: outer-Ringe als einzelne geschlossene Linien übernehmen.
      for (const m of el.members ?? []) {
        if (m.role === "outer" || m.role === "") push(m.geometry, cat, h);
      }
    }
  }
  return { origin, features };
}
