// Türen und Fenster im IFC-Export ([B5]): sammelt die Parameter einer Füllung aus dem Modell (Typ und
// Öffnung) für den Rust-Schreiber. Körper (Rahmen/Zarge, Türblatt, Glas), Füllungs-Placement und
// OperationType/PartitioningType rechnet `src-tauri/fileio/src/ifc_openings.rs` (Port der früheren
// TS-Rechnung, 28.10.; Kodierung FILL im Kopf von `ifc_export.rs`). Fehlende Typwerte bleiben `undefined`,
// die Standardmasse (Rahmen 6 × 7 cm, Blatt 4 cm, Glaspakete) kennt nur Rust.

import type { Opening, Project, Vec2, Wall } from "../model/types";
import { getDoorType, getWindowType, glazingPanesOf } from "../model/types";

/** Ein Eintrag der Flügeltabelle, wie im Modell (`SashDef`). */
export interface FillSash {
  post: boolean;
  postWidth?: number;
  fixed: boolean;
  width?: number;
}

/** Parameter einer Füllung (Reihenfolge der Kodierung: `FlatIfc.opening` in `exportIfc.ts`). */
export interface FillParams {
  wallStart: Vec2;
  wallEnd: Vec2;
  /** Achs-Intervall (Abstand ab `wall.start`) und absolute Höhen der Öffnung. */
  from: number;
  to: number;
  zBottom: number;
  zTop: number;
  /** Querausdehnung der ganzen Wand entlang der linken Normalen ab `wall.start` (`nLo` = Aussenseite). */
  nLo: number;
  nHi: number;
  frameDepth?: number;
  inset?: number;
  insetOutside: boolean;
  frameWidth?: number;
  /** Fenster: Flügelzahl, Scheiben (1–3), Flügeltabelle. */
  wingCount: number;
  panes: number;
  sashes: FillSash[];
  /** Tür: 0 Dreh, 1 Schiebe, 2 reine Wandöffnung. */
  doorKind: 0 | 1 | 2;
  leafCount: number;
  /** +1 Aufschlag links der Achse, −1 rechts; Richtung +1 innen, −1 aussen. */
  swingSign: 1 | -1;
  dirSign: 1 | -1;
  hingeAtStart: boolean;
  transomHeight: number;
  glazed: boolean;
  glazingRatio?: number;
}

/**
 * Parameter der Füllung einer Öffnung. `c` = Achs-Intervall und absolute Höhen der Öffnung, `host` =
 * Querausdehnung der ganzen Wand (wie im 2D/3D).
 */
export function fillParams(
  project: Project,
  wall: Wall,
  opening: Opening,
  c: { from: number; to: number; zBottom: number; zTop: number },
  host: { nLo: number; nHi: number },
): FillParams {
  const isDoor = opening.kind === "door";
  const dt = isDoor ? getDoorType(project, opening) : undefined;
  const wt = isDoor ? undefined : getWindowType(project, opening);
  const t = dt ?? wt;
  const kind = dt?.kind ?? (opening.doorType === "wandoeffnung" ? "wandoeffnung" : "dreh");
  return {
    wallStart: wall.start,
    wallEnd: wall.end,
    from: c.from,
    to: c.to,
    zBottom: c.zBottom,
    zTop: c.zTop,
    nLo: host.nLo,
    nHi: host.nHi,
    frameDepth: t?.frameDepth,
    inset: t?.insetFromFace,
    insetOutside: (t?.insetFace ?? "aussen") === "aussen",
    frameWidth: t?.frameWidth,
    wingCount: opening.wingCount ?? wt?.wingCount ?? 1,
    panes: wt ? glazingPanesOf(wt) : 2,
    sashes: (wt?.sashes ?? []).map((s) => ({ post: s.kind === "pfosten", postWidth: s.postWidth, fixed: s.autoWidth === false, width: s.width })),
    doorKind: kind === "schiebe" ? 1 : kind === "wandoeffnung" ? 2 : 0,
    leafCount: dt?.leafCount ?? 1,
    swingSign: (opening.swing ?? "left") === "left" ? 1 : -1,
    dirSign: (opening.openingDir ?? "in") === "in" ? 1 : -1,
    hingeAtStart: (opening.hinge ?? "start") === "start",
    transomHeight: dt?.transomHeight ?? 0,
    glazed: dt?.leafStyle === "glas",
    glazingRatio: dt?.glazingRatio,
  };
}
