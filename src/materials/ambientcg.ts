// ambientCG-API-Client — Live-Zugriff auf die KOMPLETTE CC0-Materialbibliothek
// (ambientcg.com, ~2000+ Materialien). Statt alles zu bündeln (Gigabytes)
// durchsucht die App die Bibliothek zur Laufzeit über die API, zeigt Thumbnails
// und lädt die Textur-Karten eines Materials ERST bei Auswahl herunter,
// entpackt das Zip (jszip) und erzeugt Blob-URLs je Karte — direkt kompatibel
// mit `MaterialRuntime` (runtime.ts), das beliebige URLs/Blob-URLs lädt.
//
// CORS: Die Such-JSON (`ambientcg.com/api/v2/full_json`) und der Download-
// Starter (`ambientcg.com/get`, ein 302-Redirect) senden KEINE CORS-Header und
// sind daher aus dem Browser NICHT direkt abrufbar. Sie laufen deshalb über
// einen Proxy (Dev: Vite-Proxy `/ambientcg` → siehe vite.config.ts; Prod: eine
// eigene Proxy-Route, konfigurierbar über VITE_AMBIENTCG_PROXY). Die Thumbnails
// (acg-media.struffelproductions.com) senden `Access-Control-Allow-Origin: *`
// und werden daher DIREKT geladen (kein Proxy nötig).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { netFetch } from "../net/net";
import JSZip from "jszip";
import type { ComponentMaterial } from "../model/types";

/**
 * Proxy-Basis für die CORS-behafteten ambientCG-Endpunkte (`/api/...` und
 * `/get`). Default `/ambientcg` — im Dev vom Vite-Proxy auf `https://
 * ambientcg.com` gemappt. Für Prod via `VITE_AMBIENTCG_PROXY` überschreibbar
 * (z. B. eine eigene Proxy-Route). Ohne trailing slash.
 */
// `import.meta.env` wird von Vite injiziert; da im Projekt keine vite/client-
// Typen eingebunden sind, greifen wir defensiv typisiert darauf zu.
const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> })
  .env;
const PROXY_BASE: string =
  ENV?.VITE_AMBIENTCG_PROXY?.replace(/\/$/, "") ?? "/ambientcg";

/** Ein Suchtreffer der ambientCG-Bibliothek (für das Thumbnail-Grid). */
export interface AmbientMaterial {
  /** ambientCG-Asset-ID, z. B. „Wood095". */
  id: string;
  /** Anzeigename (aus der API; sonst die ID). */
  name: string;
  /** Kategorie-Anzeigename, z. B. „Wood" (kann leer sein). */
  category: string;
  /** Thumbnail-URL (direkt ladbar, CORS `*`). */
  thumbUrl: string;
}

/** Eine Seite Suchtreffer plus Gesamtzahl (für Pagination/„mehr laden"). */
export interface AmbientSearchResult {
  items: AmbientMaterial[];
  /** Gesamtzahl gefundener Assets (server-seitig gezählt). */
  total: number;
  /** Verwendeter Offset dieser Seite. */
  offset: number;
  /** Angeforderte Seitengröße. */
  limit: number;
}

/** Verfügbare Textur-Auflösungen (ambientCG-Attribut-Präfix). */
export type AmbientResolution = "1K" | "2K" | "4K";

/** Optionen für {@link searchMaterials}. */
export interface SearchOptions {
  /** Freitext-Suche (leer = alle, nach Popularität sortiert). */
  query?: string;
  /** Optionaler Kategorie-Filter (ambientCG-Kategorie-Schlüssel). */
  category?: string;
  /** Seitengröße (Default 24). */
  limit?: number;
  /** Offset für Pagination (Default 0). */
  offset?: number;
  /** Abbruch-Signal (z. B. bei neuer Suche). */
  signal?: AbortSignal;
}

// ── Interne API-Typen (nur die genutzten Felder) ───────────────────────────

interface RawPreviewImage {
  [size: string]: string | undefined;
}

interface RawAsset {
  assetId: string;
  displayName?: string;
  customDisplayName?: string;
  displayCategory?: string;
  category?: string | null;
  previewImage?: RawPreviewImage;
}

interface RawFullJson {
  numberOfResults?: number;
  foundAssets?: RawAsset[];
}

/** Baut eine Proxy-URL für einen ambientCG-Pfad (mit führendem `/`). */
function proxyUrl(path: string): string {
  return `${PROXY_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Wählt das größte verfügbare Thumbnail aus dem previewImage-Objekt. */
function pickThumb(preview: RawPreviewImage | undefined): string {
  if (!preview) return "";
  // Bevorzugt größere PNG-Thumbnails (bessere Vorschau im Grid).
  const order = ["512-PNG", "256-PNG", "128-PNG", "64-PNG"];
  for (const key of order) {
    const url = preview[key];
    if (url) return url;
  }
  // Fallback: irgendein vorhandener Wert.
  for (const v of Object.values(preview)) if (v) return v;
  return "";
}

/**
 * Durchsucht die ambientCG-Materialbibliothek. Liefert eine Seite Treffer mit
 * Thumbnails plus die Gesamtzahl (für „mehr laden"). Läuft über den Proxy
 * (CORS). Wirft bei Netz-/CORS-Fehlern — der Aufrufer zeigt einen Hinweis.
 */
export async function searchMaterials(
  opts: SearchOptions = {},
): Promise<AmbientSearchResult> {
  const { query, category, limit = 24, offset = 0, signal } = opts;

  const params = new URLSearchParams();
  params.set("type", "Material");
  // Nur die für Grid + IDs nötigen Daten anfordern (kleinere Antwort).
  params.set("include", "imageData");
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (query && query.trim()) params.set("q", query.trim());
  if (category && category.trim()) params.set("category", category.trim());
  // Ohne Freitext nach Popularität sortieren (sinnvolle Default-Reihenfolge).
  if (!query || !query.trim()) params.set("sort", "Popular");

  const url = proxyUrl(`/api/v2/full_json?${params.toString()}`);
  const res = await netFetch(url, { signal });
  if (!res.ok) {
    throw new Error(`ambientCG-API HTTP ${res.status}`);
  }
  const json = (await res.json()) as RawFullJson;

  const items: AmbientMaterial[] = (json.foundAssets ?? []).map((a) => ({
    id: a.assetId,
    name: a.customDisplayName || a.displayName || a.assetId,
    category: a.displayCategory || a.category || "",
    thumbUrl: pickThumb(a.previewImage),
  }));

  return {
    items,
    total: json.numberOfResults ?? items.length,
    offset,
    limit,
  };
}

// ── Kategorie-Liste (statisch, aus den ambientCG-Material-Kategorien) ───────
// Die häufigsten Material-Kategorien für den Filter. Die API kennt weitere; das
// deckt die BIM-relevanten Oberflächen ab. Wert = ambientCG-Kategorie-Schlüssel.
export const AMBIENT_CATEGORIES: string[] = [
  "Wood",
  "WoodFloor",
  "Concrete",
  "Bricks",
  "Plaster",
  "Tiles",
  "Marble",
  "Rock",
  "PavingStones",
  "Metal",
  "Ground",
  "Gravel",
  "Grass",
  "Fabric",
  "Leather",
  "Asphalt",
  "Terrazzo",
  "Wallpaper",
  "Roof",
  "OfficeCeiling",
];

// ── Karten-Download + Entpacken ────────────────────────────────────────────

/** Zuordnung ambientCG-Dateinamen-Bestandteile → ComponentMaterial-Karten. */
const MAP_MATCHERS: { kind: keyof ComponentMaterial; needles: string[] }[] = [
  { kind: "color", needles: ["_color", "_col", "_diffuse", "_albedo"] },
  { kind: "normal", needles: ["_normalgl", "_normal", "_nrm", "_nor"] },
  { kind: "roughness", needles: ["_roughness", "_rough", "_rgh"] },
  { kind: "metalness", needles: ["_metalness", "_metallic", "_metal"] },
  { kind: "displacement", needles: ["_displacement", "_disp", "_height"] },
  { kind: "ao", needles: ["_ambientocclusion", "_ao", "_occlusion"] },
];

/** Ordnet einen Zip-Eintragsnamen einer Karten-Art zu (oder null). */
function classifyMap(fileName: string): keyof ComponentMaterial | null {
  const lower = fileName.toLowerCase();
  if (!/\.(jpg|jpeg|png)$/.test(lower)) return null;
  // ambientCG liefert die Normal-Map in zwei Konventionen: DirectX (…NormalDX)
  // und OpenGL (…NormalGL). three.js erwartet OpenGL — die DX-Variante daher
  // NICHT als Normal-Karte übernehmen (sonst kippt die Tiefe je nach Zip-
  // Reihenfolge in die falsche Richtung).
  if (lower.includes("_normaldx")) return null;
  for (const m of MAP_MATCHERS) {
    if (m.needles.some((n) => lower.includes(n))) return m.kind;
  }
  return null;
}

/** Ergebnis von {@link fetchMaterialMaps}: Karten als Blob-URLs + Metadaten. */
export interface FetchedMaterial {
  material: ComponentMaterial;
  /** Alle erzeugten Blob-URLs (zum Freigeben via `revokeMaterial`). */
  blobUrls: string[];
}

/**
 * Lädt das 1K-JPG-Zip eines ambientCG-Materials (über den Proxy, da `/get`
 * keine CORS-Header sendet), entpackt es mit jszip und erzeugt je erkannter
 * Karte (color/normal/roughness/metalness/displacement/ao) eine Blob-URL. Das
 * Ergebnis ist ein `ComponentMaterial`, das `MaterialRuntime` direkt laden kann.
 *
 * `resolution` wählt das Auflösungs-Attribut (1K/2K/4K). 1K ist der sinnvolle
 * Default (schnell, für Echtzeit-3D ausreichend).
 */
export async function fetchMaterialMaps(
  id: string,
  resolution: AmbientResolution = "1K",
  sizeM = 1.0,
  signal?: AbortSignal,
): Promise<FetchedMaterial> {
  const file = `${id}_${resolution}-JPG.zip`;
  const url = proxyUrl(`/get?file=${encodeURIComponent(file)}`);
  const res = await netFetch(url, { signal });
  if (!res.ok) {
    throw new Error(`ambientCG-Download HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const material: ComponentMaterial = { libraryId: id, sizeM };
  const blobUrls: string[] = [];

  // Alle Bild-Einträge durchgehen, je Karten-Art die erste Übereinstimmung
  // übernehmen (ambientCG liefert je Art genau eine Datei).
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  for (const entry of entries) {
    const kind = classifyMap(entry.name);
    if (!kind || material[kind]) continue;
    const blob = await entry.async("blob");
    // Korrekten Bild-MIME setzen, damit der Browser die Blob-URL als Bild lädt.
    const ext = entry.name.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    const typed = blob.type ? blob : new Blob([blob], { type: ext });
    const objUrl = URL.createObjectURL(typed);
    (material as Record<string, unknown>)[kind] = objUrl;
    blobUrls.push(objUrl);
  }

  if (blobUrls.length === 0) {
    throw new Error("Keine Textur-Karten im Zip gefunden");
  }
  return { material, blobUrls };
}

/** Gibt die Blob-URLs eines heruntergeladenen Materials frei. */
export function revokeMaterial(blobUrls: string[]): void {
  for (const u of blobUrls) URL.revokeObjectURL(u);
}

const MATERIAL_MAP_KEYS: (keyof ComponentMaterial)[] = [
  "color",
  "normal",
  "roughness",
  "metalness",
  "displacement",
  "ao",
];

/**
 * Gibt die Blob-URLs eines bereits zugewiesenen `ComponentMaterial` frei (Karten
 * aus ambientCG-Download ODER lokalem Upload — beide nutzen `createObjectURL`).
 * Bibliotheks-Assets (`materialFromAsset`) liefern statische Pfade, keine
 * Blob-URLs, und bleiben daher unangetastet.
 */
export function revokeMaterialUrls(material: ComponentMaterial | undefined): void {
  if (!material) return;
  const blobUrls = MATERIAL_MAP_KEYS.map((k) => material[k]).filter(
    (u): u is string => typeof u === "string" && u.startsWith("blob:"),
  );
  revokeMaterial(blobUrls);
}
