// Geometrie-Helfer für Treppen (Stairs) — Fassade über den Rust-Kern
// (`src-tauri/kernel2d/src/lib.rs`: `stair_geometry`, `stair_outline`, `stair_cut`, `stair_bbox`;
// Bindungen `src-tauri/core/src/web/stair.rs`, Kodierung `src-tauri/core/src/stair.rs`).
// Aus einer `Stair` (gerade/L/Wendel) werden abgeleitet:
//   • die Tritt-Rechtecke im Grundriss (jeweils mit ihrer Z-Höhe der Setzstufe),
//   • das Zwischenpodest-Polygon (L / Wendel-Auge),
//   • die Lauflinie (Polyline) + der Auf-/Abpfeil,
//   • die Schnittposition (welche Tritte unter/über der Grundriss-Schnitthöhe
//     liegen → im Plan durchgezogen vs. gestrichelt) samt SIA-Bruchlinie,
//   • die Plan-Aussenlinie (`stairOutline`).
//
// Die 3D-Darstellung baut aus denselben Tritt-Rechtecken + Setzstufen-Höhen die
// Stufenboxen (siehe `plan/toWalls3d/stairs.ts`). So bleiben Plan und 3D konsistent
// aus EINER Quelle abgeleitet. Referenz (links/mitte/rechts): die gespeicherte Achse wird im
// Kern auf die visuelle Treppen-MITTE versetzt, Lauflinie samt Pfeil liegen stets auf der Mitte.
//
// Bezeichner englisch, Kommentare deutsch.

import type { Stair, Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

/** SIA-nahe Schrittregel: gute Steigungshöhe ≈ 0.17 m, Auftritt ≈ 0.29 m. */
export const IDEAL_RISER = 0.17;
export const IDEAL_TREAD = 0.29;
export const MIN_STEPS = 2;

/**
 * Sinnvolle Default-Stufenzahl aus Steighöhe + verfügbarer Lauflänge: möglichst
 * nahe an der idealen Steigungshöhe, gedeckelt durch die Lauflänge (min.
 * Auftritt ~0.24 m). Immer ≥ MIN_STEPS.
 */
export function defaultStepCount(totalRise: number, runLength: number): number {
  return core().stair_default_step_count(totalRise, runLength);
}

/** Ein Tritt im Grundriss (Rechteck-Polygon) samt Setzstufen-Z (Oberkante). */
export interface TreadRect {
  /** Vier Eckpunkte (CCW), Grundriss-Meter. */
  pts: Vec2[];
  /** Index der Stufe (0 = unterste). */
  index: number;
  /** Oberkante dieses Tritts relativ zur Treppen-UK (Meter). */
  topRise: number;
  /** Unterkante-Höhe (Setzstufe darunter) relativ zur UK (Meter). */
  baseRise: number;
}

/** Vollständige, abgeleitete Treppengeometrie (Plan + 3D + Schnitt). */
export interface StairGeometry {
  /** Alle Tritt-Rechtecke (untere → obere Stufe). */
  treads: TreadRect[];
  /** Zwischenpodest-Polygon (L/Wendel) oder null (gerade). */
  landing: Vec2[] | null;
  /** Setzstufen-Höhe (Meter). */
  riserHeight: number;
  /** Auftrittstiefe (Meter) des geraden Laufs. */
  treadDepth: number;
  /** Lauflinie als Polyline (Meter) — Mitte des Laufs, Start → Austritt. */
  runLine: Vec2[];
  /** Auf-/Abpfeil-Geometrie (Schaft + zwei Spitzenflügel). */
  arrow: { shaft: [Vec2, Vec2]; head: [Vec2, Vec2, Vec2] };
  /** Gesamt-Steighöhe (Meter). */
  totalRise: number;
}

const FORM = { straight: 0, L: 1, spiral: 2 } as const;
const REFERENZ = { mitte: 0, links: 1, rechts: 2 } as const;

/** Treppen-Parameter als 16 Zahlen (Aufbau: `src-tauri/core/src/stair.rs`); fehlend = NaN. */
export function encodeStair(s: Stair): Float64Array {
  const n = (v: number | undefined) => (v === undefined ? Number.NaN : v);
  return Float64Array.of(
    FORM[s.shape] ?? 0,
    s.start.x, s.start.y,
    s.dir.x, s.dir.y,
    s.runLength,
    n(s.run2Length),
    n(s.turn),
    n(s.center?.x), n(s.center?.y),
    n(s.radius),
    n(s.sweep),
    s.width,
    s.stepCount,
    s.up === undefined ? Number.NaN : s.up ? 1 : 0,
    REFERENZ[s.referenz ?? "mitte"] ?? 0,
  );
}

const pt = (f: Float64Array, i: number): Vec2 => ({ x: f[i], y: f[i + 1] });

function ptsAt(f: Float64Array, i: number, n: number): Vec2[] {
  const out: Vec2[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = pt(f, i + 2 * k);
  return out;
}

/** Flache Treppengeometrie (Aufbau: `stair.rs`) → Objekt; leer (Unsinn-Eingabe) → leere Geometrie. */
function decodeGeometry(f: Float64Array): StairGeometry {
  if (f.length < 4) {
    const z = { x: 0, y: 0 };
    return {
      treads: [], landing: null, riserHeight: 0, treadDepth: 0, runLine: [],
      arrow: { shaft: [z, z], head: [z, z, z] }, totalRise: 0,
    };
  }
  const nTreads = f[3];
  let i = 4;
  const treads: TreadRect[] = [];
  for (let t = 0; t < nTreads; t++, i += 11) {
    treads.push({ index: f[i], topRise: f[i + 1], baseRise: f[i + 2], pts: ptsAt(f, i + 3, 4) });
  }
  const nl = f[i++];
  let landing: Vec2[] | null = null;
  if (nl >= 0) {
    landing = ptsAt(f, i, nl);
    i += 2 * nl;
  }
  const nRun = f[i++];
  const runLine = ptsAt(f, i, nRun);
  i += 2 * nRun;
  const a = ptsAt(f, i, 5);
  return {
    treads,
    landing,
    riserHeight: f[0],
    treadDepth: f[1],
    runLine,
    arrow: { shaft: [a[0], a[1]], head: [a[2], a[3], a[4]] },
    totalRise: f[2],
  };
}

/** Geometrie → flacher Puffer (gleicher Aufbau wie die Ausgabe von `stair_geometry_flat`). */
function encodeGeometry(g: StairGeometry): Float64Array {
  const out: number[] = [g.riserHeight, g.treadDepth, g.totalRise, g.treads.length];
  const push = (p: Vec2) => out.push(p.x, p.y);
  for (const t of g.treads) {
    out.push(t.index, t.topRise, t.baseRise);
    t.pts.forEach(push);
  }
  if (g.landing) {
    out.push(g.landing.length);
    g.landing.forEach(push);
  } else out.push(-1);
  out.push(g.runLine.length);
  g.runLine.forEach(push);
  push(g.arrow.shaft[0]);
  push(g.arrow.shaft[1]);
  g.arrow.head.forEach(push);
  return Float64Array.from(out);
}

/**
 * Leitet die vollständige Geometrie einer Treppe ab. `totalRise` MUSS vom
 * Aufrufer aufgelöst übergeben werden (Geschosshöhe-Default liegt im Kern,
 * `stair_vertical_extent` in `model/helpers.rs`), damit dieses Modul modellfrei bleibt.
 */
export function stairGeometry(stair: Stair, totalRise: number): StairGeometry {
  return decodeGeometry(core().stair_geometry_flat(encodeStair(stair), totalRise));
}

/**
 * Schnitt-Aufteilung im Grundriss: DOSSIER schneidet die Treppe auf `cutRise`
 * (Schnitthöhe über OKFF). Tritte mit Oberkante ≤ cutRise werden durchgezogen
 * gezeichnet (unterhalb der Schnittebene), darüberliegende gestrichelt (oberhalb,
 * verdeckt). Der ERSTE Tritt oberhalb markiert die SIA-Bruchlinie (diagonaler
 * Doppelstrich über die Laufbreite).
 */
export interface StairCut {
  /** Indizes der Tritte UNTER der Schnittebene (durchgezogen). */
  belowIndices: number[];
  /** Indizes der Tritte ÜBER der Schnittebene (gestrichelt/verdeckt). */
  aboveIndices: number[];
  /** Bruchlinie (SIA): zwei parallele Diagonalstriche über die Laufbreite. */
  breakLine: [Vec2, Vec2][] | null;
}

/**
 * Bestimmt die Schnittaufteilung. `cutRise` = Schnitthöhe über der Treppen-UK.
 * Findet den ersten Tritt, dessen Oberkante die Schnittebene überschreitet, und
 * legt dort die Bruchlinie quer über den Lauf.
 */
export function stairCut(geo: StairGeometry, cutRise: number): StairCut {
  const f = core().stair_cut_flat(encodeGeometry(geo), cutRise);
  if (f.length < 3) return { belowIndices: [], aboveIndices: [], breakLine: null };
  let i = 0;
  const nBelow = f[i++];
  const belowIndices = Array.from(f.subarray(i, i + nBelow));
  i += nBelow;
  const nAbove = f[i++];
  const aboveIndices = Array.from(f.subarray(i, i + nAbove));
  i += nAbove;
  const nBreak = f[i++];
  let breakLine: [Vec2, Vec2][] | null = null;
  if (nBreak > 0) {
    breakLine = [];
    for (let k = 0; k < nBreak; k++, i += 4) breakLine.push([pt(f, i), pt(f, i + 2)]);
  }
  return { belowIndices, aboveIndices, breakLine };
}

/**
 * Spiral-Outline: Innenbogen + Aussenbogen + zwei radiale Schliesslinien.
 * Die Bögen werden als Kreisbogen-Parameter geliefert (cx/cy/r/a0/a1), die
 * radialen Schliesslinien als Segment-Paare.
 */
export interface SpiralOutlineSegments {
  /** Radiale Abschlusslinien (jeweils Innenpunkt → Aussenpunkt). */
  lines: [Vec2, Vec2][];
  /** Kreisbogen-Parameter: Innen- und Aussenkreis. */
  arcs: { cx: number; cy: number; r: number; a0: number; a1: number }[];
}

/**
 * Aussenlinie einer Treppe im Grundriss je nach Form:
 *   • gerade → geschlossenes Rechteck als Polygon-Punkte.
 *   • L       → L-Polygon via Linien-Schnittpunkten.
 *   • Wendel  → `SpiralOutlineSegments` (Bögen + radiale Linien).
 *
 * Genau einer von `polygon` / `spiral` ist nicht null (bei Unsinn-Eingabe beide null).
 */
export function stairOutline(
  stair: Stair,
  totalRise: number,
): { polygon: Vec2[] | null; spiral: SpiralOutlineSegments | null } {
  void totalRise; // Signatur-Konsistenz mit stairGeometry; derzeit ungenutzt
  const f = core().stair_outline_flat(encodeStair(stair));
  if (f.length === 0) return { polygon: null, spiral: null };
  if (f[0] === 0) return { polygon: ptsAt(f, 2, f[1]), spiral: null };
  const l = ptsAt(f, 1, 4);
  const arcs = [0, 1].map((k) => {
    const j = 9 + 5 * k;
    return { cx: f[j], cy: f[j + 1], r: f[j + 2], a0: f[j + 3], a1: f[j + 4] };
  });
  return { polygon: null, spiral: { lines: [[l[0], l[1]], [l[2], l[3]]], arcs } };
}
