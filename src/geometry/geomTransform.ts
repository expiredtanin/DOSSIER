// Punkt-Abbildung von 2D-Zeichengeometrie (Verschieben/Spiegeln/Drehen/Skalieren). Reine
// Geometrie ohne UI — Quelle für Transformations-Befehle, Block-Rendering und den Plan-Generator.

import type { Drawing2DGeom, Vec2 } from "../model/types";


/**
 * Erkennt, ob `fn` die Umlauf-Orientierung umkehrt (Spiegelung) — via
 * Flächenvorzeichen eines Test-Dreiecks unter `fn` (negativ ⇒ Spiegelung).
 * Funktioniert für JEDE Isometrie/Similarity (Move/Rotate/Scale erhalten die
 * Orientierung, Mirror kehrt sie um), ohne dass eine Operation ihre Spiegel-
 * Eigenschaft explizit markieren müsste.
 */
export function reversesOrientation(fn: (p: Vec2) => Vec2): boolean {
  const p0 = fn({ x: 0, y: 0 }), p1 = fn({ x: 1, y: 0 }), p2 = fn({ x: 0, y: 1 });
  return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y) < 0;
}

/** Bildet jeden Punkt einer 2D-Zeichengeometrie unter `fn` ab (Move/Mirror/Rotate/Array + Block-Rendering). */
/**
 * Wie {@link mvGeom}, zusätzlich für eine SKALIERUNG: `mvGeom` bildet nur
 * PUNKTE ab — Radien, Schrifthöhen und der Bemassungs-Abstand sind aber keine
 * Punkte und blieben sonst unverändert stehen (ein Kreis behielte unter einer
 * 2×-Skalierung seinen Radius). Diese Funktion zieht die betroffenen
 * Grössenfelder um denselben Faktor nach.
 *
 * Bewusst NICHT angefasst: `bulge` (ein Formverhältnis, skaleninvariant) und
 * die Papier-mm-Felder von Bemassung/Linienenden — die beziehen sich auf das
 * Blatt, nicht aufs Modell, und dürfen beim Skalieren des Objekts gleich
 * bleiben.
 */
/** Skalierungsfaktor eines `op:"scale"`-Punkte-Tripels bei Interpolation `t`. */
export function scaleFactor(pts: Vec2[], t: number): number {
  const c = pts[0];
  const ref = Math.hypot(pts[1].x - c.x, pts[1].y - c.y) || 1;
  const tgt = Math.hypot(pts[2].x - c.x, pts[2].y - c.y);
  return 1 + (tgt / ref - 1) * t;
}

export const scaleGeom = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2, f: number): Drawing2DGeom => {
  const g = mvGeom(geom, fn);
  switch (g.shape) {
    case "circle":
      return { ...g, r: g.r * f };
    case "arc":
      return { ...g, r: g.r * f };
    case "ellipse":
      return { ...g, rx: g.rx * f, ry: g.ry * f };
    case "dimension":
      // `offset` ist der Normalabstand der Masslinie in Modellmass.
      return { ...g, offset: g.offset * f };
    case "text":
      return {
        ...g,
        height: g.height * f,
        ...(g.width !== undefined ? { width: g.width * f } : {}),
      };
    case "scalebar":
      // Segmentlänge ist eine ECHTE Modell-Distanz (kein Papier-mm-Feld wie
      // bei Kote/Bemassung) — muss bei einer Modell-Skalierung mitwachsen,
      // sonst zeigt der Balken nach dem Skalieren die FALSCHE Distanz an.
      return { ...g, segmentLength: g.segmentLength * f };
    case "block":
      // Blockinstanz-Skalierung (s. Typ-Kommentar in model/types.ts) —
      // ohne diesen Fall wäre der `scale`-Befehl auf eine Blockinstanz ein
      // kompletter No-Op (kein Feld zum Multiplizieren).
      return { ...g, scale: (g.scale ?? 1) * f };
    default:
      return g;
  }
};

export const mvGeom = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2): Drawing2DGeom => {
  switch (geom.shape) {
    case "line":
    case "xline":
    case "ray":
      return { ...geom, a: fn(geom.a), b: fn(geom.b) };
    case "polyline": {
      const pts = geom.pts.map(fn);
      if (!geom.bulge) return { ...geom, pts };
      // Bulge-Vorzeichen ist rein relativ zur Zeichenrichtung definiert (links
      // von a→b) — eine Spiegelung kehrt die Umlauf-Orientierung um und muss
      // daher auch jeden Bogen umkehren, sonst wandert er auf die falsche Seite.
      const bulge = reversesOrientation(fn) ? geom.bulge.map((b) => -b) : geom.bulge;
      return { ...geom, pts, bulge };
    }
    case "rect": {
      // Achsparallel nur bei reiner Verschiebung erhaltbar; sonst → Polylinie.
      const c = [
        geom.min,
        { x: geom.max.x, y: geom.min.y },
        geom.max,
        { x: geom.min.x, y: geom.max.y },
      ].map(fn);
      const axisAligned =
        Math.abs(c[0].y - c[1].y) < 1e-6 &&
        Math.abs(c[1].x - c[2].x) < 1e-6 &&
        Math.abs(c[2].y - c[3].y) < 1e-6;
      if (axisAligned) {
        const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
        return {
          shape: "rect",
          min: { x: Math.min(...xs), y: Math.min(...ys) },
          max: { x: Math.max(...xs), y: Math.max(...ys) },
        };
      }
      return { shape: "polyline", pts: c, closed: true };
    }
    case "circle":
      return { ...geom, center: fn(geom.center) };
    case "arc":
      return { ...geom, center: fn(geom.center) };
    case "ellipse":
      return { ...geom, center: fn(geom.center) };
    case "bezier":
      return { ...geom, pts: geom.pts.map(fn) };
    case "spline":
      return { ...geom, pts: geom.pts.map(fn) };
    case "dimension":
      return { ...geom, pts: geom.pts.map(fn) };
    case "kote":
      return { ...geom, at: fn(geom.at) };
    case "detailref":
      return { ...geom, at: fn(geom.at) };
    case "scalebar":
      return { ...geom, at: fn(geom.at) };
    case "pointmarker":
      return { ...geom, at: fn(geom.at) };
    case "text":
      // Leader-Ziel bzw. Pfadpunkte (Text-entlang-Pfad) müssen mitwandern,
      // sonst zeigt der Pfeil/Pfad nach einem Move/Mirror/Rotate/Array auf die
      // alte Position.
      return {
        ...geom,
        at: fn(geom.at),
        ...(geom.leaderTarget ? { leaderTarget: fn(geom.leaderTarget) } : {}),
        ...(geom.leaderBendPoints ? { leaderBendPoints: geom.leaderBendPoints.map(fn) } : {}),
        ...(geom.pathPts ? { pathPts: geom.pathPts.map(fn) } : {}),
      };
    case "block": {
      // Wie Column: Winkel aus einem transformierten Richtungspunkt zurück-
      // rechnen, damit Rotate/Mirror auch die Instanz-Ausrichtung mitnehmen
      // (nicht nur den Einfügepunkt) — reine Translation liesse die Symbole
      // beim Drehen der Auswahl in der alten Orientierung stehen.
      const tip = { x: geom.at.x + Math.cos(geom.rotation), y: geom.at.y + Math.sin(geom.rotation) };
      const nb = fn(geom.at);
      const nt = fn(tip);
      return { ...geom, at: nb, rotation: Math.atan2(nt.y - nb.y, nt.x - nb.x) };
    }
    case "image": {
      // Wie Text: nur die Position folgt der Transformation (Zentrum wandert
      // dorthin, wo `fn` es abbildet); die Box bleibt achsparallel/unverzerrt —
      // ein Bild kann nicht geschert/rotiert dargestellt werden (kein `angle`-Feld).
      const oldCenter = { x: (geom.min.x + geom.max.x) / 2, y: (geom.min.y + geom.max.y) / 2 };
      const newCenter = fn(oldCenter);
      const dx = newCenter.x - oldCenter.x;
      const dy = newCenter.y - oldCenter.y;
      return {
        ...geom,
        min: { x: geom.min.x + dx, y: geom.min.y + dy },
        max: { x: geom.max.x + dx, y: geom.max.y + dy },
      };
    }
  }
};
