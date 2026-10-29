// Reine Text-Formatierung des Cursor-HUDs (L/W- bzw. Δx/Δy-Anzeige, VW-Stil,
// s. `plan/planView/overlays.tsx::DraftHud`) — als eigenes Modul extrahiert,
// damit die 3D-Ansicht (`viewport/Wasm3DViewport.tsx`) exakt dieselbe
// Beschriftung/Rundung/Live-Tipp-Logik zeigt wie der 2D-Plan, statt einer
// eigenen (potenziell abweichenden) Zweitimplementierung. Keine DOM-/SVG-
// Abhängigkeit — reine Werte rein, Segmente raus.

import type { ToolDraft } from "./types";
import { NON_LENGTH_FIELDS } from "../commands/parseInput";
import { MODEL_UNITS, dyToDisplay, fmtDisplay, lengthToDisplay, type DisplayUnits } from "./displayUnits";

/** Ein Segment des Cursor-HUDs (z. B. "L: 3.000m"), + Tab-Zyklus-Zustand. */
export interface HudSeg {
  text: string;
  active: boolean;
  locked: boolean;
}

/** Tab-Feld-Zyklus-Zustand der Befehlszeile (s. `ui/CommandLine.tsx`). */
export interface HudFieldsState {
  fields: { id: string; value: number | null; locked: boolean; active: boolean }[];
  typed: string;
}

/**
 * Berechnet die anzuzeigenden HUD-Segmente aus `draft.hud` + optionalem
 * Tab-Feld-Zyklus-Zustand (`hudFields`, s. `CommandLine`). Mit Feldern
 * spiegelt jedes Segment dessen Live-/Lock-/Tipp-Zustand (VW-Verhalten: der
 * getippte Text erscheint sofort im aktiven Feld); ohne Felder fällt es auf
 * die einfache Δx/Δy- bzw. L/W-Anzeige zurück, zuletzt auf `hud.text`.
 * Leeres Array = kein HUD zu zeichnen.
 */
export function hudSegments(
  hud: NonNullable<ToolDraft["hud"]>,
  hudFields: HudFieldsState | null,
  /** Anzeige-Einheiten der Längen (Layout-Blatt: Papier-mm, Δy nach unten, [93]). */
  units: DisplayUnits = MODEL_UNITS,
): HudSeg[] {
  const len = (m: number): string => fmtDisplay(units, lengthToDisplay(units, m));
  const u = units.suffix;
  const liveFor = (id: string): number | null =>
    id === "length"
      ? (hud.length ?? null)
      : id === "angle"
        ? (hud.angleDeg ?? null)
        : id === "width"
          ? (hud.dx ?? null)
          : id === "height"
            ? (hud.dy ?? null)
            : null;
  const labelFor = (id: string): string =>
    id === "length" ? "L" : id === "angle" ? "W" : id === "width" ? "Δx" : id === "height" ? "Δy" : id;
  const segs: HudSeg[] = [];
  if (hudFields && hudFields.fields.length > 0) {
    for (const f of hudFields.fields) {
      const label = labelFor(f.id);
      const isLength = !NON_LENGTH_FIELDS.has(f.id);
      const unit = f.id === "angle" ? "°" : isLength ? u : "";
      const typedHere = f.active && hudFields.typed.trim() !== "";
      const fmt = (v: number): string => (f.id === "height" ? fmtDisplay(units, dyToDisplay(units, v)) : isLength ? len(v) : v.toFixed(3));
      const live = liveFor(f.id);
      const value = typedHere ? hudFields.typed : f.value != null ? fmt(f.value) : live != null ? fmt(live) : "—";
      segs.push({ text: `${label}: ${value}${unit}`, active: f.active, locked: f.locked });
    }
    return segs;
  }
  if (hud.dx != null && hud.dy != null) {
    segs.push({ text: `Δx: ${len(hud.dx)}${u}`, active: false, locked: false });
    segs.push({ text: `Δy: ${fmtDisplay(units, dyToDisplay(units, hud.dy))}${u}`, active: false, locked: false });
  } else if (hud.length != null && hud.angleDeg != null) {
    segs.push({ text: `L: ${len(hud.length)}${u}`, active: false, locked: false });
    segs.push({ text: `W: ${hud.angleDeg.toFixed(3)}°`, active: false, locked: false });
  } else if (hud.text) {
    segs.push({ text: hud.text, active: false, locked: false });
  }
  return segs;
}
