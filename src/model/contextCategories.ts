// Kategorie-Codes der Kontext-Schicht (`project.context`, s. `ContextObject`
// in `types.ts`): importierte Gebäude/Terrain/Konturen/Luftbilder bekommen
// hier eine `categoryCode`-Zuordnung, damit sie wie jedes andere Bauteil über
// das Ebenen-Panel (Sichtbarkeit/Grau/Sperren) steuerbar sind — bislang
// wurden sie beim 2D-Plan IMMER gezeichnet, unabhängig von der Ebenen-
// Sichtbarkeit (Nutzer-Report: „sollten wie Gebäude/Dächer ausblendbar sein").
//
// Wiederverwendet, wo möglich, bereits im Sample-Projekt gesäte Codes ("11"
// Strasse, "12" Gebäude) — neue Codes liegen in bislang ungenutzten Lücken
// (02-04, 15-18) der DOSSIER-Nummerierung, damit nichts kollidiert.
//
// GRUPPIERUNG (2026-08-31, Nutzer-Wunsch): alle Kontext-Import-Kategorien
// hängen als KINDER unter einer gemeinsamen Elternebene „05 Kontext" (das
// Ebenen-Panel unterstützt Verschachtelung bereits, s. „20 Wände" mit
// Kindern „21 Türen/Fenster" etc. in `sampleProject.ts`) — statt als lose,
// gleichrangige Top-Level-Einträge. AUSNAHME: „31 Dächer"
// ({@link IMPORTED_ROOF_CATEGORY}) bleibt bewusst TOP-LEVEL, weil es sich mit
// der Dächer-Kategorie modellierter `Roof`-Objekte deckt (ein Ausblenden soll
// beide Quellen gemeinsam treffen) — sie unter „Kontext" zu verschachteln
// würde diese Kopplung optisch zerreissen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { GeoCategory } from "../io/geoContext";
import { flattenCategories } from "./layers";
import type { LayerCategory } from "./types";

/** Eine Kategorie-Definition (Code + Default-Name/Farbe/Strichstärke). */
export interface ContextCategoryDef {
  code: string;
  name: string;
  color: string;
  lw: number;
}

/**
 * Gemeinsame Elternebene aller Kontext-Import-Kategorien (Gelände/Luftbild/
 * Situation/Gebäude/Strasse/Wald/Parkplätze/Bahn/Gewässer/Grünflächen) —
 * reine Gruppierung im Ebenen-Panel, trägt selbst keine Geometrie
 * (`categoryCode` einzelner Kontext-Objekte zeigt immer auf ein KIND, nie auf
 * „05" direkt). Code „05" liegt in der bislang ungenutzten Lücke zwischen
 * „01 Vermessung" und „10 Situation" (s. `sampleProject.ts`).
 */
export const CONTEXT_PARENT_CATEGORY: ContextCategoryDef = {
  code: "05",
  name: "Kontext",
  color: "#707078",
  lw: 0.13,
};

/** Gelände-TIN (swissALTI3D/generiertes Terrain). */
export const TERRAIN_CATEGORY: ContextCategoryDef = {
  code: "02",
  name: "Gelände",
  color: "#8a9478",
  lw: 0.13,
};

/** Georeferenziertes Luftbild (SWISSIMAGE/eingefügtes Bild). */
export const IMAGE_CATEGORY: ContextCategoryDef = {
  code: "03",
  name: "Luftbild",
  color: "#707078",
  lw: 0.13,
};

/** Generischer DXF/DWG-Mesh-/Konturen-Import ohne spezifischere Zuordnung. */
export const GENERIC_IMPORT_CATEGORY: ContextCategoryDef = {
  code: "10",
  name: "Situation",
  color: "#909090",
  lw: 0.18,
};

/**
 * Dach-Flächen importierter swissBUILDINGS3D-v3-„separated"-Gebäude (eigener
 * DXF-Layer „Roof" je Fläche, s. `swissBuildings3d.ts::splitPfaceMeshByLayer`).
 * Teilt sich Code „31" bewusst mit der Dächer-Kategorie modellierter `Roof`-
 * Objekte (s. `sampleProject.ts`) — ein Ein-/Ausblenden über „Dächer" soll
 * BEIDE Quellen gemeinsam betreffen, nicht zwei separate, verwirrende Einträge
 * im Ebenen-Panel erzeugen.
 */
export const IMPORTED_ROOF_CATEGORY: ContextCategoryDef = {
  code: "31",
  name: "Dächer",
  color: "#7a4a3a",
  lw: 0.35,
};

/**
 * Kategorie je {@link GeoCategory} (Standort-Import, swisstopo & OSM) — deckt
 * sowohl `featuresToContextObjects` (OSM/flache swissBUILDINGS-Footprints)
 * als auch die echten swissBUILDINGS3D-Meshes ab (`building`).
 */
export const GEO_CATEGORY_DEFS: Record<GeoCategory, ContextCategoryDef> = {
  building: { code: "12", name: "Gebäude", color: "#888888", lw: 0.25 },
  road: { code: "11", name: "Strasse", color: "#a89070", lw: 0.18 },
  forest: { code: "04", name: "Wald", color: "#3a7a3a", lw: 0.13 },
  parking: { code: "15", name: "Parkplätze", color: "#a0a0a0", lw: 0.13 },
  railway: { code: "16", name: "Bahn", color: "#606060", lw: 0.18 },
  water: { code: "17", name: "Gewässer", color: "#5a90b0", lw: 0.13 },
  green: { code: "18", name: "Grünflächen", color: "#70b070", lw: 0.13 },
};

/** Kategorien, die als KINDER von {@link CONTEXT_PARENT_CATEGORY} gruppiert
 *  werden (alles ausser der Top-Level-Ausnahme „31 Dächer"). */
const NESTED_CONTEXT_CATEGORIES: ContextCategoryDef[] = [
  TERRAIN_CATEGORY,
  IMAGE_CATEGORY,
  GENERIC_IMPORT_CATEGORY,
  ...Object.values(GEO_CATEGORY_DEFS),
];

const toLayerCategory = (c: ContextCategoryDef): LayerCategory => ({
  code: c.code,
  name: c.name,
  color: c.color,
  lw: c.lw,
  visible: true,
  locked: false,
});

/**
 * Ergänzt `layers` um jede fehlende Kontext-Kategorie aus `codes` — bereits
 * vorhandene Codes (auch vom Nutzer umbenannte, egal auf welcher Baumtiefe)
 * bleiben unverändert, nur wirklich fehlende werden mit ihrem Default-Namen/
 * -Farbe ergänzt. Fehlende {@link NESTED_CONTEXT_CATEGORIES} landen als
 * KINDER von {@link CONTEXT_PARENT_CATEGORY} (legt „05 Kontext" bei Bedarf
 * selbst an); die Top-Level-Ausnahme „31 Dächer" bleibt Top-Level (s.
 * {@link IMPORTED_ROOF_CATEGORY}-Moduldoc). Reiner No-op, wenn nichts fehlt
 * (liefert dieselbe Referenz zurück, spart eine unnötige `project`-Neuanlage).
 */
export function ensureContextCategories(
  layers: LayerCategory[],
  codes: Iterable<string>,
): LayerCategory[] {
  const existing = new Set(flattenCategories(layers).map((c) => c.code));
  const missing = new Set<string>();
  for (const code of codes) {
    if (!existing.has(code)) missing.add(code);
  }
  if (missing.size === 0) return layers;

  const missingNested = NESTED_CONTEXT_CATEGORIES.filter((c) => missing.has(c.code)).map(
    toLayerCategory,
  );
  const missingTopLevel = missing.has(IMPORTED_ROOF_CATEGORY.code)
    ? [toLayerCategory(IMPORTED_ROOF_CATEGORY)]
    : [];

  let out = layers;
  if (missingNested.length > 0) {
    const parentIdx = out.findIndex((l) => l.code === CONTEXT_PARENT_CATEGORY.code);
    if (parentIdx >= 0) {
      out = out.map((l, i) =>
        i === parentIdx ? { ...l, children: [...(l.children ?? []), ...missingNested] } : l,
      );
    } else {
      out = [...out, { ...toLayerCategory(CONTEXT_PARENT_CATEGORY), children: missingNested }];
    }
  }
  if (missingTopLevel.length > 0) {
    out = [...out, ...missingTopLevel];
  }
  return out;
}
