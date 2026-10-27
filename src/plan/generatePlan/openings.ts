// Öffnungs-Domäne des Grundriss-Generators: Tür-/Fenstersymbole je Detailgrad
// (Blatt/Schwenkbogen/Anschlag bzw. Rahmen/Sprossen/Glas), das optionale
// Rahmenband (Zarge/Blockrahmen) samt Schichteinzug aus der Typ-Bibliothek.
//
// Die Geometrie entsteht im Rust-Kern (`src-tauri/core/src/plan_openings.rs`, [K3a]); hier bleibt
// die Auflösung aus dem Modell (Typ-Bibliothek, Linien-Overrides) und die Übersetzung in
// `Primitive`-Objekte mit Farbe, Strichstärke und `openingId`. Fällt mit [K3d] weg.

import type { Opening, Project, Wall } from "../../model/types";
import {
  getDoorType,
  getWindowType,
  getWallType,
  sashesOfWindowType,
  wallTypeThickness,
} from "../../model/types";
import { wallReferenceOffset } from "../../model/wall";
import { core } from "../../engine/coreWasm";
import {
  NO_HATCH,
  OVERHEAD_DASH,
  POCHE_STROKE,
  SYMBOL_HAIRLINE_MM,
  type DetailLevel,
  type Primitive,
} from "./shared";

/** Linienklassen in der Reihenfolge der Kern-Kodierung (`plan_openings.rs`). */
const LINE_CLS = [
  "door-leaf", "door-frame", "door-lintel", "opening-frame", "window-glass", "window-mullion",
  "window-sash", "window-stulp", "window-sill", "window-frame", "window-shading",
] as const;
/** Strichmuster (Kern-Kodierung): 1 Sturz, 2 Überkopf, 3 gepunktet. */
const DASHES: (number[] | undefined)[] = [undefined, [0.18, 0.09], OVERHEAD_DASH, [0.04, 0.08]];
const DETAIL_CODE: Record<DetailLevel, number> = { grob: 0, mittel: 1, fein: 2 };
const LINTEL_CODE = { keine: 0, aussen: 1, innen: 2, beide: 3 } as const;
const SILL_CODE = { aussen: 1, innen: 2, beide: 3 } as const;

/**
 * Aufgelöste Rahmen-Parameter (Typ-Bibliothek) einer Tür-/Fenster-Öffnung —
 * nur vorhanden, wenn die Öffnung einen Bauteil-Typ referenziert (`typeId`).
 * Fehlt der Typ, bleibt das heutige Inline-Verhalten unverändert (kein
 * Rahmenband, kein Oberlicht) — siehe `resolveOpeningFrameSpec`.
 */
interface OpeningFrameSpec {
  frameWidth: number;
  /** Nur bei Türen relevant; Fenster zeichnen stets die schmale Zargen-Optik. */
  frameKind: "zarge" | "blockrahmen";
  insetFromFace: number;
  insetFace: "aussen" | "innen";
  transomHeight: number;
}

/**
 * Löst die Rahmen-Parameter aus dem referenzierten Tür-/Fenstertyp auf (samt
 * Defaults); `undefined`, wenn kein Typ referenziert/auflösbar ist — die
 * Öffnung bleibt dann beim heutigen Inline-Verhalten (rückwärtskompatibel).
 */
function resolveOpeningFrameSpec(project: Project, o: Opening): OpeningFrameSpec | undefined {
  if (o.kind === "door") {
    const t = getDoorType(project, o);
    if (!t) return undefined;
    return {
      frameWidth: t.frameWidth ?? 0.06,
      frameKind: t.frameKind ?? "zarge",
      insetFromFace: t.insetFromFace ?? 0,
      insetFace: t.insetFace ?? "aussen",
      transomHeight: t.transomHeight ?? 0,
    };
  }
  const t = getWindowType(project, o);
  if (!t) return undefined;
  return {
    frameWidth: t.frameWidth ?? 0.06,
    frameKind: "zarge",
    insetFromFace: t.insetFromFace ?? 0,
    insetFace: t.insetFace ?? "aussen",
    transomHeight: t.transomHeight ?? 0,
  };
}

/**
 * Öffnungs-Symbol (Fenster/Tür) je Detailgrad. Arbeitet über den Kern (`plan_openings.rs`) und
 * taggt ihre Primitive mit `openingId`, sodass die Öffnung im Plan selektierbar ist.
 *
 * Tür:
 *  • grob   — gerade Türblatt-Linie (die Lücke kommt aus der ausgesparten Poché).
 *  • mittel — + Schwenkbogen (Öffnungswinkel).
 *  • fein   — + Anschlag-Striche an beiden Pfosten.
 * Fenster:
 *  • grob   — eine einzelne Glaslinie über die Lücke.
 *  • mittel — Rahmen-Rechteck (Umriss) + Pfosten/Stulp.
 *  • fein   — + Flügelrahmen, Fensterbank, Anschlagkerben.
 */
export function addOpeningSymbol(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  detail: DetailLevel,
  lwMm: number,
): void {
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const door = o.kind === "door";
  const wt = door ? undefined : getWindowType(project, o);
  const frameSpec = door ? resolveOpeningFrameSpec(project, o) : undefined;
  const sashes = wt ? sashesOfWindowType(wt) : [];
  const strokeColor = o.color ?? POCHE_STROKE;
  // Linien-Kategorien einzeln übersteuerbar: Rahmen-Schnitt, Rahmen-Aufsicht, Fenster
  // (Flügelrahmen/Sprossen), Sims. `undefined` ⇒ Strichfarbe/Haarlinie.
  const frameColor = o.frameLine?.color ?? strokeColor;
  const frameWeight = o.frameLine?.weight ?? lwMm;
  const frameViewWeight = o.frameViewLine?.weight ?? frameWeight;
  const colors = [
    "",
    strokeColor,
    frameColor,
    o.frameViewLine?.color ?? frameColor,
    o.sashLine?.color ?? strokeColor,
    o.sillLineStyle?.color ?? strokeColor,
  ];
  const b: number[] = [
    wall.start.x, wall.start.y, wall.end.x, wall.end.y, total, refOff,
    o.position, o.width, door ? 1 : 0, DETAIL_CODE[detail],
    // Tür
    (o.swing ?? "left") !== "left" ? 1 : 0,
    (o.openingDir ?? "in") !== "in" ? 1 : 0,
    (o.hinge ?? "start") !== "start" ? 1 : 0,
    o.swingAngle ?? Number.NaN,
    (o.doorType ?? "normal") === "wandoeffnung" ? 1 : 0,
    door ? Math.max(1, Math.round(getDoorType(project, o)?.leafCount ?? 1)) : 1,
    LINTEL_CODE[o.lintelLines ?? "beide"],
    // Rahmenband
    frameSpec ? 1 : 0,
    frameSpec?.frameWidth ?? 0,
    frameSpec?.frameKind === "blockrahmen" ? 1 : 0,
    frameSpec?.insetFromFace ?? 0,
    frameSpec?.insetFace === "innen" ? 1 : 0,
    // Fenster
    wt ? 1 : 0,
    wt ? wt.frameWidth ?? 0.06 : 0,
    wt?.frameDepth ?? Number.NaN,
    wt?.insetFromFace ?? Number.NaN,
    wt?.insetFace === "innen" ? 1 : 0,
    o.wingCount ?? Number.NaN,
    detail === "fein" ? 2 : 1,
    wt?.sillLine ? SILL_CODE[wt.sillLine.faces] : 0,
    wt?.sillLine?.view === "unter" ? 1 : 0,
    wt?.shading?.create ? 1 : 0,
    wt?.shading?.box.width ?? 0,
    wt?.shading?.box.height ?? 0,
    // Strichstärken
    SYMBOL_HAIRLINE_MM,
    o.frameLine?.weight ?? SYMBOL_HAIRLINE_MM,
    frameViewWeight,
    o.sashLine?.weight ?? SYMBOL_HAIRLINE_MM,
    o.sillLineStyle?.weight ?? SYMBOL_HAIRLINE_MM,
    sashes.length,
  ];
  for (const s of sashes) {
    b.push(s.kind === "pfosten" ? 1 : 0, s.autoWidth === false ? 0 : 1, s.width ?? Number.NaN, s.postWidth ?? Number.NaN,
      s.opening && s.opening !== "fest" ? 1 : 0);
  }
  const f = core().plan_opening_flat(Float64Array.from(b));
  if (f.length === 0) return;
  const openingId = o.id;
  const n = f[0];
  let i = 1;
  for (let k = 0; k < n; k++) {
    if (f[i] === 1) {
      const count = f[i + 4];
      const pts = new Array<{ x: number; y: number }>(count);
      for (let j = 0; j < count; j++) pts[j] = { x: f[i + 5 + 2 * j], y: f[i + 6 + 2 * j] };
      const frame = f[i + 1] === 1;
      out.push({
        kind: "polygon",
        pts,
        fill: "none",
        stroke: frame ? colors[f[i + 3]] : "none",
        strokeWidthMm: f[i + 2],
        hatch: NO_HATCH,
        greyed,
        openingId,
      });
      i += 5 + 2 * count;
    } else if (f[i] === 2) {
      const slot = f[i + 3];
      const dash = DASHES[f[i + 4]];
      out.push({
        kind: "line",
        a: { x: f[i + 5], y: f[i + 6] },
        b: { x: f[i + 7], y: f[i + 8] },
        cls: LINE_CLS[f[i + 1]],
        weightMm: f[i + 2],
        ...(dash ? { dash } : {}),
        ...(slot ? { color: colors[slot] } : {}),
        greyed,
        openingId,
      });
      i += 9;
    } else {
      out.push({
        kind: "arc",
        center: { x: f[i + 2], y: f[i + 3] },
        from: { x: f[i + 4], y: f[i + 5] },
        to: { x: f[i + 6], y: f[i + 7] },
        r: f[i + 8],
        cls: "door-swing",
        weightMm: f[i + 1],
        greyed,
        openingId,
      });
      i += 9;
    }
  }
}
