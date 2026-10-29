// Das semantische Gebäudemodell — der Kern von BIM.
// Bauteile haben Bedeutung, nicht nur Form. Eine Tür "kennt" ihre Wand,
// eine Wand "kennt" ihren mehrschichtigen Aufbau (WallType).
//
// Dokumentmodell (nach DOSSIER): zwei UNABHÄNGIGE Achsen.
//   1. Zeichnungsebenen (DrawingLevel) = oberste Schnitte: Geschosse +
//      Schnitte/Ansichten.
//   2. Ebenen (LayerCategory) = Grafik-Kategorie-Schema, das für jedes
//      Geschoss gilt. Ein Element lebt auf einer Kategorie (code) UND einem
//      Geschoss.
//
// [K4] S4: Die Datentypen des Projekts (`Project`, `Wall`, `Opening` …) kommen aus dem
// Rust-Modell (`src-tauri/core/src/model/`) und werden nach `types.generated.ts` erzeugt
// (`npm run gen:types`). Neue Modellfelder NUR dort eintragen. Hier bleiben Hilfstypen
// ohne Gegenstück im gespeicherten Projekt und die Helfer-Funktionen.

import type {
  BuiltinPaletteBanks,
  Ceiling,
  CeilingType,
  Component,
  DoorType,
  DrawingLevel,
  HatchStyle,
  Layer,
  LineStyle,
  Opening,
  Project,
  Roof,
  SashDef,
  Vec2,
  Wall,
  WallType,
  WindowType,
} from "./types.generated";

export type * from "./types.generated";

/** Schlüssel einer mitgelieferten Palette-Bank (s. {@link BuiltinPaletteBanks}). */
export type BuiltinPaletteBank = keyof BuiltinPaletteBanks;

/**
 * Ein Kanten-/Seiten-Griff eines selektierten Elements (zusätzlich zu den
 * Eckpunkt-Griffen). Liegt am Mittelpunkt einer Seite (Modell-Meter) und zeigt
 * mit `normal` als Einheitsvektor nach AUSSEN (vom Element weg). `aIndex`/
 * `bIndex` sind die beiden Vertex-Indizes der Kante — passend zur Indizierung
 * von `drawingVertices`/`moveGripOf`. Ziehen verschiebt BEIDE Vertices senkrecht
 * zur Kante (Form wächst/schrumpft an dieser Seite).
 */
export interface EdgeGrip {
  mid: Vec2;
  normal: Vec2;
  aIndex: number;
  bIndex: number;
  /**
   * Freie Kanten-Verschiebung: gesetzt bei OFFENER Geometrie (Linie/offene
   * Polylinie). Das Segment folgt dem vollen Cursor-Delta (nicht nur der Normale),
   * beide Endpunkte wandern mit, die Nachbar-Segmente dehnen sich nach. Bei
   * geschlossenen Formen/Wänden fehlt das Flag → senkrechte (parallel-)Verschiebung
   * entlang der Außennormale wie bisher.
   */
  free?: boolean;
  /**
   * Zu welchem Element diese Kante gehört (für Mehrfachauswahl — mehrere
   * gewählte Elemente liefern je eigene Kanten-Griffe). Fehlt bei den
   * exklusiven Einzel-Fällen (Decke/Raum), die weiterhin über die separat
   * gehaltene `selectedCeilingId`/`selectedRoomId` aufgelöst werden.
   */
  owner?: { drawingId?: string; wallId?: string };
}

/**
 * Ein importiertes Text-Element (DXF TEXT/MTEXT). `at` = Einfügepunkt in Metern,
 * `height` = Schrifthöhe in Modell-Metern, `angle` = Drehung in RADIANT (CCW).
 * Wird beim Drawing-Import zu einem `{shape:"text"}`-Drawing2D.
 */
export interface ImportedText {
  at: Vec2;
  text: string;
  height: number;
  angle: number;
  /** Ursprünglicher DXF-Layer-Name (für die Kategorisierung beim 2D-Import). */
  layer?: string;
}

// ── Helfer ───────────────────────────────────────────────────────────────

export const getWallType = (project: Project, wall: Wall): WallType => {
  const wt = project.wallTypes.find((t) => t.id === wall.wallTypeId);
  if (!wt) throw new Error(`Unbekannter Wandtyp: ${wall.wallTypeId}`);
  return wt;
};

/**
 * Liefert den Aufbau-Typ einer Decke oder wirft. Bevorzugt den dedizierten
 * Deckentyp (`ceilingTypeId` → `ceilingTypes`); fehlt er, fällt die Auflösung
 * auf das LEGACY-Feld `wallTypeId` → `wallTypes` zurück (Rückwärtskompatibilität
 * mit Projekten von vor den Deckenstilen — dort trug die Decke ihren Aufbau
 * direkt über einen WallType).
 */
export const getCeilingType = (project: Project, ceiling: Ceiling): CeilingType | WallType => {
  if (ceiling.ceilingTypeId) {
    const ct = (project.ceilingTypes ?? []).find((t) => t.id === ceiling.ceilingTypeId);
    if (ct) return ct;
  }
  const wt = project.wallTypes.find((t) => t.id === ceiling.wallTypeId);
  if (!wt) throw new Error(`Unbekannter Deckentyp: ${ceiling.ceilingTypeId ?? ceiling.wallTypeId}`);
  return wt;
};

/**
 * Gesamtdicke einer Decke (Meter): eine explizite `thickness`-Übersteuerung hat
 * Vorrang, sonst die Summe der Schichtdicken ihres Aufbau-Typs (siehe
 * `getCeilingType`).
 */
export const ceilingThickness = (project: Project, ceiling: Ceiling): number => {
  if (ceiling.thickness != null && ceiling.thickness > 0) return ceiling.thickness;
  try {
    return wallTypeThickness(getCeilingType(project, ceiling));
  } catch {
    return 0.2;
  }
};

/**
 * Schichtaufbau eines Daches (aussen/Eindeckung → innen/Verkleidung). Mit
 * {@link Roof.roofTypeId} die Schichten des Dachtyps; sonst eine EINSCHICHTIGE
 * synthetische Schicht aus {@link Roof.thickness} (leere `componentId` ⇒ der
 * Renderer nutzt seine Default-Dachfarbe).
 */
export const roofLayers = (project: Project, roof: Roof): Layer[] => {
  if (roof.roofTypeId) {
    const rt = (project.roofTypes ?? []).find((t) => t.id === roof.roofTypeId);
    if (rt && rt.layers.length > 0) return rt.layers;
  }
  return [{ componentId: "", thickness: Math.max(0, roof.thickness) }];
};

/**
 * Löst den {@link DoorType} einer Tür-Öffnung auf, oder `undefined` (keine
 * `typeId` bzw. unbekannt ⇒ Inline-Verhalten). Bewusst NICHT werfend — der
 * Typ ist eine optionale Übersteuerung, kein Pflichtbezug wie beim Wandtyp.
 */
export const getDoorType = (project: Project, opening: Opening): DoorType | undefined =>
  opening.typeId ? (project.doorTypes ?? []).find((t) => t.id === opening.typeId) : undefined;

/** Löst den {@link WindowType} einer Fenster-Öffnung auf, oder `undefined`. */
export const getWindowType = (project: Project, opening: Opening): WindowType | undefined =>
  opening.typeId ? (project.windowTypes ?? []).find((t) => t.id === opening.typeId) : undefined;

/**
 * Flügeleinteilung eines Fenstertyps als normalisierte {@link SashDef}-Liste.
 * Ist `wt.sashes` gesetzt, gilt sie unverändert; sonst wird sie aus `wingCount`
 * gleichmässig abgeleitet (n Flügel ⇒ n Flügel-Einträge; die n−1 Mittelpfosten
 * ergeben sich implizit aus der gleichmässigen Aufteilung). So beherrschen alle
 * Renderer beide Wege (Alt-Projekte ohne `sashes` inbegriffen).
 */
export const sashesOfWindowType = (wt: WindowType): SashDef[] => {
  if (wt.sashes && wt.sashes.length > 0) return wt.sashes;
  const n = Math.max(1, Math.round(wt.wingCount || 1));
  const opening = wt.kind === "fest" ? "fest" : wt.kind;
  return Array.from({ length: n }, (_, i) => ({
    kind: "fluegel" as const,
    autoWidth: true,
    opening,
    // Abwechselnder Anschlag (klassisch): erster Flügel links, nächster rechts …
    hingeSide: (i % 2 === 0 ? "left" : "right") as "left" | "right",
  }));
};

/**
 * Verglasungs-Scheibenzahl (1/2/3) eines Fenstertyps, render-wirksam. `glazingPanes`
 * hat Vorrang; fehlt es, wird sie aus {@link WindowType.glazing} abgeleitet.
 */
export const glazingPanesOf = (wt: WindowType): 1 | 2 | 3 => {
  if (wt.glazingPanes) return wt.glazingPanes;
  return wt.glazing === "dreifach" ? 3 : wt.glazing === "zweifach" ? 2 : 1;
};

/** Liefert eine Schraffur (HatchStyle) per ID oder wirft. */
export const getHatch = (project: Project, id: string): HatchStyle => {
  const h = project.hatches.find((ht) => ht.id === id);
  if (!h) throw new Error(`Unbekannte Schraffur: ${id}`);
  return h;
};

/** Liefert einen Linienstil (LineStyle) per ID oder wirft. */
export const getLineStyle = (project: Project, id: string): LineStyle => {
  const l = project.lineStyles.find((ls) => ls.id === id);
  if (!l) throw new Error(`Unbekannter Linienstil: ${id}`);
  return l;
};

/** Liefert eine Zeichnungsebene (Geschoss) per ID oder wirft. */
export const getFloor = (project: Project, id: string): DrawingLevel => {
  const g = project.drawingLevels.find((z) => z.id === id);
  if (!g) throw new Error(`Unbekanntes Geschoss: ${id}`);
  return g;
};

// Ebenen-Baum und Geschoss-Stapelung liegen im Rust-Kern ([K4] S3, `model/layers.ts`); Re-Export, damit
// die Aufrufer gleich bleiben.
export { collectVisibleCodes, flattenCategories, getLayerCategory, recomputeFloorElevations } from "./layers";

/** Gesamtdicke eines Wandtyps = Summe der Schichtdicken. */
export const wallTypeThickness = (wt: WallType): number =>
  wt.layers.reduce((sum, l) => sum + l.thickness, 0);

/**
 * Kompakter Anzeigetext für einen Wandtyp im Dropdown (VW-Stil).
 * - Einschichtig mit Kürzel: „BET 24" (Kürzel + Dicke in cm)
 * - Mehrschichtig mit Kürzeln: „GKB·BET·DAE" + Gesamtdicke „(25.5)"
 * - Ohne Kürzel: Name bleibt — kein Rückfall auf rohen Namen, nur keine Kurzform.
 *
 * `project.components` wird genutzt, um `Component.abbrev` aufzulösen.
 * Ist kein abbrev gesetzt, erscheint der volle Name unverändert.
 */
export function wallTypeLabel(
  wt: WallType | CeilingType,
  components: Component[],
): string {
  const resolve = (id: string) => components.find((c) => c.id === id);
  const totalCm = +(wallTypeThickness(wt) * 100).toFixed(1);
  // cm-Zahl: "24" statt "24.0", "17.5" bleibt "17.5"
  const cmStr = totalCm % 1 === 0 ? String(totalCm | 0) : String(totalCm);

  // Alle Schichten haben ein Kürzel → Kurzform bauen
  const abbrevs = wt.layers.map((l) => resolve(l.componentId)?.abbrev ?? "");
  const allHaveAbbrev = abbrevs.every((a) => a.length > 0);
  if (allHaveAbbrev) {
    if (wt.layers.length === 1) return `${abbrevs[0]} ${cmStr}`;
    return `${abbrevs.join("·")} (${cmStr})`;
  }
  // Fallback: voller Name
  return wt.name;
}

/** Formatiert Meter mit zwei Nachkommastellen, z. B. "0.35 m". */
export const formatM = (meters: number): string => meters.toFixed(2) + " m";

/**
 * Standard-Stiftstärken (mm Papier bei 100 %), Vorgabeliste für Linienstil-/
 * Strichstärke-Eingaben. Bedeutung: Breite auf dem Papier — die Linien skalieren
 * mit dem Massstab (non-scaling-stroke). Werte sind Vorschläge; man darf abweichen.
 */
export const PEN_WEIGHTS: number[] = [
  0.02, 0.1, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0,
];
