// Raum-Erkennung — geschlossene Raum-Umrisse aus Wandsegmenten ableiten.
//
// Fassade über den Rust-Kern (`src-tauri/core/src/room_boundary.rs`, Bindungen `web/room_boundary.rs`;
// die Rechnung steht in `kernel2d`: `detect_rooms`). Wände gehen flach hinüber, Umrisse kommen flach
// zurück. Der Klick-in-Raum des Raum-Befehls rechnet direkt im Kern (`cmd_create.rs`).
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

/** `[n, (ax, ay, bx, by, dicke)…]`. */
function encodeWalls(walls: WallSegment[]): Float64Array {
  const out = new Float64Array(1 + 5 * walls.length);
  out[0] = walls.length;
  walls.forEach((w, i) => out.set([w.a.x, w.a.y, w.b.x, w.b.y, w.thickness], 1 + 5 * i));
  return out;
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
