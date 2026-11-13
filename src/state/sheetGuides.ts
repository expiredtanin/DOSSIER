// Hilfslinien des Layout-Blatts ([208]) speichern: sie hängen am Masterlayout (`MasterLayout.guides`), gelten also für
// alle Blätter mit diesem Master. Änderung nur über Ops (`patchItem`).

import type { LayoutGuide, Project } from "../model/types";
import { patchItem } from "../core";
import type { CoreOp } from "../core";

/** Ops, die die Hilfslinien des Masters von Blatt `layoutId` setzen (leer: kein Master oder nichts geändert). */
export function setSheetGuidesOps(p: Project, layoutId: string, guides: LayoutGuide[]): CoreOp[] {
  const lay = (p.layouts ?? []).find((l) => l.id === layoutId);
  const m = (p.masterLayouts ?? []).find((x) => x.id === lay?.masterId);
  if (!m) return [];
  return patchItem(p, "masterLayouts", m.id, { guides: guides.length > 0 ? guides : undefined });
}
