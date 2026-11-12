// [193] Sichtbarer Ausschnitt des Grundrisses in Modell-Metern, für Griffe grosser Netze (nur Punkte im Bild).
// Die Kamera lebt in `PlanView`; diese kleine Brücke meldet sie (verzögert, damit Schwenken nicht jeden Frame neu
// rechnet) an `useGripEditing`. Kein Zustand im Store: reiner Anzeige-Ausschnitt, ändert das Projekt nie.

import type { MeshRect } from "../core";

let current: MeshRect | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** viewBox (Bild-px, y nach unten, `PX_PER_M` je Meter) → Modell-Rechteck. */
export function viewBoxToMeshRect(v: { x: number; y: number; w: number; h: number }, pxPerM: number): MeshRect {
  return { x0: v.x / pxPerM, x1: (v.x + v.w) / pxPerM, y0: -(v.y + v.h) / pxPerM, y1: -v.y / pxPerM };
}

function sameRect(a: MeshRect | null, b: MeshRect): boolean {
  return !!a && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/** Neuen Ausschnitt melden; Abonnenten erfahren es nach kurzer Ruhe (gleiche Werte = keine Meldung). */
export function publishPlanViewport(r: MeshRect, delayMs = 150): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (sameRect(current, r)) return;
    current = r;
    listeners.forEach((l) => l());
  }, delayMs);
}

export function getPlanViewport(): MeshRect | null {
  return current;
}

export function subscribePlanViewport(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
