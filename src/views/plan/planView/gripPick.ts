// Griff-Treffer im Plan ([333]): der NÄCHSTE Griff gewinnt, nicht der erste im Radius. Bei einer kleinen Stütze
// (12 cm) liegen die Eck-Griffe nur etwa 7 px vom Mittelgriff; die Liste führt den Mittel-/Verschiebe-Griff an
// Index 0, die Ecken folgen — der alte „erster Treffer"-Test nahm deshalb auch beim Klick auf eine Ecke die Mitte.

/** Abstand (px), innerhalb dessen zwei Griffe als gleich nah gelten (dann gewinnt der spätere: Ecke statt Mitte). */
export const GRIP_TIE_PX = 2;

/**
 * Index des Griffs, dessen Mittelpunkt dem Zeiger am nächsten liegt und höchstens `hitPx` entfernt ist; sonst null.
 * Liegen mehrere Griffe praktisch gleich nah (Unterschied ≤ {@link GRIP_TIE_PX}), gilt der mit dem höheren Index —
 * die Listen der Bauteile führen den Verschiebe-Griff (Mitte) vorn, Ecken/Eckpunkte dahinter.
 */
export function pickGripIndex(centers: readonly { x: number; y: number }[], px: number, py: number, hitPx: number): number | null {
  const d = centers.map((c) => Math.hypot(c.x - px, c.y - py));
  let minD = Infinity;
  for (const x of d) if (x <= hitPx && x < minD) minD = x;
  if (!Number.isFinite(minD)) return null;
  let best: number | null = null;
  for (let i = 0; i < d.length; i++) if (d[i] <= hitPx && d[i] <= minD + GRIP_TIE_PX) best = i;
  return best;
}
