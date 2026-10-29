// Stiftsatz-Auflösung (ArchiCAD-Stiftsatz-Muster) im Rust-Kern ([K4] S3, `src-tauri/core/src/pens.rs`).
// Der Trick, der jeden bestehenden Farb-/Strichstärke-Leser (2D-Plan, beide 3D-Renderer, DXF-Export,
// Vorschau-Swatches) UNVERÄNDERT lässt: `Component.color`/`.foreground`/`.background`,
// `LayerCategory.color`/`.lw` bzw. die Element-Felder (`color`/`strokeWeight`/`weightMm`) bleiben
// IMMER die eine gültige, aufgelöste Farbe/Strichstärke. Ein Stift-Verweis (`xxxPenId`) schreibt diese
// Felder nur bei Gelegenheit (Stiftsatz-Wechsel, Stift-Änderung, neue Zuweisung) per `rebakePenOps` aus
// dem aktiven Stiftsatz NEU — kein Leser muss je einen Stift auflösen.
//
// Ein Stift (`PenStyle`) trägt Farbe UND Strichstärke zusammen (wie ein echter ArchiCAD-/AutoCAD-Stift).
//
// Im Kern: Standardpalette (255 Stifte, rein prozedural per HSL, keine externe Bibliothek, Stifte 1–9 und
// 250–255 wie `ACI_PALETTE` in `export/exportDxf.ts`), Freie-Farbe-Palette, Neu-Backen und das Entfernen
// von Stift-Verweisen. Hier bleiben nur die Lese-Auflösung einzelner Stifte (O(1), je Swatch im Render) und
// dünne Fassaden, die die Ops des Kerns liefern (`documentFor(project)`: das Kern-Dokument folgt dem Projekt).
//
// Bewusst NICHT abgedeckt: Layout-Annotationen (`Layout.annotations[]`) und `Tür`/`ExtrudedSolid`/Kontext-
// Objekte — kein `colorPenId`-Feld dort (Scope-Entscheid, s. PENDENZEN.md).

import type { PenStyle, Project } from "./types";
import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { core } from "../engine/coreWasm";

/** Farbe eines Stifts, der im aktiven Stiftsatz (noch) keinen Eintrag hat. */
export const PEN_FALLBACK_COLOR = "#9aa0a6";
/** Strichstärke (mm) eines Stifts, der im aktiven Stiftsatz (noch) keinen Eintrag hat. */
export const PEN_FALLBACK_WEIGHT = 0.18;

let freePalette: string[] | null = null;

/**
 * Feste Freie-Farbe-Palette für den Palette-Popover (`ui/PenColorField.tsx`): 8 Graustufen (Schwarz→Weiss)
 * + 8 Farbtöne × 5 Helligkeitsstufen = 48 Swatches. Aus dem Kern (erst nach `initCore()` lesbar, daher
 * eine Funktion, kein Modul-Wert); jeder Aufruf liefert dieselbe Liste.
 */
export function freeColorPalette(): string[] {
  if (!freePalette) freePalette = JSON.parse(core().pens_call("freePalette", "")) as string[];
  return freePalette;
}

/**
 * Setzt `Project.pens`/`penSets` auf die generierte 255er-Standardpalette — ERSETZT bestehende `pens`
 * vollständig (kein Merge), gedacht für den Erststart. Der neue Satz wird aktiv, wenn noch KEIN Stiftsatz
 * aktiv war.
 */
export function seedStandardPenSetOps(project: Project): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("penSeedOps", JSON.stringify({ id: `penset-${Date.now()}`, name: "Standard (CAD-Palette)" }));
}

/** Der aktuell aktive Stiftsatz, oder `undefined` (kein Stiftsatz angelegt/aktiviert). */
export function activePenSet(project: Project) {
  return project.penSets?.find((s) => s.id === project.activePenSetId);
}

/** Der Stil (Farbe+Strichstärke) EINES Stifts im aktiven Stiftsatz, oder `undefined` ohne Eintrag/Satz. */
export function resolvePenStyle(project: Project, penId: string): PenStyle | undefined {
  return activePenSet(project)?.pens[penId];
}

/** Löst einen Stift gegen den aktiven Stiftsatz auf; Fallback bei fehlendem Eintrag. */
export function resolvePenColor(project: Project, penId: string): string {
  return resolvePenStyle(project, penId)?.color ?? PEN_FALLBACK_COLOR;
}

/** Strichstärke (mm) eines Stifts, analog {@link resolvePenColor}. */
export function resolvePenWeight(project: Project, penId: string): number {
  return resolvePenStyle(project, penId)?.weight ?? PEN_FALLBACK_WEIGHT;
}

/**
 * Ops, die für JEDES Bauteil/JEDE Ebenen-Kategorie/JEDES Modell-Element mit gesetztem Stift die Farbe
 * (+ ggf. Strichstärke) des AKTIVEN Stiftsatzes in `color`/`foreground`/`background`/`lw`/`strokeWeight`/
 * `weightMm` schreiben; nur wirklich geänderte Elemente. Aufzurufen nach: Stiftsatz-Wechsel, Änderung EINES
 * Stifts im aktiven Satz oder Neuzuweisung eines Stifts (dort reicht meist ein direkter Patch).
 */
export function rebakePenOps(project: Project): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("penRebakeOps");
}

/**
 * Ops zum Löschen des Stifts `penId`: aus `pens` und allen Stiftsätzen entfernen und die Verweise
 * (`colorPenId`/`foregroundPenId`/`backgroundPenId`) in Bauteilen und im Kategorien-Baum löschen.
 */
export function deletePenOps(project: Project, penId: string): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("penDeleteOps", penId);
}
