// [205] Pausfolie je Reiter: reine Zustandslogik (Ein/Aus, Quelle, Verschieben, Drehen, Zurücksetzen).
//
// Die Pausfolie ist UI-Zustand wie Massstab oder Detailgrad: sie lebt im View-Slice (`trace`), geht mit dem
// Reiter (`ViewSnapshotState.trace` → `uiState.viewTabs`) und dem Ausschnitt (`ViewSnapshot.trace`) in die
// Projektdatei und ändert das Modell nie (kein Op, kein Undo-Schritt). Gezeichnet wird sie über `tracePlan`
// (`plan/trace.ts` → Kern `plan/trace.rs`).

import type { DrawingLevel, Project, TraceReference, Vec2 } from "../model/types";
import { defaultTrace, traceSourceAllowed } from "../core";

/** Quelle beim ersten Einschalten ohne Wahl: Geschoss darunter (sonst darüber); im Schnitt/in der Ansicht und in
 *  Zeichnungen das Bezugsgeschoss (±0.00, sonst das erste). */
export function defaultTraceSource(project: Project, active: DrawingLevel): string | null {
  const floors = project.drawingLevels.filter((l) => l.kind === "floor" && traceSourceAllowed(active, l));
  if (active.kind === "floor") {
    const z = (l: DrawingLevel) => l.baseElevation ?? 0;
    const below = floors.filter((l) => z(l) < z(active)).sort((a, b) => z(b) - z(a))[0];
    const above = floors.filter((l) => z(l) >= z(active)).sort((a, b) => z(a) - z(b))[0];
    return (below ?? above)?.id ?? null;
  }
  return (floors.find((l) => l.zeroLevel) ?? floors[0])?.id ?? null;
}

/** Kürzel/Knopf: ein- bzw. ausschalten; ohne bisherige Pausfolie mit der Vorgabe-Quelle. */
export function toggleTrace(t: TraceReference | null, project: Project, active: DrawingLevel | undefined): TraceReference | null {
  if (t) return { ...t, show: !t.show };
  const src = active ? defaultTraceSource(project, active) : null;
  return src ? defaultTrace(src) : null;
}

/** „Als Pausfolie zeigen": Quelle setzen und einschalten; Farbe/Deckkraft/Lage bleiben, Lage nur bei gleicher Quelle. */
export function showAsTrace(t: TraceReference | null, sourceId: string): TraceReference {
  if (!t) return defaultTrace(sourceId);
  if (t.sourceId === sourceId) return { ...t, show: true };
  return { ...t, sourceId, show: true, offset: { x: 0, y: 0 }, rotation: 0 };
}

/** Pause um `d` (Meter) verschieben. */
export function moveTrace(t: TraceReference, d: Vec2): TraceReference {
  return { ...t, offset: { x: t.offset.x + d.x, y: t.offset.y + d.y } };
}

/**
 * Pause um `deg` Grad (CCW) um den Punkt `c` drehen. Die Lage ist p ↦ R(θ)·p + o; die Drehung um c ergibt
 * R(θ+δ)·p + R(δ)·(o − c) + c.
 */
export function rotateTrace(t: TraceReference, c: Vec2, deg: number): TraceReference {
  if (!Number.isFinite(deg) || deg === 0) return t;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const ox = t.offset.x - c.x;
  const oy = t.offset.y - c.y;
  let rotation = (t.rotation + deg) % 360;
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return { ...t, rotation, offset: { x: cos * ox - sin * oy + c.x, y: sin * ox + cos * oy + c.y } };
}

/** Lage zurücksetzen (Ausrichtung des Kerns, ohne Verschieben/Drehen). */
export function resetTracePosition(t: TraceReference): TraceReference {
  return { ...t, offset: { x: 0, y: 0 }, rotation: 0 };
}

/** Wurde die Pause verschoben oder gedreht? */
export function traceMoved(t: TraceReference | null | undefined): boolean {
  return !!t && (t.offset.x !== 0 || t.offset.y !== 0 || t.rotation !== 0);
}
