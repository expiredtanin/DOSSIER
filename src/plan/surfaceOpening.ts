// Dach-/Deckenfenster ([103]): Lage in der Wirtsfläche für Griffe und Objekt-Info. Gerechnet im Kern
// (Abfrage `surfaceOpening`, `src-tauri/core/src/opening_shape.rs`); hier nur die Fassade und die
// Umrechnung eines Griff-Zugs (Grundriss-Punkt) in neue Öffnungsfelder.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

type V3 = [number, number, number];
type P = { x: number; y: number };

export interface SurfaceOpeningInfo {
  hostKind: "roof" | "ceiling";
  hostId: string;
  /** Geschossname des Wirts. */
  hostName: string;
  floorId: string;
  /** Mittelpunkt auf der Oberfläche; Achsen Breite (waagrecht) und Höhe (das Gefälle hinauf). */
  center: V3;
  ew: V3;
  eh: V3;
  /** Rechteck im Grundriss (Gegenuhrzeigersinn). */
  corners: [number, number][];
  zBottom: number;
  zTop: number;
  slopeDeg: number;
}

/** Lage einer Dach-/Deckenöffnung oder `null` (kein solcher Wirt). */
export function surfaceOpeningInfo(project: Project, openingId: string): SurfaceOpeningInfo | null {
  return documentFor(project).query<SurfaceOpeningInfo | null>("surfaceOpening", [], openingId);
}

/** Griffe im Grundriss: 0 Mitte (verschieben), 1 Breite (Kante rechts), 2 Höhe (Kante oben im Gefälle). */
export function surfaceOpeningGrips(info: SurfaceOpeningInfo, width: number, height: number): P[] {
  const c = info.center;
  return [
    { x: c[0], y: c[1] },
    { x: c[0] + info.ew[0] * width / 2, y: c[1] + info.ew[1] * width / 2 },
    { x: c[0] + info.eh[0] * height / 2, y: c[1] + info.eh[1] * height / 2 },
  ];
}

/**
 * Neue Felder für einen Griff-Zug auf `pt` (Grundriss): Mitte → `hostPoint`; Breite/Höhe symmetrisch
 * um die Mitte, die Höhe in der Dachebene (Grundriss-Abstand / Länge der projizierten Höhenachse).
 * `null`, wenn der Zug keine gültige Grösse ergibt.
 */
export function surfaceOpeningGripPatch(
  info: SurfaceOpeningInfo,
  index: number,
  pt: P,
): { hostPoint?: P; width?: number; height?: number } | null {
  const c = info.center;
  const d = { x: pt.x - c[0], y: pt.y - c[1] };
  if (index === 0) return { hostPoint: { x: pt.x, y: pt.y } };
  const axis = index === 1 ? info.ew : info.eh;
  const l2 = axis[0] * axis[0] + axis[1] * axis[1];
  if (!(l2 > 1e-9)) return null;
  const v = Math.abs((d.x * axis[0] + d.y * axis[1]) / l2) * 2;
  if (!(v >= 0.1) || !Number.isFinite(v)) return null;
  const r = Math.round(v * 1000) / 1000;
  return index === 1 ? { width: r } : { height: r };
}
