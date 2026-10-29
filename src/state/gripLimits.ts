// Welche gewählten 2D-Zeichnungen Editier-Griffe bekommen (aus `useGripEditing.ts` gelöst, damit
// die Regel ohne React prüfbar ist).
//
// Bei grossen Mehrfachauswahlen (z. B. Rahmen über Katasterdaten) gibt es KEINE Griffe: je
// Stützpunkt ein Eck- und ein Kanten-Griff ergäben zehntausende Griffe und sind bei so vielen
// Punkten nicht bedienbar. Massgebend ist die GESAMTZAHL der Stützpunkte (wenige Objekte können
// riesige Umrisse haben), nicht die Objektzahl. Die Auswahl selbst (Hervorhebung, Verschieben,
// Eigenschaften) bleibt unberührt.
//
// Ein EINZELN gewähltes Element bekommt dagegen immer Griffe, egal wie viele Stützpunkte es hat
// (Fehlerbericht 29.10.: Strassenparzellen und Bodenbedeckungs-Flächen eines Katasters aus DWG haben
// nach dem Tessellieren der Bögen/Schraffur-Ränder schnell über 600 Stützpunkte und waren dann nicht
// mehr editierbar). Die Plan-Ansicht zeichnet bei vielen Griffen nur die sichtbaren
// (`views/plan/planView/gripCull.ts`); das Treffen eines Griffs rechnet über das Array, nicht über DOM.

/** Höchstzahl gewählter Zeichnungen, die bei Mehrfachauswahl noch Griffe bekommen. */
export const MAX_GRIP_DRAWINGS = 50;
/** Höchstzahl Stützpunkte (Summe) einer Mehrfachauswahl, die noch Griffe bekommt. */
export const MAX_GRIP_VERTICES = 600;

/**
 * Die Zeichnungs-Ids, die Griffe bekommen: bei genau einer gewählten Zeichnung immer diese, bei
 * mehreren alle, solange Objekt- und Stützpunkt-Grenze eingehalten sind, sonst keine.
 * `vertexCount(id)` liefert die Griff-Zahl einer Zeichnung (0 für unbekannte Ids).
 */
export function gripDrawingIdsFor(ids: readonly string[], vertexCount: (id: string) => number): string[] {
  if (ids.length <= 1) return [...ids];
  if (ids.length > MAX_GRIP_DRAWINGS) return [];
  let total = 0;
  for (const id of ids) {
    total += vertexCount(id);
    if (total > MAX_GRIP_VERTICES) return [];
  }
  return [...ids];
}
