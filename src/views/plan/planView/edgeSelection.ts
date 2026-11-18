// [288] Kantenauswahl im Grundriss (Vectorworks-Arbeitsweise): der Anfasser zum Parallelverschieben erscheint nicht
// mehr an allen Kanten, sondern erst an EINER gewählten Kante. Ablauf: Element wählen → zweiter Klick auf eine seiner
// Kanten markiert sie (hervorgehoben + Anfasser) → Anfasser ziehen (Fang, getippter Abstand) → Esc hebt die
// Kantenauswahl auf. Reine Logik (Schlüssel, Treffer, Zustandsübergänge), die Ansicht hält nur den Schlüssel.

import type { EdgeGrip, Vec2 } from "../../../model/types";

/** Bildschirm-Toleranz (px) für den Klick auf eine Kante. */
export const EDGE_PICK_PX = 6;

/** Stabiler Schlüssel einer Kante: Eigentümer (Mehrfachauswahl) + Eckpunkt-Indizes. */
export function edgeKey(e: EdgeGrip): string {
  return `${e.owner?.wallId ?? ""}|${e.owner?.drawingId ?? ""}|${e.aIndex}|${e.bIndex}`;
}

/** Abstand Punkt → Strecke (gleiche Einheit wie die Eingaben). */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Kante unter dem Klick: nächste Kante, deren Strecke (am Bildschirm) höchstens `tolPx` vom Klick entfernt ist.
 * `toClient` rechnet Modell-Meter in Client-Pixel. Kanten ohne Endpunkte werden übergangen.
 */
export function edgeHitAt(
  edges: readonly EdgeGrip[] | undefined,
  toClient: (v: Vec2) => Vec2,
  click: Vec2,
  tolPx: number = EDGE_PICK_PX,
): EdgeGrip | null {
  if (!edges) return null;
  let best: EdgeGrip | null = null;
  let bestD = tolPx;
  for (const e of edges) {
    if (!e.a || !e.b) continue;
    const d = distToSeg(click, toClient(e.a), toClient(e.b));
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Ergebnis eines Übergangs: neuer Schlüssel + ob das Ereignis verbraucht ist (kein Auswählen/Esc-Aufheben mehr). */
export interface EdgeSelStep {
  key: string | null;
  consumed: boolean;
}

/**
 * Zustandsübergang der Kantenauswahl.
 * - `click` mit Kante: neue Kante wählen (verbraucht den Klick); dieselbe Kante erneut: nicht verbraucht (der
 *   Klick läuft weiter, z. B. zum Durchschalten überlagerter Objekte), Kante bleibt.
 * - `click` ohne Kante: Kantenauswahl aufheben, Klick nicht verbraucht (normales Wählen).
 * - `escape`: hebt eine bestehende Kantenauswahl auf und verbraucht die Taste (die Elementauswahl bleibt).
 * - `edges`: die aktuellen Kanten der Auswahl; fehlt die gewählte Kante darin, ist sie weg.
 */
export function edgeSelStep(
  cur: string | null,
  ev: { kind: "click"; hit: EdgeGrip | null } | { kind: "escape" } | { kind: "edges"; edges: readonly EdgeGrip[] | undefined },
): EdgeSelStep {
  switch (ev.kind) {
    case "click": {
      if (!ev.hit) return { key: null, consumed: false };
      const k = edgeKey(ev.hit);
      return k === cur ? { key: cur, consumed: false } : { key: k, consumed: true };
    }
    case "escape":
      return cur ? { key: null, consumed: true } : { key: null, consumed: false };
    case "edges":
      return { key: cur && ev.edges?.some((e) => edgeKey(e) === cur) ? cur : null, consumed: false };
  }
}

/** Die gewählte Kante in den aktuellen Kanten-Griffen (oder null). */
export function selectedEdgeOf(edges: readonly EdgeGrip[] | undefined, key: string | null): EdgeGrip | null {
  if (!key || !edges) return null;
  return edges.find((e) => edgeKey(e) === key) ?? null;
}
