// [180] Klassen der abgeleiteten Darstellung: alles Sichtbare liegt auf einer Klasse, auch was nicht zu einem
// Element gehört (Schatten, Schnittmarken, automatische Koten) oder ein Befehl erzeugt (Aussenbemassung).
// Die Codes stehen im Kern (`src-tauri/core/src/standards.rs`, `DERIVED_CATEGORIES`; „Standards laden" legt die
// Klassen an); hier nur die Codes für die TS-Seite (Gleichheit prüft `derivedCategories.test.ts`).
// Fehlt eine Klasse im Projekt, bleibt die Darstellung sichtbar (wie im Kern `standards::derived_visible`).

import type { LayerCategory } from "./types";
import { findCategory } from "./layers";

/** Sonnenschatten im Grundriss, Schlagschatten in der Ansicht. */
export const SHADOW_CATEGORY = "08";
/** Automatische Aussenbemassung (Befehl `autodim`). */
export const AUTO_DIM_CATEGORY = "81";
/** Automatische Höhenkoten in Schnitt und Ansicht. */
export const LEVEL_MARK_CATEGORY = "82";
/** Schnitt- und Ansichtsmarken im Grundriss. */
export const SECTION_MARK_CATEGORY = "91";

export const DERIVED_CATEGORY_CODES: readonly string[] = [SHADOW_CATEGORY, AUTO_DIM_CATEGORY, LEVEL_MARK_CATEGORY, SECTION_MARK_CATEGORY];

/** Abgeleitete Darstellung der Klasse `code` sichtbar: Klasse eingeblendet (`shown`) oder im Projekt nicht vorhanden. */
export function derivedVisible(layers: LayerCategory[], code: string, shown: (code: string) => boolean): boolean {
  return shown(code) || !findCategory(layers, code);
}
