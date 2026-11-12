// [193] Netzpunkte (Gelände/Netz) im Grundriss: welche bekommen Griffe, welcher liegt unter dem Zeiger.
// Reine Hilfen auf der flachen `positions`-Liste (x, y, z, …); Bearbeiten selbst läuft über Kern-Ops/-Befehle.

export interface MeshRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Nummern der Netzpunkte, die einen Griff bekommen: alle bis `cap` Punkte; bei grösseren Netzen die Punkte im Ausschnitt
 * `rect` (Modell-Meter), die `cap` der Ausschnittsmitte nächsten. `always` (z. B. der aktive Punkt) bleibt dabei.
 * Ohne Ausschnitt und über `cap` Punkten: leer.
 */
export function meshGripIndices(positions: ArrayLike<number>, rect: MeshRect | null, cap: number, always: number | null = null): number[] {
  const n = Math.floor(positions.length / 3);
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  if (!rect) return [];
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const inside: { i: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) inside.push({ i, d: (x - cx) ** 2 + (y - cy) ** 2 });
  }
  if (inside.length > cap) {
    inside.sort((a, b) => a.d - b.d);
    inside.length = cap;
  }
  const out = inside.map((q) => q.i).sort((a, b) => a - b);
  if (always != null && always >= 0 && always < n && !out.includes(always)) out.push(always);
  return out;
}

/** Ausschnitt um `margin` (Anteil der Kantenlänge je Seite) vergrössert, damit kleines Schwenken die Griffe nicht erneuert. */
export function growRect(r: MeshRect, margin: number): MeshRect {
  const dx = (r.x1 - r.x0) * margin;
  const dy = (r.y1 - r.y0) * margin;
  return { x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** Nummer des Netzpunkts, der `pt` am nächsten liegt (höchstens `tol` Meter entfernt), sonst `null`. */
export function nearestMeshVertex(positions: ArrayLike<number>, pt: { x: number; y: number }, tol: number): number | null {
  const n = Math.floor(positions.length / 3);
  let best: number | null = null;
  let bd = tol * tol;
  for (let i = 0; i < n; i++) {
    const d = (positions[3 * i] - pt.x) ** 2 + (positions[3 * i + 1] - pt.y) ** 2;
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Klick-Toleranz für Netzpunkte: 2 % der Netzdiagonale, mindestens 5 cm (wie `toleranceFor` der Umrisse). */
export function meshTolerance(positions: ArrayLike<number>): number {
  const n = Math.floor(positions.length / 3);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, positions[3 * i]);
    maxX = Math.max(maxX, positions[3 * i]);
    minY = Math.min(minY, positions[3 * i + 1]);
    maxY = Math.max(maxY, positions[3 * i + 1]);
  }
  if (!Number.isFinite(minX)) return 0.05;
  return Math.max(0.05, Math.hypot(maxX - minX, maxY - minY) * 0.02);
}
