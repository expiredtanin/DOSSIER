// Ursprungs-Verschiebung des GESAMTEN Projekts (Neuer Bezugspunkt) — reine,
// verlustfreie Translation aller Modell-Koordinaten um einen festen Vektor
// (dx,dy). Genutzt, um nach einem Kataster-/3D-Import (der weit weg vom
// Modell-Ursprung landen kann, s. `Project.geoAnchor`) einen neuen, praktischen
// Bezugspunkt zu setzen: die komplette Zeichnung wandert relativ zueinander
// unverändert, nur ihre absoluten Koordinaten verschieben sich. `geoAnchor`
// (falls gesetzt) wandert MIT, sodass der LV95-Bezug exakt erhalten bleibt —
// beim Export ist die Verschiebung damit jederzeit rekonstruierbar.
//
// Bewusst NUR Translation (keine Rotation): mehrere Felder im Modell sind an
// die Achsen gebunden (z. B. `Roof.ridgeAxis: "x"|"y"`) und mehrere Winkel-Felder
// (Column.rotation, Text-/Bild-Rotation, Tür-Schwenk) müssten bei einer Drehung
// mitgeführt werden — eine Rotation ist ein eigener, grösserer Schritt.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  ContextObject,
  Contour,
  Project,
  Vec2,
} from "./types";

const shift = (p: Vec2, dx: number, dy: number): Vec2 => ({ x: p.x + dx, y: p.y + dy });
const shiftAll = (pts: Vec2[], dx: number, dy: number): Vec2[] => pts.map((p) => shift(p, dx, dy));

/** Kontur (Höhenlinie): Punkte + optionale Kreis-/Bogen-Mitte verschieben. */
function shiftContour(c: Contour, dx: number, dy: number): Contour {
  return {
    ...c,
    pts: shiftAll(c.pts, dx, dy),
    curve: c.curve ? { ...c.curve, cx: c.curve.cx + dx, cy: c.curve.cy + dy } : undefined,
  };
}

/**
 * Kontext-Objekt (importiertes Mesh/Terrain/Konturen-Satz) verschieben.
 * `positions` ist ein flaches [x,y,z=Höhe, …]-Array — nur x/y (Grundriss)
 * verschieben, die Höhe (z) bleibt unverändert.
 */
function shiftContextObject(obj: ContextObject, dx: number, dy: number): ContextObject {
  if (obj.type === "contourSet") {
    return { ...obj, contours: obj.contours.map((c) => shiftContour(c, dx, dy)) };
  }
  if (obj.type === "image") {
    return { ...obj, min: shift(obj.min, dx, dy), max: shift(obj.max, dx, dy) };
  }
  const positions = obj.positions.slice();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    positions[i] += dx;
    positions[i + 1] += dy;
  }
  return { ...obj, positions };
}

/**
 * Verschiebt SÄMTLICHE Modell-Koordinaten eines Projekts um den festen Vektor
 * (dx,dy) — Wände, Decken, Dächer, Öffnungen-Host (folgt automatisch der Wand),
 * Treppen, Räume, Stützen, Extrusionen, freie 2D-Geometrie, Kontext-Schicht
 * (Import/Terrain/Konturen), Schnitt-/Ansichtslinien sowie den Geo-Anker
 * (`geoAnchor.model`, damit der LV95-Bezug exakt erhalten bleibt). Richtungs-
 * Vektoren (z. B. `Stair.dir`) und Winkel-Felder bleiben unangetastet — eine
 * reine Translation ändert keine Orientierung.
 */
export function translateProject(project: Project, dx: number, dy: number): Project {
  if (dx === 0 && dy === 0) return project;
  return {
    ...project,
    walls: project.walls.map((w) => ({
      ...w,
      start: shift(w.start, dx, dy),
      end: shift(w.end, dx, dy),
    })),
    ceilings: project.ceilings?.map((c) => ({
      ...c,
      outline: shiftAll(c.outline, dx, dy),
      openings: c.openings?.map((h) => shiftAll(h, dx, dy)),
    })),
    roofs: project.roofs?.map((r) => ({ ...r, outline: shiftAll(r.outline, dx, dy) })),
    stairs: project.stairs?.map((s) => ({
      ...s,
      start: shift(s.start, dx, dy),
      center: s.center ? shift(s.center, dx, dy) : undefined,
    })),
    rooms: project.rooms?.map((r) => ({
      ...r,
      boundary: shiftAll(r.boundary, dx, dy),
      stampAnchor: r.stampAnchor ? shift(r.stampAnchor, dx, dy) : undefined,
    })),
    columns: project.columns?.map((c) => ({ ...c, position: shift(c.position, dx, dy) })),
    extrudedSolids: project.extrudedSolids?.map((s) => ({
      ...s,
      points: shiftAll(s.points, dx, dy),
      circle: s.circle ? { ...s.circle, center: shift(s.circle.center, dx, dy) } : undefined,
    })),
    drawings2d: project.drawings2d.map((d) => {
      const g = d.geom;
      switch (g.shape) {
        case "line":
          return { ...d, geom: { ...g, a: shift(g.a, dx, dy), b: shift(g.b, dx, dy) } };
        case "polyline":
          return { ...d, geom: { ...g, pts: shiftAll(g.pts, dx, dy) } };
        case "rect":
          return { ...d, geom: { ...g, min: shift(g.min, dx, dy), max: shift(g.max, dx, dy) } };
        case "circle":
          return { ...d, geom: { ...g, center: shift(g.center, dx, dy) } };
        case "arc":
          return { ...d, geom: { ...g, center: shift(g.center, dx, dy) } };
        case "ellipse":
          return { ...d, geom: { ...g, center: shift(g.center, dx, dy) } };
        case "bezier":
          return { ...d, geom: { ...g, pts: shiftAll(g.pts, dx, dy) } };
        case "spline":
          return { ...d, geom: { ...g, pts: shiftAll(g.pts, dx, dy) } };
        case "dimension":
          return { ...d, geom: { ...g, pts: shiftAll(g.pts, dx, dy) } };
        case "kote":
          return { ...d, geom: { ...g, at: shift(g.at, dx, dy) } };
        case "text":
          return { ...d, geom: { ...g, at: shift(g.at, dx, dy) } };
        case "image":
          return { ...d, geom: { ...g, min: shift(g.min, dx, dy), max: shift(g.max, dx, dy) } };
      }
    }),
    context: project.context?.map((o) => shiftContextObject(o, dx, dy)),
    drawingLevels: project.drawingLevels.map((lvl) =>
      lvl.linePoints
        ? { ...lvl, linePoints: [shift(lvl.linePoints[0], dx, dy), shift(lvl.linePoints[1], dx, dy)] }
        : lvl,
    ),
    geoAnchor: project.geoAnchor
      ? { ...project.geoAnchor, model: shift(project.geoAnchor.model, dx, dy) }
      : undefined,
  };
}

/**
 * Der LV95-Ursprung eines Projekts: die reale Landeskoordinate, die auf den
 * Modell-Nullpunkt (0,0) abgebildet wird. Aus `geoAnchor` abgeleitet
 * (`origin = lv95 − model`), oder `null`, wenn KEIN Standort-Bezug existiert.
 */
export function projectGeoOrigin(project: Project): { e: number; n: number } | null {
  const a = project.geoAnchor;
  if (!a) return null;
  return { e: a.lv95.e - a.model.x, n: a.lv95.n - a.model.y };
}

/**
 * Kopie des Projekts mit SÄMTLICHER Geometrie auf die REALEN Weltkoordinaten
 * (LV95) verschoben — für georeferenzierte MODELL-Exporte (IFC/DXF): das Modell
 * wird lokal nahe (0,0) bearbeitet, der Export schreibt aber die wahren
 * Landeskoordinaten, damit die Datei in anderer CAD-/BIM-Software lagerichtig
 * sitzt. Ohne `geoAnchor` (kein Bezug) bleibt das Projekt unverändert (Identität).
 * NICHT für Papier-/Layout-Exporte (die bleiben in lokalen Koordinaten).
 */
export function projectToWorldCoords(project: Project): Project {
  const origin = projectGeoOrigin(project);
  if (!origin) return project;
  return translateProject(project, origin.e, origin.n);
}
