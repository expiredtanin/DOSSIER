// [205] Pausfolie: Aktionen auf dem Store (Kürzel, Menü, Statusleiste, Navigator-Kontextmenü, Befehle
// `tracemove`/`tracerotate`). Die Logik selbst ist rein (`traceRef.ts`); hier nur Lesen/Schreiben von `trace`.

import type { TraceReference, Vec2 } from "../model/types";
import { getState } from "./appStore";
import { registerSelectionActions } from "./selectionActions";
import { moveTrace, resetTracePosition, rotateTrace, showAsTrace, toggleTrace } from "./traceRef";

/** Pausfolie der aktiven Ansicht ein/aus (Kürzel Cmd/Ctrl+Shift+T). */
export function toggleTraceAction(): void {
  const s = getState();
  const active = s.project.drawingLevels.find((l) => l.id === s.activeLevelId);
  s.setTrace(toggleTrace(s.trace, s.project, active));
}

/** „Als Pausfolie zeigen" (Navigator): Ebene `id` als Pause der aktiven Ansicht. */
export function showAsTraceAction(id: string): void {
  const s = getState();
  s.setTrace(showAsTrace(s.trace, id));
}

/** Eingeschaltete Pausfolie oder null. */
export function shownTrace(): TraceReference | null {
  const t = getState().trace;
  return t?.show ? t : null;
}

/** Felder der Pausfolie ändern (Farbe, Deckkraft, Lage …), sofern eine gesetzt ist. */
export function patchTraceAction(patch: Partial<TraceReference>): void {
  const s = getState();
  if (s.trace) s.setTrace({ ...s.trace, ...patch });
}

export function moveTraceAction(d: Vec2): void {
  const t = getState().trace;
  if (t) getState().setTrace(moveTrace(t, d));
}

export function rotateTraceAction(c: Vec2, deg: number): void {
  const t = getState().trace;
  if (t) getState().setTrace(rotateTrace(t, c, deg));
}

export function resetTraceAction(): void {
  const t = getState().trace;
  if (t) getState().setTrace(resetTracePosition(t));
}

// Natives Menü (Ansicht → Pausfolie ein/aus) ruft die Aktion über die Ablage der Mehrfach-Eingänge.
registerSelectionActions({ toggleTrace: toggleTraceAction });
