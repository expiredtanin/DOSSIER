// Treppen-Domäne des Grundriss-Generators (DOSSIER/SIA): Tritte, Lauflinie mit
// Auf-/Abpfeil, Zwischenpodest und Aussenlinie — mit dem Grundriss-Schnitt
// (Tritte unter der Schnitthöhe durchgezogen, darüber gestrichelt/verdeckt +
// SIA-Bruchlinie).
//
// Die Primitive entstehen im Rust-Kern (`src-tauri/core/src/plan_stairs.rs`, [K3a]); hier nur die
// Übersetzung der flachen Liste in `Primitive`-Objekte (Farbe, Graustufen, `stairId`).
// Fällt mit [K3d] weg, wenn der Plan-Puffer direkt aus Rust kommt.

import type { Project, Stair } from "../../model/types";
import { stairVerticalExtent } from "../../model/wall";
import { encodeStair } from "../../geometry/stair";
import { core } from "../../engine/coreWasm";
import { NO_HATCH, POCHE_STROKE, type Primitive } from "./shared";

/** Linienklassen in der Reihenfolge der Kern-Kodierung (`plan_stairs.rs`). */
const LINE_CLS = ["stair-outline", "stair-tread", "stair-break", "stair-run", "stair-arrow"] as const;
/** Strichmuster der verdeckten Tritte (Meter). */
const TREAD_DASH = [0.12, 0.08];

/**
 * Treppen-Symbol im Grundriss (DOSSIER/SIA):
 *  • Tritte als Rechtecke: die Tritt-Trennlinien werden gezeichnet — unter der
 *    Schnittebene DURCHGEZOGEN (sichtbar), darüber GESTRICHELT (verdeckt).
 *  • Der erste Tritt oberhalb der Schnittebene trägt die diagonale SIA-Bruchlinie
 *    (Doppelstrich quer über den Lauf).
 *  • Zwischenpodest (L/Wendel) als Umriss-Polygon.
 *  • Lauflinie (Lauflinie) mit Auf-/Abpfeil (Auf-/Abpfeil) und Stufenanzahl-Label.
 * Alle Primitive tragen `stairId` für die Auswahl.
 */
export function addStairSymbol(
  out: Primitive[],
  project: Project,
  stair: Stair,
  greyed: boolean,
  lwMm: number,
  cutHeight: number,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const f = core().plan_stair_flat(
    encodeStair(stair),
    zTop - zBottom,
    cutHeight,
    lwMm,
    stair.arrowStyle === "filled" ? 1 : 0,
  );
  if (f.length === 0) return;
  const stroke = stair.color ?? POCHE_STROKE;
  const stairId = stair.id;
  const n = f[0];
  let i = 1;
  for (let k = 0; k < n; k++) {
    switch (f[i]) {
      case 1: {
        const count = f[i + 3];
        const pts = new Array<{ x: number; y: number }>(count);
        for (let j = 0; j < count; j++) pts[j] = { x: f[i + 4 + 2 * j], y: f[i + 5 + 2 * j] };
        out.push({
          kind: "polygon",
          pts,
          fill: f[i + 2] ? stroke : "none",
          stroke,
          strokeWidthMm: f[i + 1],
          hatch: NO_HATCH,
          greyed,
          stairId,
        });
        i += 4 + 2 * count;
        break;
      }
      case 2:
        out.push({
          kind: "line",
          a: { x: f[i + 4], y: f[i + 5] },
          b: { x: f[i + 6], y: f[i + 7] },
          cls: LINE_CLS[f[i + 1]],
          weightMm: f[i + 2],
          ...(LINE_CLS[f[i + 1]] === "stair-tread" ? { dash: f[i + 3] ? TREAD_DASH : null } : {}),
          color: stroke,
          greyed,
          stairId,
        });
        i += 8;
        break;
      default:
        out.push({
          kind: "arc",
          center: { x: f[i + 2], y: f[i + 3] },
          from: { x: f[i + 4], y: f[i + 5] },
          to: { x: f[i + 6], y: f[i + 7] },
          r: f[i + 8],
          cls: "stair-outline",
          weightMm: f[i + 1],
          greyed,
          stairId,
        });
        i += 9;
    }
  }
}
