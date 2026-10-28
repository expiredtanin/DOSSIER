// Basismengen (Qto_*BaseQuantities) für den IFC-Export ([B5], 28.10.): Längen, Flächen und Volumen
// aus derselben Geometrie, die in die Datei geschrieben wird — für Kostenplanung (eBKP-H/BKP) und
// Mengenermittlung. Reine Rechnung auf einfachen Eingaben (Bänder, Ringe, Netze), kein Zugriff auf
// das Projekt; `exportIfc.ts` sammelt und ruft sie auf, Rust schreibt die IfcElementQuantity.
//
// Netto = abzüglich Öffnungen (Wand, Decke). Fehlt einer Menge die Grundlage (z. B. Höhe bei schräger
// Wandoberkante: „nur angeben, wenn konstant“), lassen wir sie weg statt zu raten.

import type { Vec2 } from "../model/types";
import type { RWall } from "../plan/toWalls3d";

/** Eine Menge: Name nach IFC4-Vorlage, Art (Länge/Fläche/Volumen) und Wert (immer endlich und ≥ 0). */
export interface Qty {
  name: string;
  kind: "length" | "area" | "volume";
  value: number;
}

/** Rundungsfehler und kaputte Eingaben (NaN) auf 0, nie negativ. */
const clean = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
const q = (name: string, kind: Qty["kind"], value: number): Qty => ({ name, kind, value: clean(value) });
const len = (name: string, v: number) => q(name, "length", v);
const area = (name: string, v: number) => q(name, "area", v);
const vol = (name: string, v: number) => q(name, "volume", v);

/** Fläche eines Rings (Shoelace, unabhängig vom Umlaufsinn); offener Ring, die Schlusskante gilt als gegeben. */
export function ringArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a) / 2;
}

/** Umfang eines geschlossenen Rings. */
export function ringPerimeter(pts: readonly Vec2[]): number {
  let p = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) p += Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
  return p;
}

/** Volumen eines geschlossenen Dreiecks-Netzes (Betrag der Summe der Tetraeder-Volumen zum Ursprung). */
export function meshVolume(positions: readonly number[], indices: readonly number[]): number {
  let v = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return Math.abs(v) / 6;
}

/** Öffnung einer Wand: Achs-Intervall (ab Wandanfang) und absolute Höhen. */
export interface Cutout {
  from: number;
  to: number;
  zBottom: number;
  zTop: number;
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Wand-Basismengen aus den Schicht-Bändern (dieselben wie im 3D) und den Öffnungen.
 *  • Length: Achslänge; Width: Gesamtdicke quer zur Achse; Height: nur bei konstanter Höhe.
 *  • GrossSideArea: Achslänge × Wandhöhe (schräge Oberkante: höchste mittlere Bandhöhe);
 *    NetSideArea: abzüglich der Öffnungsflächen.
 *  • GrossVolume: Summe der Band-Quader (Gehrungen/Anschlüsse stecken in den Bandlängen);
 *    NetVolume: abzüglich der Öffnungen je Band — oder `netVolume`, wenn die Wand als Netz mit schon
 *    ausgestanzten Öffnungen (und Laibungen) geschrieben wird.
 */
export function wallQuantities(
  wall: { start: Vec2; end: Vec2 },
  bands: readonly RWall[],
  cutouts: readonly Cutout[],
  netVolume?: number,
): Qty[] {
  if (bands.length === 0) return [];
  const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const ux = axisLen > 0 ? (wall.end.x - wall.start.x) / axisLen : 1;
  const uy = axisLen > 0 ? (wall.end.y - wall.start.y) / axisLen : 0;
  // Quer zur Achse: Ausdehnung aller Bänder entlang der linken Normalen (−uy, ux).
  let nLo = Infinity;
  let nHi = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let sloped = false;
  let gross = 0;
  let tallest = 0;
  for (const b of bands) {
    const l = Math.hypot(b.end[0] - b.start[0], b.end[1] - b.start[1]);
    const off = -(b.start[0] - wall.start.x) * uy + (b.start[1] - wall.start.y) * ux;
    nLo = Math.min(nLo, off - b.thickness / 2);
    nHi = Math.max(nHi, off + b.thickness / 2);
    zMin = Math.min(zMin, b.baseElevation);
    zMax = Math.max(zMax, b.baseElevation + b.height);
    const drop = b.topDrop ? (b.topDrop[0] + b.topDrop[1]) / 2 : 0;
    if (b.topDrop && (Math.abs(b.topDrop[0]) > 1e-9 || Math.abs(b.topDrop[1]) > 1e-9)) sloped = true;
    gross += l * b.thickness * (b.height - drop);
    tallest = Math.max(tallest, b.height - drop);
  }
  // Seitenfläche der Wandebene: innere Schichten enden oft unter der Decke (niedrigere Bänder), die Wand
  // selbst reicht über die volle Höhe — bei konstanter Oberkante zählt die Gesamthöhe, bei schräger die
  // höchste mittlere Bandhöhe.
  const grossSide = axisLen * (sloped ? tallest : zMax - zMin);
  let cutSide = 0;
  let cutVolume = 0;
  for (const c of cutouts) {
    cutSide += (c.to - c.from) * overlap(c.zBottom, c.zTop, zMin, zMax);
    for (const b of bands) {
      const a0 = (b.start[0] - wall.start.x) * ux + (b.start[1] - wall.start.y) * uy;
      const a1 = (b.end[0] - wall.start.x) * ux + (b.end[1] - wall.start.y) * uy;
      const ox = overlap(Math.min(a0, a1), Math.max(a0, a1), c.from, c.to);
      cutVolume += ox * overlap(c.zBottom, c.zTop, b.baseElevation, b.baseElevation + b.height) * b.thickness;
    }
  }
  // Netto aus dem Netz kann den Band-Quader um Rundung/Gehrungsdetails überschreiten: Brutto nie unter Netto.
  const net = netVolume ?? Math.max(0, gross - cutVolume);
  gross = Math.max(gross, net);
  const out: Qty[] = [len("Length", axisLen), len("Width", nHi - nLo)];
  if (!sloped && zMax - zMin > 0) out.push(len("Height", zMax - zMin));
  out.push(
    area("GrossSideArea", grossSide),
    area("NetSideArea", Math.max(0, grossSide - cutSide)),
    vol("GrossVolume", gross),
    vol("NetVolume", net),
  );
  return out;
}

/** Brutto-Volumen der Löcher in einem Band (für Netz-Wände ohne Netz-Volumen, s. `wallQuantities`). */
export function holeVolume(bands: readonly RWall[]): number {
  let v = 0;
  for (const b of bands) for (const h of b.holes ?? []) v += (h.to - h.from) * overlap(h.zBottom, h.zTop, b.baseElevation, b.baseElevation + b.height) * b.thickness;
  return v;
}

/**
 * Platten-Basismengen (Decke, Podest): Dicke, Umfang der Aussenkontur, Flächen und Volumen; Netto
 * zieht die Aussparungen ab.
 */
export function slabQuantities(outline: readonly Vec2[], openings: readonly (readonly Vec2[])[], thickness: number): Qty[] {
  const gross = ringArea(outline);
  const net = Math.max(0, gross - openings.reduce((s, r) => s + ringArea(r), 0));
  return [
    len("Width", thickness),
    len("Perimeter", ringPerimeter(outline)),
    area("GrossArea", gross),
    area("NetArea", net),
    vol("GrossVolume", gross * thickness),
    vol("NetVolume", net * thickness),
  ];
}

type Vec3 = readonly [number, number, number];

/**
 * Dach-Basismengen aus den geneigten Dachflächen (Aussenseite): geneigte Fläche (brutto = netto, das
 * Modell kennt keine Dachfenster/Aussparungen) und Grundrissprojektion.
 */
export function roofQuantities(planes: readonly (readonly Vec3[])[]): Qty[] {
  let sloped = 0;
  let projected = 0;
  for (const pts of planes) {
    // Newell: Vektorfläche des Polygons; Betrag = Fläche, z-Anteil = Projektion auf den Grundriss.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const c = pts[j];
      const d = pts[i];
      nx += (c[1] - d[1]) * (c[2] + d[2]);
      ny += (c[2] - d[2]) * (c[0] + d[0]);
      nz += (c[0] - d[0]) * (c[1] + d[1]);
    }
    sloped += Math.hypot(nx, ny, nz) / 2;
    projected += Math.abs(nz) / 2;
  }
  return [area("GrossArea", sloped), area("NetArea", sloped), area("ProjectedArea", projected)];
}

/** Stützen-Basismengen: Länge, Querschnitt, Mantel, Oberfläche und Volumen (keine Aussparungen). */
export function columnQuantities(footprint: readonly Vec2[], length: number): Qty[] {
  const cross = ringArea(footprint);
  const outer = ringPerimeter(footprint) * length;
  return [
    len("Length", length),
    area("CrossSectionArea", cross),
    area("OuterSurfaceArea", outer),
    area("NetSurfaceArea", outer + 2 * cross),
    vol("GrossVolume", cross * length),
    vol("NetVolume", cross * length),
  ];
}

/** Tür-/Fenster-Basismengen (lichte Öffnung): Breite, Höhe, Umfang, Fläche. */
export function openingQuantities(width: number, height: number): Qty[] {
  const w = clean(width);
  const h = clean(height);
  return [len("Width", w), len("Height", h), len("Perimeter", 2 * (w + h)), area("Area", w * h)];
}

/** Treppenlauf: Lauflänge entlang der Lauflinie und Volumen (keine Aussparungen). */
export function flightQuantities(length: number, volume: number): Qty[] {
  return [len("Length", length), vol("GrossVolume", volume), vol("NetVolume", volume)];
}

/** Geländer: Länge. */
export function railingQuantities(length: number): Qty[] {
  return [len("Length", length)];
}
