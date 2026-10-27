// Raum-Erkennung — geschlossene Raum-Umrisse aus Wandsegmenten ableiten.
//
// Fassade über den Rust-Kern (`src-tauri/core/src/room_boundary.rs`, Bindungen `web/room_boundary.rs`;
// die Rechnung steht in `kernel2d`: `detect_rooms`, `room_from_point_inside`,
// `room_from_point_inside_faces`). Wände gehen flach hinüber, Umrisse kommen flach zurück.
//
// Verfahren (Rust): planare Anordnung der Wand-MITTELLINIEN (Schnitte an Kreuzungen, Lücken ≤ `gapTol`
// per Endpunkt-Snapping geschlossen), minimale Maschen über „next edge counter-clockwise"
// (Half-Edge-Tracing), Aussenmasche verworfen, jede innere Masche um die halbe (mittlere) Wanddicke
// nach innen versetzt (Miter-Offset ohne Selbstschnitt-Heilung: für orthogonale/konvexe Grundrisse
// exakt, bei sehr spitzen einspringenden Ecken approximativ). Wände sind 1D-Mittellinien; überlappende
// Doppelwände und gekrümmte Wände werden nicht speziell aufgelöst, grössere Öffnungen (Türen) müssen
// als geschlossen modelliert werden.
//
//   detectRooms(walls)                    alle Räume (lichte Innenkonturen, CCW)
//   roomFromPointInside(point, walls)     Klick-in-Raum: kleinste Masche um den Punkt, oder null
//   roomFromPointInsideFaces(point, faces) dasselbe auf fertigen Wand-Innenflächen (ohne Offset)
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheit: METER.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { FlatReader } from "./coreFlat";

/** Ein Wandsegment: Mittellinie a→b mit Dicke (beidseitig je thickness/2). */
export interface WallSegment {
  a: Vec2;
  b: Vec2;
  thickness: number;
}

/** Parameter der Raum-Erkennung. */
export interface DetectRoomsOptions {
  /** Lücken/Endpunkt-Abstände ≤ gapTol (m) werden zusammengeschnappt. Default 0.05. */
  gapTol?: number;
  /** Kleinste als Raum akzeptierte Fläche (m²). Default 0.05. */
  minArea?: number;
  /**
   * true (Default): Maschen um halbe Wanddicke nach innen versetzen, sodass die
   * zurückgegebenen Loops die LICHTE Innenkontur sind. false: Wand-Mittellinien-
   * Maschen (roh) zurückgeben.
   */
  offsetToInner?: boolean;
}

/** Eine Wand-Innenfläche (Face) als gerichtete/ungerichtete Strecke. */
export interface WallFace {
  a: Vec2;
  b: Vec2;
}

/** `[n, (ax, ay, bx, by, dicke)…]`. */
function encodeWalls(walls: WallSegment[]): Float64Array {
  const out = new Float64Array(1 + 5 * walls.length);
  out[0] = walls.length;
  walls.forEach((w, i) => out.set([w.a.x, w.a.y, w.b.x, w.b.y, w.thickness], 1 + 5 * i));
  return out;
}

/** `[n, (ax, ay, bx, by)…]`. */
function encodeFaces(faces: WallFace[]): Float64Array {
  const out = new Float64Array(1 + 4 * faces.length);
  out[0] = faces.length;
  faces.forEach((f, i) => out.set([f.a.x, f.a.y, f.b.x, f.b.y], 1 + 4 * i));
  return out;
}

/** `[nPkt, x, y, …]` → Umriss, leer → null. */
function decodeRing(buf: Float64Array): Vec2[] | null {
  return buf.length ? new FlatReader(buf).ring() : null;
}

/**
 * Erkennt geschlossene Räume aus einer Menge von Wandsegmenten (Mittellinien
 * mit Dicke). Liefert die lichten Innen-Umrisse (Vec2[] je Raum), CCW orientiert.
 */
export function detectRooms(walls: WallSegment[], options: DetectRoomsOptions = {}): Vec2[][] {
  const buf = core().rooms_detect(
    encodeWalls(walls),
    options.gapTol ?? 0.05,
    options.minArea ?? 0.05,
    options.offsetToInner ?? true,
  );
  if (!buf.length) return [];
  const r = new FlatReader(buf);
  const rooms: Vec2[][] = [];
  for (let n = r.count(); n > 0; n--) rooms.push(r.ring());
  return rooms;
}

/**
 * Klick-in-Raum-Fallback: findet die Masche, die den Saatpunkt einschliesst, und
 * gibt ihren lichten Innen-Umriss zurück (oder null, wenn der Punkt in keiner
 * geschlossenen Zelle liegt). Wählt die Masche mit kleinster Fläche, die den Punkt
 * enthält (die unmittelbar umgebende Zelle statt einer grösseren umschliessenden).
 */
export function roomFromPointInside(
  point: Vec2,
  walls: WallSegment[],
  options: DetectRoomsOptions = {},
): Vec2[] | null {
  return decodeRing(
    core().room_from_point(point.x, point.y, encodeWalls(walls), options.gapTol ?? 0.05, options.offsetToInner ?? true),
  );
}

/**
 * Variante des Klick-Tracers auf bereits berechneten Wand-INNENFLÄCHEN: die Strecken
 * bilden schon die lichten Wandseiten, kein Innen-Offset.
 */
export function roomFromPointInsideFaces(point: Vec2, wallFaces: WallFace[], gapTol = 0.05): Vec2[] | null {
  return decodeRing(core().room_from_point_faces(point.x, point.y, encodeFaces(wallFaces), gapTol));
}
