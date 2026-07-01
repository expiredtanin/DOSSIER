// Gemeinsame Typen + Helfer für den Standort-Import (swisstopo & OSM).
//
// Beide Quellen liefern am Ende dasselbe: geschlossene/offene Polylinien in
// LOKALEN Modell-Metern (bereits um die Origin verschoben, siehe lv95.ts),
// kategorisiert nach Art (Gebäude/Strasse/Wasser/Grün). Die UI wandelt diese in
// `ContourSet`-Kontext-Objekte pro Kategorie um und legt sie in `project.context`.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { GeoOrigin } from "./lv95";
import type { ContextObject, Contour } from "../model/types";

/** Fachliche Kategorie einer importierten Kontext-Linie. */
export type GeoCategory = "building" | "road" | "water" | "green";

/** Ein importiertes Polygon/Polylinie in lokalen Modell-Metern. */
export interface GeoFeature {
  category: GeoCategory;
  /** Stützpunkte in lokalen Metern (x=Ost, y=Nord). */
  pts: { x: number; y: number }[];
  /** Geschlossener Ring (Gebäude/Wasser/Grün) vs. offene Linie (Strasse). */
  closed: boolean;
}

/** Ergebnis eines Import-Laufs: Features + verwendete Origin. */
export interface GeoImportResult {
  origin: GeoOrigin;
  features: GeoFeature[];
}

/** Menschlicher Layer-/Objektname je Kategorie (deutsch, für die Kontext-Liste). */
const CATEGORY_LABEL: Record<GeoCategory, string> = {
  building: "Gebäude",
  road: "Strassen",
  water: "Gewässer",
  green: "Grünflächen",
};

/** Layer-Kennung (englischer Identifier) je Kategorie — für spätere Zuordnung. */
const CATEGORY_LAYER: Record<GeoCategory, string> = {
  building: "context-buildings",
  road: "context-roads",
  water: "context-water",
  green: "context-green",
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
      contours,
    });
  }
  return objs;
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
  return base ? `${base}?u=${encodeURIComponent(url)}` : url;
}
