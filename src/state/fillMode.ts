// Füllart eines geschlossenen 2D-Elements: Keine / Vollfläche / Schraffur.
// Reine Umrechnung auf die vorhandenen Felder (`background`, `fillColor`, `hatchId`
// samt Quellen) — der Renderer (`addDrawing2D`) braucht kein neues Feld.

import type { Drawing2D, HatchStyle } from "../model/types";

export type FillMode = "none" | "solid" | "hatch";

/** Vorgabe-Füllfarbe, wenn "Vollfläche" gewählt wird und noch keine gesetzt ist. */
export const DEFAULT_SOLID_FILL = "#d9dde2";

export function applyFillMode(d: Drawing2D, hatches: readonly HatchStyle[], mode: FillMode): Drawing2D {
  const next = { ...d } as Drawing2D & Record<string, unknown>;
  if (mode === "none") {
    delete next.background;
    delete next.fillColor;
    delete next.hatchId;
    next.backgroundSource = "object";
    next.hatchSource = "object";
  } else if (mode === "solid") {
    next.background = d.background ?? d.fillColor ?? DEFAULT_SOLID_FILL;
    next.backgroundSource = "object";
    delete next.hatchId;
    next.hatchSource = "object";
  } else {
    const current = hatches.find((h) => h.id === d.hatchId);
    const keep = current && current.pattern !== "none" ? current.id : hatches.find((h) => h.pattern !== "none")?.id;
    if (keep) next.hatchId = keep;
    next.hatchSource = "object";
  }
  return next as Drawing2D;
}
