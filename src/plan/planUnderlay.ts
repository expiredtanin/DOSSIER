// Grundriss-Unterlage in Schnitt/Ansicht: ein Geschoss-Grundriss wird
// AUSGERICHTET unter die Schnitt-/Ansichtsfläche gelegt — wie die klassische
// Konstruktion "Ansicht über dem Grundriss". Die Schnittlinie wird dazu
// waagrecht gedreht, die Blickrichtung zeigt im Blatt nach OBEN (Betrachter
// steht unten, die gesehene Fassade liegt an der Unterkante des Grundrisses),
// und die u-Achse stimmt exakt mit der des Schnitts/der Ansicht überein
// (`sectionUAxisModel`, im Kern `Plane::u_model` bzw. der Ansichts-Rahmen): ein Punkt im Grundriss liegt also
// senkrecht unter seiner Projektion im Schnitt.
//
// Reine Starrkörper-Abbildung (Drehung + Verschiebung, keine Spiegelung) —
// Kreise bleiben Kreise, Bögen behalten ihren Drehsinn.

import type { DrawingLevel, DrawingLevelKind, Vec2 } from "../model/types";
import type { Primitive } from "./generatePlan";

/** Abstand (Meter) zwischen tiefster Schnitt-/Ansichtskante und Grundriss-Oberkante. */
export const PLAN_UNDERLAY_GAP_M = 1.5;

/** Abbildung Grundriss (Modell x/y) → Schnitt-Blatt (u, Höhe). */
export interface PlanToSectionMap {
  /** Ursprung = Startpunkt der Schnittlinie. */
  p0: Vec2;
  /** Horizontale Schnitt-u-Achse im Grundriss (Blickrichtungs-RECHTS). */
  u: Vec2;
  /** Blickrichtung im Grundriss (Einheit). */
  n: Vec2;
  /** Drehwinkel (Radiant, CCW) der Abbildung. */
  theta: number;
  /** Vertikaler Versatz im Blatt. */
  dy: number;
}

/**
 * Baut die Abbildung aus der Schnitt-/Ansichtslinie einer Ebene (`null` ohne
 * Linie). `dy` bleibt 0 — der Aufrufer schiebt den Grundriss danach unter den
 * Schnitt (s. {@link planUnderlayPrimitives}).
 */
export function planToSectionMap(level: DrawingLevel): PlanToSectionMap | null {
  const line = level.linePoints;
  if (!line) return null;
  const [p0, p1] = line;
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (len < 1e-9) return null;
  const dx = (p1.x - p0.x) / len;
  const dy = (p1.y - p0.y) / len;
  const sign = level.directionSign ?? 1;
  // Wie `sectionPlaneFromLevel`: Links-Normale der Linie, per directionSign gedreht.
  const n: Vec2 = { x: -dy * sign, y: dx * sign };
  // Wie `sectionUAxisModel`: u = (n.y, −n.x) — Blickrichtungs-RECHTS.
  const u: Vec2 = { x: n.y, y: -n.x };
  // Bild der x-Achse (1,0) ist (u.x, n.x) → cosθ = u.x, sinθ = n.x.
  return { p0, u, n, theta: Math.atan2(n.x, u.x), dy: 0 };
}

/** Bildet einen Grundriss-Punkt ins Schnitt-Blatt ab. */
export function mapPlanPoint(m: PlanToSectionMap, p: Vec2): Vec2 {
  const rx = p.x - m.p0.x;
  const ry = p.y - m.p0.y;
  return { x: rx * m.u.x + ry * m.u.y, y: rx * m.n.x + ry * m.n.y + m.dy };
}

/**
 * Bildet ein Plan-Primitiv ab. Achsparallele Rasterbilder lassen sich nicht
 * drehen und entfallen (`null`) — ausser die Abbildung ist eine reine
 * Verschiebung.
 */
export function mapPlanPrimitive(m: PlanToSectionMap, pr: Primitive): Primitive | null {
  const P = (p: Vec2) => mapPlanPoint(m, p);
  switch (pr.kind) {
    case "polygon": {
      const hatch = pr.hatch.origin || m.theta !== 0
        ? {
            ...pr.hatch,
            // SVG-Musterwinkel dreht im Uhrzeigersinn (Bildschirm) = −Winkel im Modell.
            angle: pr.hatch.angle - (m.theta * 180) / Math.PI,
            origin: pr.hatch.origin ? P(pr.hatch.origin) : undefined,
          }
        : pr.hatch;
      return { ...pr, pts: pr.pts.map(P), hatch };
    }
    case "line":
      // `motif` ist im Strich-lokalen Raum definiert — dreht mit der Linie mit.
      return { ...pr, a: P(pr.a), b: P(pr.b) };
    case "arc":
      return { ...pr, center: P(pr.center), from: P(pr.from), to: P(pr.to) };
    case "text":
      return { ...pr, at: P(pr.at) };
    case "drawingText":
      return { ...pr, at: P(pr.at), angle: pr.angle + m.theta };
    case "drawingTextPath":
      return { ...pr, pathPts: pr.pathPts.map(P) };
    case "drawingCircle":
      return { ...pr, center: P(pr.center) };
    case "drawingArc":
      return { ...pr, center: P(pr.center), a0: pr.a0 + m.theta, a1: pr.a1 + m.theta };
    case "drawingImage": {
      if (Math.abs(m.theta) > 1e-9) return null;
      const a = P(pr.min);
      const b = P(pr.max);
      return {
        ...pr,
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
      };
    }
  }
}

/** Alle Stützpunkte eines Primitivs (für die Höhenlage der Unterlage). */
function primitivePoints(pr: Primitive): Vec2[] {
  switch (pr.kind) {
    case "polygon": return pr.pts;
    case "line": return [pr.a, pr.b];
    case "arc": return [pr.from, pr.to, pr.center];
    case "text":
    case "drawingText": return [pr.at];
    case "drawingTextPath": return pr.pathPts;
    case "drawingCircle":
    case "drawingArc":
      return [{ x: pr.center.x, y: pr.center.y + pr.r }];
    case "drawingImage": return [pr.min, pr.max];
  }
}

/**
 * Legt die Grundriss-Primitive `planPrims` ausgerichtet unter einen Schnitt/
 * eine Ansicht, deren tiefste Kante bei `sectionMinY` liegt. Die Unterlage ist
 * gedimmt (Referenz) und trägt zusätzlich die Schnittlinie selbst (strichpunk-
 * tiert), damit sichtbar ist, wo geschnitten bzw. von wo geblickt wird.
 */
export function planUnderlayPrimitives(
  level: DrawingLevel,
  planPrims: Primitive[],
  sectionMinY: number,
): Primitive[] {
  const base = planToSectionMap(level);
  if (!base) return [];
  const mapped: Primitive[] = [];
  let maxY = -Infinity;
  for (const pr of planPrims) {
    const q = mapPlanPrimitive(base, pr);
    if (!q) continue;
    for (const p of primitivePoints(q)) if (p.y > maxY) maxY = p.y;
    mapped.push(q);
  }
  // Schnittlinie (w = 0) liegt immer mit in der Unterlage.
  if (0 > maxY) maxY = 0;
  const shift = sectionMinY - PLAN_UNDERLAY_GAP_M - maxY;
  const out: Primitive[] = [];
  for (const q of mapped) {
    const moved = mapPlanPrimitive({ p0: { x: 0, y: 0 }, u: { x: 1, y: 0 }, n: { x: 0, y: 1 }, theta: 0, dy: shift }, q);
    if (moved) out.push({ ...moved, greyed: true } as Primitive);
  }
  const [l0, l1] = level.linePoints!;
  const len = Math.hypot(l1.x - l0.x, l1.y - l0.y);
  out.push({
    kind: "line",
    a: { x: 0, y: shift },
    b: { x: len, y: shift },
    cls: "section-underlay-line",
    weightMm: 0.25,
    dash: [3, 0.8, 0.4, 0.8],
    color: "#8a3b2c",
  });
  return out;
}

/**
 * Welche Fremd-Art-Ebene darf als Unterlage in welcher aktiven Ebene erscheinen?
 * Massgebend ist der Koordinatenraum: Geschoss und freie Zeichnung teilen X/Y,
 * Schnitte/Ansichten messen dagegen Länge×Höhe entlang IHRER Linie. Ein Schnitt
 * im Grundriss (oder ein Grundriss/eine andere Ansicht im Schnitt) lag darum
 * nur zufällig irgendwo und überdeckte den eigentlichen Plan (Nutzer-Report
 * 2026-10-20: Fenster der Ansicht im EG-Grundriss, Raumstempel im Schnitt).
 *  • freie Zeichnung: alles (Kalkierpapier zum Abzeichnen, Nutzer-Wunsch).
 *  • Geschoss: nur freie Zeichnungen (gleicher X/Y-Raum).
 *  • Schnitt/Ansicht: nichts — ein Grundriss kommt dort ausgerichtet über
 *    `DrawingLevel.planUnderlayId` dazu (s. plan/planUnderlay.ts).
 */
export function crossKindOverlayAllowed(active: DrawingLevelKind, other: DrawingLevelKind): boolean {
  if (active === "drawing") return true;
  if (active === "floor") return other === "drawing";
  return false;
}
