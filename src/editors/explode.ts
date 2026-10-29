// Auflösen (Explode) — zerlegt zusammengesetzte 2D-Elemente in ihre Einzelteile.
// Reine Modell-Funktion, damit sie ohne Befehl/UI testbar bleibt (wie
// `editors/splitJoin.ts`).
//
// Was zerlegt wird:
//   • Block-Instanz → die Teilgeometrien der Definition, mit Drehung und
//     Einfügepunkt der Instanz verrechnet (dieselbe Transformation, mit der
//     der Kern (`plan/drawings.rs`) sie zeichnet).
//   • Polylinie   → ein Element je Segment: Gerade zu `line`, ein Bogen-Segment
//     (`bulge`) zu einem ECHTEN `arc` — der Bogen darf beim Auflösen nicht zur
//     Sehne zusammenfallen.
//   • Rechteck    → vier Linien.
//
// Bewusst NICHT zerlegt (kein sinnvolles „Einzelteil", das die Form erhielte):
// Kreis, Ellipse, Spline, Bezier, Text, Bemassung, Bild — sie bleiben
// unverändert stehen. Ebenso alles, was kein 2D-Element ist.

import type { Drawing2D, Drawing2DGeom, Project, Vec2 } from "../model/types";
import { bulgeArc, replaceWithMany } from "../core";
import type { CoreOp } from "../core";
import { uniqueId } from "../tools/types";

/** Teilgeometrien EINES Elements, oder `null`, wenn es nicht zerlegbar ist. */
export function explodeGeom(geom: Drawing2DGeom, project: Project): Drawing2DGeom[] | null {
  switch (geom.shape) {
    case "block": {
      const def = project.blockDefs?.find((b) => b.id === geom.blockDefId);
      if (!def || def.geom2d.length === 0) return null;
      const c = Math.cos(geom.rotation);
      const s = Math.sin(geom.rotation);
      const xf = (p: Vec2): Vec2 => ({
        x: geom.at.x + p.x * c - p.y * s,
        y: geom.at.y + p.x * s + p.y * c,
      });
      return def.geom2d.map((sub) => mapPoints(sub, xf));
    }

    case "polyline": {
      const n = geom.pts.length;
      if (n < 2) return null;
      const segCount = geom.closed && n > 2 ? n : n - 1;
      const out: Drawing2DGeom[] = [];
      for (let i = 0; i < segCount; i++) {
        const a = geom.pts[i];
        const b = geom.pts[(i + 1) % n];
        const arc = bulgeArc(a, b, geom.bulge?.[i] ?? 0);
        if (arc) {
          // Echter Bogen statt Sehne: Start-/Endwinkel aus dem Kreis, in der
          // Reihenfolge, die der Schwenkrichtung entspricht (a0 → a1 läuft in
          // der `arc`-Form immer gegen den Uhrzeigersinn).
          const forward = arc.sweep >= 0;
          out.push({
            shape: "arc",
            center: arc.center,
            r: arc.r,
            a0: forward ? arc.a0 : arc.a1,
            a1: forward ? arc.a1 : arc.a0,
          });
        } else {
          out.push({ shape: "line", a, b });
        }
      }
      return out;
    }

    case "rect": {
      const { min, max } = geom;
      const c1 = min;
      const c2 = { x: max.x, y: min.y };
      const c3 = max;
      const c4 = { x: min.x, y: max.y };
      return [
        { shape: "line", a: c1, b: c2 },
        { shape: "line", a: c2, b: c3 },
        { shape: "line", a: c3, b: c4 },
        { shape: "line", a: c4, b: c1 },
      ];
    }

    default:
      return null;
  }
}

/** Punkte einer Geometrie durch `fn` schicken (nur für die Block-Teilgeometrie nötig). */
function mapPoints(geom: Drawing2DGeom, fn: (p: Vec2) => Vec2): Drawing2DGeom {
  switch (geom.shape) {
    case "line":
    case "xline":
    case "ray":
      return { ...geom, a: fn(geom.a), b: fn(geom.b) };
    case "polyline":
      return { ...geom, pts: geom.pts.map(fn) };
    case "rect":
    case "image":
      return { ...geom, min: fn(geom.min), max: fn(geom.max) };
    case "circle":
    case "arc":
    case "ellipse":
      return { ...geom, center: fn(geom.center) };
    case "bezier":
    case "spline":
    case "dimension":
      return { ...geom, pts: geom.pts.map(fn) };
    case "text":
    case "kote":
    case "detailref":
    case "scalebar":
    case "pointmarker":
      return { ...geom, at: fn(geom.at) };
    case "block":
      return { ...geom, at: fn(geom.at) };
    default:
      return geom;
  }
}

/**
 * Löst die angegebenen 2D-Elemente auf: jedes zerlegbare Element wird durch
 * seine Einzelteile ERSETZT (gleiche Ebene/Kategorie und alle Stil-
 * Übersteuerungen bleiben erhalten), nicht zerlegbare bleiben unangetastet.
 * Die Reihenfolge im Array bleibt stabil — die Teile stehen an der Stelle des
 * Originals, damit sich die Zeichenreihenfolge (z-Anordnung) nicht ändert.
 */
export function explodeOps(project: Project, ids: readonly string[]): CoreOp[] {
  const wanted = new Set(ids);
  const replacements = new Map<string, Drawing2D[]>();
  for (const d of project.drawings2d) {
    const parts = wanted.has(d.id) ? explodeGeom(d.geom, project) : null;
    if (!parts || parts.length === 0) continue;
    // Stil-Eigenschaften der Quelle übernehmen; nur Identität und Geometrie sind neu. `hatchId`/Füllung
    // bleiben bewusst dran: es geht nichts verloren, falls der Nutzer die Linien wieder schliesst.
    replacements.set(d.id, parts.map((geom): Drawing2D => ({ ...d, id: uniqueId("dr2d"), geom })));
  }
  return replaceWithMany(project, "drawings2d", replacements);
}
