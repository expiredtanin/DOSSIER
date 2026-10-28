// PDF-Strichmuster → Linienstile ([76], Operator `d`). Der PDF-Import liefert je Ebene ein Muster in
// Papier-mm (`DxfImportResult.layerDashes`); hier wird es einem vorhandenen Linienstil mit gleichem
// Muster zugeordnet oder als neuer Strichmuster-Stil angelegt. Ohne Änderung am Modell: ein
// `LineStyle` mit `dash` (mm Papier, an/aus/an/aus) ist schon vorgesehen, das Drawing2D trägt
// `lineStyleId`. Das Muster hängt nicht vom Plan-Massstab ab (Papier-mm wie im PDF).

import type { LineStyle } from "../model/types";
import { t } from "../i18n";
import { pdfDashLabel } from "./pdfVector";

/** Relative bzw. absolute (mm) Toleranz beim Vergleich zweier Muster. */
const REL_TOL = 0.15;
const ABS_TOL = 0.06;

/** Gleiches Muster (gleiche Länge, jedes Glied innerhalb der Toleranz)? */
export function sameDash(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= Math.max(ABS_TOL, REL_TOL * Math.max(v, b[i])));
}

export interface DashStylePlan {
  /** Neu anzulegende Linienstile (am Projekt anhängen, bevor die Zeichnungen verweisen). */
  created: LineStyle[];
  /** Ebenenname → Linienstil-Id (vorhanden oder neu). */
  styleByLayer: Map<string, string>;
}

/** Ordnet jedem Muster einen Linienstil zu; gleiche Muster teilen sich einen. */
export function planDashLineStyles(
  layerDashes: Readonly<Record<string, number[]>> | undefined,
  existing: readonly LineStyle[],
): DashStylePlan {
  const created: LineStyle[] = [];
  const styleByLayer = new Map<string, string>();
  if (!layerDashes) return { created, styleByLayer };
  const usedIds = new Set(existing.map((l) => l.id));
  for (const [layer, dash] of Object.entries(layerDashes)) {
    if (dash.length < 2) continue;
    const known = [...existing, ...created].find(
      (l) => (l.kind ?? "dash") === "dash" && l.dash !== null && sameDash(l.dash, dash),
    );
    if (known) {
      styleByLayer.set(layer, known.id);
      continue;
    }
    const label = pdfDashLabel(dash);
    const base = `pdf-dash-${label.replace(/[^0-9a-z]+/gi, "_")}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    // Haarlinien-Default wie bei neuen Linienstilen; Strichstärke und Farbe kommen von der Ebene.
    created.push({ id, name: t("import.pdf.dashStyleName", { pattern: label }), weight: 0.02, color: "#1a1a1a", dash: [...dash] });
    styleByLayer.set(layer, id);
  }
  return { created, styleByLayer };
}
