// Objektbibliothek 2D ([253]) — dünne Fassade über den Katalog des Rust-Kerns
// (`src-tauri/core/src/furniture_lib.rs`). Der Katalog beschreibt Objekte mit Gruppe, Klasse, Einfügepunkt und
// einer allgemeinen Parameterliste; die Linien erzeugt der Kern (zur Plan-Zeit nach Detailgrad, hier nur für
// die Vorschau der Palette und des Platzier-Werkzeugs).

import { core } from "../engine/coreWasm";
import type { Drawing2DGeom } from "./types";

export type LibParamKind = "length" | "count" | "flag" | "fraction" | "choice";

export interface LibParamDef {
  key: string;
  kind: LibParamKind;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface LibObjectDef {
  id: string;
  /** Gruppe (`lib.g.<group>`). */
  group: string;
  /** Klasse: Schlüssel, Code und Name der Grafik-Kategorie. */
  category: string;
  categoryCode: string;
  categoryName: string;
  /** Einfügepunkt: Wandseite Mitte oder Mittelpunkt. */
  anchor: "wall" | "center";
  /** Nutzt den Seed (Unordnung der Stühle). */
  seeded: boolean;
  params: LibParamDef[];
}

export interface LibCatalog {
  objects: LibObjectDef[];
  categories: { key: string; code: string; name: string; color: string; lw: number }[];
}

/** Parameter einer Instanz (Name → Zahl/Bool/Text), wie im Modell. */
export type LibParams = Record<string, number | boolean | string>;

export type LibDetail = "grob" | "mittel" | "fein";

let cache: LibCatalog | null = null;

/** Der Katalog (einmal aus dem Kern gelesen). */
export function libCatalog(): LibCatalog {
  if (!cache) {
    try {
      const c = JSON.parse(core().furniture_lib_catalog_json()) as Partial<LibCatalog>;
      cache = { objects: c.objects ?? [], categories: c.categories ?? [] };
    } catch {
      cache = { objects: [], categories: [] };
    }
  }
  return cache;
}

export function libObjectDef(id: string): LibObjectDef | undefined {
  return libCatalog().objects.find((o) => o.id === id);
}

/** Gruppen in Palettenreihenfolge. */
export function libGroups(): string[] {
  const seen: string[] = [];
  for (const o of libCatalog().objects) if (!seen.includes(o.group)) seen.push(o.group);
  return seen;
}

/** Vorgabe-Parameter eines Objekts (alle Schlüssel mit Vorgabewert). */
export function libDefaultParams(def: LibObjectDef): LibParams {
  const out: LibParams = {};
  for (const p of def.params) out[p.key] = p.kind === "flag" ? p.default >= 0.5 : p.default;
  return out;
}

/** Lokale Geometrie (Einfügepunkt = Ursprung, ohne Drehung) für Vorschau; der Kern erzeugt sie. */
export function libGeometry(libId: string, params: LibParams, detail: LibDetail, seed = 0): Drawing2DGeom[] {
  try {
    return JSON.parse(core().furniture_lib_geometry_json(libId, JSON.stringify(params), detail, seed >>> 0)) as Drawing2DGeom[];
  } catch {
    return [];
  }
}

type P = { x: number; y: number };

/** Geometrie als Linienzüge (Vorschau): Kreise, Bögen und Ellipsen abgetastet; `tf` bildet jeden Punkt ab. */
export function libGeometryToPolys(geoms: Drawing2DGeom[], tf: (p: P) => P = (p) => p): { pts: P[]; closed: boolean }[] {
  const out: { pts: P[]; closed: boolean }[] = [];
  const arc = (c: P, rx: number, ry: number, a0: number, a1: number, closed: boolean) => {
    const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) / (2 * Math.PI)) * 32));
    const pts: P[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push(tf({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) }));
    }
    out.push({ pts: closed ? pts.slice(0, -1) : pts, closed });
  };
  for (const g of geoms) {
    switch (g.shape) {
      case "line":
        out.push({ pts: [tf(g.a), tf(g.b)], closed: false });
        break;
      case "rect":
        out.push({
          pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }].map(tf),
          closed: true,
        });
        break;
      case "polyline":
        out.push({ pts: g.pts.map(tf), closed: g.closed });
        break;
      case "circle":
        arc(g.center, g.r, g.r, 0, 2 * Math.PI, true);
        break;
      case "ellipse":
        arc(g.center, g.rx, g.ry, 0, 2 * Math.PI, true);
        break;
      case "arc":
        arc(g.center, g.r, g.r, g.a0, g.a1 > g.a0 ? g.a1 : g.a1 + 2 * Math.PI, false);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Grenzen der Linienzüge (für den Massstab der Vorschau). */
export function polysBounds(polys: { pts: P[] }[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const pl of polys)
    for (const p of pl.pts) {
      if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      else {
        b.minX = Math.min(b.minX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxX = Math.max(b.maxX, p.x);
        b.maxY = Math.max(b.maxY, p.y);
      }
    }
  return b;
}
