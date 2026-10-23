// B-Rep-Spezifikation einer Wand(schicht) (`RWall`) für truck: Wandprofil (Achse × Höhe) mit
// den Öffnungen als Löcher bzw. Kerben, um die Dicke extrudiert — OHNE Boolean (B-Rep-Booleans
// scheitern an den bündigen Laibungsflächen). Gemeinsame Quelle für STEP-Export, Abzugskörper
// im 3D und Kollisionsprüfung.

import type { SolidSpec } from "../engine/truckSolid";
import type { RWall } from "./toWalls3d/shared";

const EPS = 1e-6;
/** Schicht/Öffnung so dünn, dass sie als nicht vorhanden gilt. */
const MIN_THICKNESS = 1e-4;

/**
 * Wandprofil (u = Achse, v = Höhe über Wandfuss) mit Öffnungen: Löcher, die ganz im Profil
 * liegen; Öffnungen am Wandfuss (Türen) als Kerben im Aussenring. Öffnungen am Wandkopf
 * werden um 1 mm gekappt (ein Loch darf den Rand nicht berühren).
 */
export function wallProfile(
  length: number,
  height: number,
  holes: Array<{ from: number; to: number; zBottom: number; zTop: number }>,
  baseElevation: number,
): { outer: number[]; holes: number[][] } {
  const inner: number[][] = [];
  const notches: Array<[number, number, number]> = []; // [from, to, top]
  const cut = 1e-3;
  for (const h of holes) {
    const u0 = Math.max(0, Math.min(length, h.from));
    const u1 = Math.max(0, Math.min(length, h.to));
    if (u1 - u0 < MIN_THICKNESS) continue;
    const v0 = h.zBottom - baseElevation;
    const v1 = Math.min(height - cut, h.zTop - baseElevation);
    if (v1 - Math.max(v0, 0) < MIN_THICKNESS) continue;
    if (v0 <= cut) notches.push([u0, u1, v1]);
    else inner.push([u0, v0, u1, v0, u1, v1, u0, v1]);
  }
  // Kerben sortieren und überlappende zusammenfassen.
  notches.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number, number]> = [];
  for (const n of notches) {
    const last = merged[merged.length - 1];
    if (last && n[0] <= last[1] + EPS) {
      last[1] = Math.max(last[1], n[1]);
      last[2] = Math.max(last[2], n[2]);
    } else merged.push([...n]);
  }
  // Aussenring CCW in (u,v): Wandfuss links→rechts mit Kerben, dann Kopf rechts→links.
  const outer: number[] = [0, 0];
  for (const [a, b, top] of merged) {
    outer.push(a, 0, a, top, b, top, b, 0);
  }
  outer.push(length, 0, length, height, 0, height);
  return { outer, holes: inner };
}

export function wallSpec(w: RWall): SolidSpec | null {
  const dx = w.end[0] - w.start[0];
  const dy = w.end[1] - w.start[1];
  const len = Math.hypot(dx, dy);
  if (len < MIN_THICKNESS || w.height < MIN_THICKNESS || w.thickness < MIN_THICKNESS) return null;
  const ux = dx / len;
  const uy = dy / len;
  // u × v (v = +Z) = (uy, −ux, 0): Extrusionsrichtung. Ursprung = eine Wandfläche.
  const nx = uy;
  const ny = -ux;
  const prof = wallProfile(len, w.height, w.holes ?? [], w.baseElevation);
  return {
    kind: "extrudePlane",
    points: prof.outer,
    holes: prof.holes,
    origin: [
      w.start[0] - (nx * w.thickness) / 2,
      w.start[1] - (ny * w.thickness) / 2,
      w.baseElevation,
    ],
    uAxis: [ux, uy, 0],
    vAxis: [0, 0, 1],
    depth: w.thickness,
  };
}

