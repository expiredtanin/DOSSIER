// Öffnungs-Domäne der 3D-Ableitung: Glasscheibe(n)/Türblatt, Rahmen-/Sprossen-
// Riegel (Zarge/Blendrahmen/Kämpfer/Mittelpfosten/Flügelrahmen + SIA-Symbole),
// Fensterbänke, Zargen-Umgriff, Schwellenprofil und der Rollladen-/Sonnenschutz-
// kasten typisierter Tür-/Fensteröffnungen — das 3D-Pendant zu
// `generatePlan/openings.ts`.
//
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/openings3d.rs`, Kodierung
// dort); hier bleiben das Sammeln aus dem `Project` (Tür-/Fenstertyp, Flügel-
// tabelle, Öffnungs-Intervall und -Höhe, Wanddicke), die flache Übergabe aller
// Wände in EINEM Kern-Aufruf und die Farbe je Bauteil-Klasse.
//
// Die Quader liegen in MODELL-Metern (x, y, z = Höhe); render3d bildet sie nach
// world ab und rendert sie doppelseitig (Winding egal). `kind: "extrusion"`
// (NICHT "imported"): die Nord-Achsen-Negation in `append_context_mesh` gilt nur
// für echte Import-Rohdaten, Öffnungs-Quader entstehen orientierungserhaltend aus
// der Wandachse (Fund 2026-09-27).

import type { DoorType, FrameCornerJoin, Opening, Project, WindowType } from "../../model/types";
import { getDoorType, getWindowType, glazingPanesOf } from "../../model/types";
import { openingInterval, openingVerticalExtent } from "../../geometry/opening";
import type { DetailLevel } from "../../model/viewTypes";
import { FlatReader, FlatWriter } from "../../geometry/coreFlat";
import { core } from "../../engine/coreWasm";
import type { RMesh, RRgb } from "./shared";
import { wallThicknessSafe } from "./bands";

/**
 * Farbe je Bauteil-Klasse (Index = `Part` in `openings3d.rs`): Glas (hell,
 * bläulich), Rahmen (helles, warmes Grau), Rollladenkasten, Fensterbank/
 * Schwelle (Stein-Grau), SIA-Symbole (dunkle Linien auf dem Glas), Türblatt
 * (warm, hell).
 */
const PART_RGB: readonly RRgb[] = [
  [0.62, 0.76, 0.85],
  [0.85, 0.85, 0.83],
  [0.88, 0.88, 0.9],
  [0.8, 0.8, 0.78],
  [0.25, 0.27, 0.3],
  [0.93, 0.9, 0.85],
];

/** Dreiecke eines Öffnungs-Quaders (Ecken-Bits: bit0 = Achse, bit1 = Höhe, bit2 = quer). */
const OPENING_BOX_TRIS: readonly number[] = [
  0, 1, 3, 0, 3, 2, // quer nMin
  4, 5, 7, 4, 7, 6, // quer nMax
  0, 1, 5, 0, 5, 4, // UK
  2, 3, 7, 2, 7, 6, // OK
  0, 2, 6, 0, 6, 4, // from
  1, 3, 7, 1, 7, 5, // to
];

const DETAIL_CODE: Record<string, number> = { grob: 0, mittel: 1, fein: 2 };
const JOIN_CODE: Record<string, number> = { horizontal: 1, gehrung: 2 };
const OPENING_KIND_CODE: Record<string, number> = { dreh: 1, kipp: 2, drehkipp: 3, fest: 4, schiebe: 5 };
const SILL_BOARD_CODE: Record<string, number> = { keine: 1, innen: 2, beide: 3 };

/** Fehlender Wert → NaN (der Kern setzt dort den Default). */
const opt = (v: number | null | undefined): number => v ?? Number.NaN;
const flag = (b: boolean): number => (b ? 1 : 0);
const openingKindCode = (k: string | undefined): number => (k ? OPENING_KIND_CODE[k] ?? 6 : 0);

/** Gemeinsame Typwerte (Kodierung `openings3d.rs`). */
function writeCommon(w: FlatWriter, t: DoorType | WindowType): void {
  w.num(
    opt(t.frameDepth),
    opt(t.insetFromFace),
    flag((t.insetFace ?? "aussen") === "innen"),
    JOIN_CODE[t.frameCornerJoin ?? ""] ?? 0,
    opt(t.frameWidth),
    opt(t.transomHeight),
  );
}

function writeOpening(w: FlatWriter, project: Project, op: Opening): void {
  if (op.kind === "window") {
    const wt = getWindowType(project, op);
    if (!wt) {
      w.num(0);
      return;
    }
    w.num(1);
    writeCommon(w, wt);
    const shading = wt.shading?.create ? wt.shading.box : undefined;
    w.num(
      glazingPanesOf(wt),
      opt(wt.mullionRows),
      opt(wt.mullionCols),
      SILL_BOARD_CODE[wt.sillBoard ?? ""] ?? 0,
      flag(!!shading),
      shading?.width ?? 0,
      shading?.height ?? 0,
      shading?.depth ?? 0,
      op.wingCount ?? wt.wingCount ?? 1,
      openingKindCode(wt.kind),
    );
    const sashes = wt.sashes ?? [];
    w.num(sashes.length);
    for (const s of sashes) {
      w.num(
        s.kind === "fluegel" ? 0 : s.kind === "pfosten" ? 1 : 2,
        flag(s.autoWidth === false),
        opt(s.width),
        opt(s.postWidth),
        openingKindCode(s.opening),
        flag((s.hingeSide ?? "left") === "left"),
      );
    }
    return;
  }
  const dt = getDoorType(project, op);
  if (!dt) {
    w.num(0);
    return;
  }
  w.num(1);
  writeCommon(w, dt);
  w.num(
    flag(dt.threshold === true),
    opt(dt.leafCount),
    dt.leafStyle === "glas" ? 1 : dt.leafStyle === "kassette" ? 2 : 0,
    opt(dt.glazingRatio),
    flag((dt.frameKind ?? "zarge") === "zarge"),
    opt(dt.panelCols),
    opt(dt.panelRows),
  );
}

/**
 * Alle Öffnungs-Einbauteile eines Projekts als rohe Quader-Meshes, in EINEM
 * Kern-Aufruf. Reihenfolge wie früher: erst Glas/Türblätter aller Wände, dann
 * Rahmen/Sprossen/Bänke/Zargen (nicht bei „grob"), dann Rollladenkästen (nicht
 * bei „grob").
 *
 *  • Ohne auflösbaren Typ: Fenster = EINE Vollscheibe mittig in der Wand, Tür =
 *    offenes Loch, kein Rahmen (Rückwärtskompatibilität).
 *  • „mittel": Blendrahmen + Oberlicht-Kämpfer + Flügelrahmen + Fensterbank/
 *    Zargen-Umgriff/Schwellenprofil, keine Sprossen, keine SIA-Symbole.
 *  • „fein": zusätzlich Flügel-Mittelpfosten, Kämpfer-Zeilen und SIA-Symbole.
 */
export function emitOpeningMeshes(project: Project, detail: DetailLevel = "fein"): RMesh[] {
  const byWall = new Map<string, Opening[]>();
  for (const op of project.openings ?? []) {
    const list = byWall.get(op.hostWallId);
    if (list) list.push(op);
    else byWall.set(op.hostWallId, [op]);
  }
  const w = new FlatWriter().num(DETAIL_CODE[detail] ?? 3, project.walls.length);
  for (const wall of project.walls) {
    w.num(wall.start.x, wall.start.y, wall.end.x, wall.end.y);
    const slot = w.slot();
    let count = 0;
    let thickness: number | undefined;
    for (const op of byWall.get(wall.id) ?? []) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      thickness ??= wallThicknessSafe(project, wall);
      w.num(iv.from, iv.to, vert.zBottom, vert.zTop, flag(op.kind !== "window"), thickness);
      writeOpening(w, project, op);
      count++;
    }
    w.set(slot, count);
  }
  const buf = core().opening_meshes_flat(w.done());
  const out: RMesh[] = [];
  const n = new FlatReader(buf).count();
  for (let k = 0, i = 1; k < n && i + 25 <= buf.length; k++, i += 25) {
    const positions = new Array<number>(24);
    for (let j = 0; j < 24; j++) positions[j] = buf[i + 1 + j];
    out.push({ positions, indices: [...OPENING_BOX_TRIS], kind: "extrusion", color: PART_RGB[buf[i]] ?? PART_RGB[1] });
  }
  return out;
}

/**
 * Rahmen-Ring (Pfosten links/rechts, Riegel oben, Riegel unten nur bei
 * `bottom`) über das Feld `[from,to]×[zB,zT]` mit Profilbreite `w`, ohne
 * überlappende Profile; `join` bestimmt die durchlaufenden Glieder. Glieder als
 * (u,h)-Vierecke: (from,UK), (to,UK), (from,OK), (to,OK). Rechnet im Kern.
 */
export function frameRingQuads(
  from: number,
  to: number,
  zB: number,
  zT: number,
  w: number,
  join: FrameCornerJoin,
  bottom: boolean,
): Array<[[number, number], [number, number], [number, number], [number, number]]> {
  const r = new FlatReader(core().frame_ring_quads_flat(from, to, zB, zT, w, JOIN_CODE[join] ?? 0, bottom));
  const out: Array<[[number, number], [number, number], [number, number], [number, number]]> = [];
  for (let n = r.count(); n > 0; n--) {
    out.push([
      [r.num(), r.num()],
      [r.num(), r.num()],
      [r.num(), r.num()],
      [r.num(), r.num()],
    ]);
  }
  return out;
}
