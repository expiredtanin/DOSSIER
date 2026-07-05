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

import type { Contour, ContourSet, Drawing2D, Drawing2DGeom, ImportedText } from "../model/types";

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
      // Aus einer HATCH stammende Kontur → geschlossene, gefüllte Form. Vollton-
      // Füllung als restylebarer Default (neutrales Grau); Umriss bleibt Kategorie.
      if (contour.filled && geom.shape === "polyline") {
        drawing.fillColor = DXF_HATCH_FILL;
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

/** Gesamtzahl der Konturen über alle Sätze (für die Datei-Zusammenfassung). */
export function countContours(sets: ContourSet[]): number {
  return sets.reduce((sum, s) => sum + s.contours.length, 0);
}
