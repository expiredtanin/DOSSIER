/**
 * [293] Wand-Oberkante als EINE Auswahl über die Felder `Wall.roofAttach` ([G2]) und `Wall.ceilingAttach` ([292]).
 * Die Höhe selbst (`height`/`top`) bleibt getrennt (Geschosshöhe bzw. frei, s. Objekt-Info „Höhe“).
 *   storey  — Geschosshöhe/frei: Dächer schneiden automatisch, keine Decke
 *   roof    — bis unters Dach verlängert
 *   ceiling — bis Unterkante der Decke, Dächer schneiden nicht
 *   lower   — Decke und Dach, je Punkt die tiefere Kante (so rechnet `wall_bands.rs` bei beiden Feldern)
 */
export type WallTopMode = "storey" | "ceiling" | "roof" | "lower";
export const WALL_TOP_MODES: readonly WallTopMode[] = ["storey", "ceiling", "roof", "lower"];

export interface WallTopFields {
  roofAttach: boolean | undefined;
  ceilingAttach: boolean | undefined;
}

export function wallTopFromFields(roofAttach: boolean | undefined, ceilingAttach: boolean | undefined): WallTopMode {
  if (ceilingAttach) return roofAttach === false ? "ceiling" : "lower";
  return roofAttach === true ? "roof" : "storey";
}

/** Felder für eine Auswahl; `undefined` entfernt das Feld (Vorgabe). */
export function wallTopPatch(mode: WallTopMode): WallTopFields {
  switch (mode) {
    case "storey": return { roofAttach: undefined, ceilingAttach: undefined };
    case "roof": return { roofAttach: true, ceilingAttach: undefined };
    case "ceiling": return { roofAttach: false, ceilingAttach: true };
    case "lower": return { roofAttach: undefined, ceilingAttach: true };
  }
}

export const wallTopNext = (m: WallTopMode): WallTopMode => WALL_TOP_MODES[(WALL_TOP_MODES.indexOf(m) + 1) % WALL_TOP_MODES.length];
