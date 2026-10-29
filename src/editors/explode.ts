// Auflösen (Explode) — zerlegt zusammengesetzte 2D-Elemente in ihre Einzelteile. Rechnet der Kern
// ([K4] S3, `src-tauri/core/src/cmd_edit.rs::explode_ops`); hier die Fassade.
//
// Was zerlegt wird:
//   • Block-Instanz → die Teilgeometrien der Definition, mit Drehung und
//     Einfügepunkt der Instanz verrechnet.
//   • Polylinie   → ein Element je Segment: Gerade zu `line`, ein Bogen-Segment
//     (`bulge`) zu einem ECHTEN `arc` — der Bogen darf beim Auflösen nicht zur
//     Sehne zusammenfallen.
//   • Rechteck    → vier Linien.
//
// Bewusst NICHT zerlegt (kein sinnvolles „Einzelteil", das die Form erhielte):
// Kreis, Ellipse, Spline, Bezier, Text, Bemassung, Bild — sie bleiben
// unverändert stehen. Ebenso alles, was kein 2D-Element ist.

import type { Project } from "../model/types";
import type { CoreOp } from "../core";
import { documentFor } from "../core/document";
import { uniqueStamp } from "../tools/types";

/**
 * Löst die angegebenen 2D-Elemente auf: jedes zerlegbare Element wird durch
 * seine Einzelteile ERSETZT (gleiche Ebene/Kategorie und alle Stil-
 * Übersteuerungen bleiben erhalten), nicht zerlegbare bleiben unangetastet.
 * Die Teile stehen an der Stelle des Originals (Zeichenreihenfolge bleibt).
 */
export function explodeOps(project: Project, ids: readonly string[]): CoreOp[] {
  return documentFor(project).cmdOps({ cmd: "explode", ids, stamp: uniqueStamp() });
}
