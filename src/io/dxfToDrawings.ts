// DXF-Konturen → semantische 2D-Zeichengeometrie (Drawing2D).
//
// Der DXF-Parser liefert „dumme" Konturen (Vec2 + Z + optionaler Layer-Name).
// Beim Import in eine ZEICHNUNGSEBENE werden daraus echte Drawing2D-Elemente
// (line/polyline). Die Z-Höhe der Kontur wird in 2D bewusst IGNORIERT (eine
// Zeichnungsebene ist flach). Das `closed`-Flag steuert line vs. polyline:
//   • genau zwei Punkte, nicht geschlossen → `line`.
//   • sonst → `polyline` (mit `closed`-Flag).
//
// Kategorie-Zuordnung (categoryMode):
//   • "active"     — alles bekommt die aktive Kategorie (activeCategoryCode).
//   • "byLayer"    — der DXF-Layer-Name wird auf einen Kategorie-Code gemappt.
//                    `layerToCode` liefert (deterministisch) einen Code je
//                    Layer-Name; unbekannte/leere Layer fallen auf `fallbackCode`.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Contour, ContourSet, Drawing2D, Drawing2DGeom, ImportedText, LayerCategory } from "../model/types";
import type { ImportContour } from "./dxfParser";
import { planImportLayers } from "../model/layers";

/** Wie DXF-Layer auf Kategorien abgebildet werden. */
export type CategoryMode = "active" | "byLayer";

let drawingSeq = 0;
const nextId = (): string => `dxf2d-${Date.now()}-${drawingSeq++}`;

/** Default-Füllfarbe für aus HATCH importierte Flächen (neutral, restylebar). */
const DXF_HATCH_FILL = "#c8c8c8";

/**
 * Wandelt einen Satz Konturen-Sätze in Drawing2D-Elemente für die Ziel-Ebene
 * `levelId` um. Bei `categoryMode === "byLayer"` liefert `layerToCode` den
 * Kategorie-Code je DXF-Layer-Name; sonst bekommt alles `fallbackCode`.
 */
export function contoursToDrawings(
  sets: ContourSet[],
  levelId: string,
  categoryMode: CategoryMode,
  fallbackCode: string,
  layerToCode: (layerName: string) => string,
  fillColorOf?: (layerName: string) => string | undefined,
  /** Linienstil-Id je Layer (PDF-Strichmuster [76]); `undefined` = Kategorie-Default. */
  lineStyleOf?: (layerName: string) => string | undefined,
): Drawing2D[] {
  const out: Drawing2D[] = [];
  for (const set of sets) {
    for (const contour of set.contours) {
      const geom = contourGeom(contour);
      if (!geom) continue;
      const layerName = contour.layer ?? set.layer ?? "";
      const categoryCode =
        categoryMode === "byLayer" && layerName
          ? layerToCode(layerName)
          : fallbackCode;
      const drawing: Drawing2D = {
        id: nextId(),
        type: "drawing2d",
        levelId,
        categoryCode,
        geom,
      };
      const lineStyleId = lineStyleOf?.(layerName);
      if (lineStyleId) drawing.lineStyleId = lineStyleId;
      // Aus einer HATCH stammende Kontur → geschlossene, gefüllte Form. Vollton-
      // Füllung als restylebarer Default (neutrales Grau); Umriss bleibt Kategorie.
      if (contour.filled && geom.shape === "polyline") {
        drawing.fillColor = fillColorOf?.(layerName) ?? DXF_HATCH_FILL;
      }
      out.push(drawing);
    }
  }
  return out;
}

/**
 * Wandelt importierte Texte in Drawing2D-`text`-Elemente um — analog
 * `contoursToDrawings` (gleiche Layer→Kategorie-Zuordnung). Winkel/Höhe kommen
 * 1:1 aus `ImportedText` (Höhe in Modell-Metern, Winkel in Radiant).
 */
export function textsToDrawings(
  texts: ImportedText[],
  levelId: string,
  categoryMode: CategoryMode,
  fallbackCode: string,
  layerToCode: (layerName: string) => string,
): Drawing2D[] {
  const out: Drawing2D[] = [];
  for (const it of texts) {
    const layerName = it.layer ?? "";
    const categoryCode =
      categoryMode === "byLayer" && layerName ? layerToCode(layerName) : fallbackCode;
    out.push({
      id: nextId(),
      type: "drawing2d",
      levelId,
      categoryCode,
      geom: {
        shape: "text",
        at: { ...it.at },
        text: it.text,
        height: it.height,
        angle: it.angle,
      },
    });
  }
  return out;
}

/** Eine Kontur → 2D-Geometrie (line bei 2 offenen Punkten, sonst polyline). */
function contourGeom(contour: Contour): Drawing2DGeom | null {
  // Echte Kurve (CIRCLE/ARC) → GLATTE Kreis-/Bogen-Form statt tesselliertem Vieleck.
  const c = contour.curve;
  if (c) {
    if (c.kind === "circle") {
      return { shape: "circle", center: { x: c.cx, y: c.cy }, r: c.r };
    }
    return { shape: "arc", center: { x: c.cx, y: c.cy }, r: c.r, a0: c.a0, a1: c.a1 };
  }
  // Polylinie mit Bögen (DXF-Bulges): Stützpunkte + `bulge` statt des tessellierten Linienzugs.
  // VORZEICHEN: In DXF heisst Bulge > 0 „Bogen im Gegenuhrzeigersinn von a nach b" (Scheitel rechts
  // der Sehne), im Modell liegt der Scheitel bei Bulge > 0 LINKS der Sehne (`kernel2d/src/bulge.rs`,
  // Links-Normale) — also umgekehrt. Geprüft in `dxfBulgeImport.test.ts` gegen die Tessellierung des
  // Imports.
  const bp = (contour as ImportContour).bulgePolyline;
  if (bp && bp.pts.length >= 2 && bp.bulge.length === bp.pts.length) {
    return {
      shape: "polyline",
      pts: bp.pts.map((p) => ({ ...p })),
      closed: contour.closed,
      bulge: bp.bulge.map((b) => (b === 0 ? 0 : -b)),
    };
  }
  const pts = contour.pts;
  if (pts.length < 2) return null;
  if (pts.length === 2 && !contour.closed) {
    return { shape: "line", a: { ...pts[0] }, b: { ...pts[1] } };
  }
  return {
    shape: "polyline",
    pts: pts.map((p) => ({ ...p })),
    closed: contour.closed,
  };
}

/**
 * Kategorien für DXF-Layer, die im Projekt noch KEINE gleichnamige Kategorie
 * haben (Namensvergleich case-insensitiv, über den ganzen Baum). Sie werden als
 * Unterkategorien EINER neuen Elternkategorie `parentName` angelegt, damit ein
 * Import mit Dutzenden Layern (amtliche Vermessung) das Ebenen-Panel nicht flutet.
 * Codes: fortlaufend ab dem grössten bestehenden numerischen Code (wie
 * `nextFreeCode`). Liefert die neue Elternkategorie (oder null, wenn alle Layer
 * schon existieren) und das Mapping Layer-Name → Code für ALLE Layer.
 */
export function planImportCategories(
  layerNames: readonly string[],
  existing: readonly LayerCategory[],
  parentName: string,
  layerColors: Readonly<Record<string, string>> = {},
  layerLineWeights: Readonly<Record<string, number>> = {},
): { parent: LayerCategory | null; codeByLayer: Map<string, string> } {
  const { children, parentCode, codeByLayer } = planImportLayers(layerNames, existing, layerColors, layerLineWeights);
  if (children.length === 0) return { parent: null, codeByLayer };
  const parent: LayerCategory = {
    code: parentCode,
    name: parentName,
    color: "#707078",
    lw: 0.18,
    visible: true,
    locked: false,
    children,
  };
  return { parent, codeByLayer };
}

/** Liste der unterschiedlichen DXF-Layer-Namen über alle Konturen-Sätze. */
export function distinctLayers(sets: ContourSet[]): string[] {
  const seen = new Set<string>();
  for (const set of sets) {
    for (const contour of set.contours) {
      const name = contour.layer ?? set.layer ?? "";
      if (name) seen.add(name);
    }
  }
  return [...seen];
}

/** Wie {@link distinctLayers}, aber über Konturen UND Texte (beide tragen einen Layer). */
export function distinctImportLayers(sets: ContourSet[], texts: readonly ImportedText[]): string[] {
  const seen = new Set<string>(distinctLayers(sets));
  for (const it of texts) if (it.layer) seen.add(it.layer);
  return [...seen];
}

/** Gesamtzahl der Konturen über alle Sätze (für die Datei-Zusammenfassung). */
export function countContours(sets: ContourSet[]): number {
  return sets.reduce((sum, s) => sum + s.contours.length, 0);
}
