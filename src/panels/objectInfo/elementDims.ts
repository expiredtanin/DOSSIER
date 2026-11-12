// [204a] Masse je Element-Art für den Abschnitt „Maße" der Objekt-Info. Die Bounding-Box taugt nur für
// freie Formen: bei einer Wand ist sie das Rechteck der Achse (Breite 0 bei senkrechter Wand), bei einer
// Öffnung die Lücke im Wandgrundriss (Höhe = Wanddicke). Darum zeigen Wand und Öffnung ihre echten
// Masse (nur Anzeige; geändert wird in den Bauteil-Abschnitten).

import type { TranslationKey } from "../../i18n";
import type { SelectionInfo } from "../../state/selectionInfo";

export interface ElementDim {
  label: TranslationKey;
  /** Meter. */
  value: number;
}

/** Sinnvolle Masse der Art, `null` = generische Bounding-Box-Breite/-Höhe. */
export function elementDimensions(sel: SelectionInfo): ElementDim[] | null {
  if (sel.kind === "wall" && sel.wall) {
    const w = sel.wall;
    return [
      { label: "objinfo.wall.length", value: w.length },
      { label: "objinfo.wall.thickness", value: w.thickness },
      { label: "objinfo.wall.height", value: w.zTop - w.zBottom },
    ];
  }
  if (sel.kind === "opening" && sel.opening) {
    const o = sel.opening;
    return [
      { label: "objinfo.opening.width", value: o.width },
      { label: "objinfo.opening.height", value: o.height },
      { label: "objinfo.opening.sill", value: o.sillHeight },
    ];
  }
  return null;
}
