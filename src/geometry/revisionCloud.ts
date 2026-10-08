// Revisionswolke (Nutzer-Wunsch: „Keine Revisionswolken/Markup-Werkzeuge") —
// wandelt eine geklickte (Polylinien-artige) Punktfolge in eine „ausgebeulte"
// Kontur um: jedes gerade Segment zwischen zwei aufeinanderfolgenden Punkten
// wird in mehrere gleich lange Teilstücke zerlegt, die JEWEILS als
// Kreisbogen („Beule") statt als Gerade gezeichnet werden — die klassische
// CAD-Revisionswolke.
//
// Bewusst KEIN neuer Shape-Typ: das Ergebnis ist eine ganz normale
// `Drawing2DGeom["polyline"]` mit `bulge` (DXF-Konvention, s. `bulge.ts`) —
// erbt dadurch Rendering/Snapping/Griffe/Export/Transformieren komplett vom
// bereits vorhandenen Polylinien-Pfad, exakt wie bei `polygon.ts`/den
// gerundeten Ecken von `rect.ts`.
//
// Alle Beulen bulgen in die GLEICHE Richtung relativ zur jeweiligen
// Segment-Zeichenrichtung (positives `bulge` = links von a→b, s. bulge.ts) —
// bei einem GEGEN den Uhrzeigersinn geklickten geschlossenen Zug zeigen sie
// dadurch nach AUSSEN (die übliche Optik). Die Umlaufrichtung wird bewusst
// NICHT automatisch erkannt/korrigiert (eigener, grösserer Scope) — zeichnet
// der Nutzer im Uhrzeigersinn, zeigen die Beulen nach innen; einfach in der
// anderen Richtung klicken behebt das.

import type { Vec2 } from "../model/types";

const EPS = 1e-9;

/**
 * `bulge`-Wert EINER Beule — `tan(Δ/4)` für einen Öffnungswinkel Δ ≈ 100°
 * (Δ = 4·atan(0.42)): sichtbar, aber nicht übertrieben rund — der übliche
 * REVCLOUD-Look.
 */
export const REVCLOUD_BULGE = 0.42;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Zerlegt EIN gerades Segment a→b in `n` gleich lange Beulen (Ziel-Bogenlänge
 * `targetArcLen`, mindestens 1 Beule). Liefert die neuen Zwischenpunkte OHNE
 * den Startpunkt `a` (der gehört dem Aufrufer/vorherigen Segment) UND die
 * `n` Bulge-Werte für die `n` neuen Teilsegmente.
 */
function expandSegment(a: Vec2, b: Vec2, targetArcLen: number): { pts: Vec2[]; bulge: number[] } {
  const len = dist(a, b);
  if (len < EPS) return { pts: [], bulge: [] };
  const n = Math.max(1, Math.round(len / Math.max(targetArcLen, EPS)));
  const pts: Vec2[] = [];
  const bulge: number[] = [];
  for (let i = 1; i <= n; i++) {
    pts.push(lerp(a, b, i / n));
    bulge.push(REVCLOUD_BULGE);
  }
  return { pts, bulge };
}

/**
 * Wandelt eine geklickte Punktfolge (offen ODER geschlossen) in die volle
 * Revisionswolken-Kontur um: alle geraden Segmente (inkl. Schluss-Segment bei
 * `closed`) werden zu Beulen-Ketten der Ziel-Bogenlänge `targetArcLen`
 * expandiert. Liefert `null` bei < 2 Punkten (nichts zu zeichnen).
 */
export function revisionCloudPts(
  points: Vec2[],
  closed: boolean,
  targetArcLen: number,
): { pts: Vec2[]; bulge: number[] } | null {
  if (points.length < 2) return null;
  const segCount = closed ? points.length : points.length - 1;
  const outPts: Vec2[] = [points[0]];
  const outBulge: number[] = [];
  for (let s = 0; s < segCount; s++) {
    const a = points[s];
    const b = points[(s + 1) % points.length];
    const { pts, bulge } = expandSegment(a, b, targetArcLen);
    outPts.push(...pts);
    outBulge.push(...bulge);
  }
  // Geschlossen: das letzte expandierte Segment endet exakt am Startpunkt
  // (points[0]) — der doppelte Schlusspunkt fällt weg (der Ring schliesst
  // sich implizit über `closed:true`, wie bei jeder anderen Polylinie).
  if (closed) outPts.pop();
  if (outPts.length < 2) return null;
  return { pts: outPts, bulge: outBulge };
}
