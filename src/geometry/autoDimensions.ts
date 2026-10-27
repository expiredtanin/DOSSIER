// Automatische Aussenbemassung ([81]): je Gebäudeseite (Süd, Ost, Nord, West) bis zu drei
// Massketten ausserhalb des Grundrisses, von innen nach aussen:
//   1. Öffnungen — Gebäudeecken der Seite plus Leibungen der Fenster/Türen in Wänden dieser Seite,
//   2. Vor-/Rücksprünge — die Ecken der nach dieser Seite schauenden Aussenkanten (nur bei Stufung),
//   3. Gesamtmass.
// Grundlage ist die vereinigte Grundfläche der Wände des Geschosses (an verbundenen Enden um die
// halbe Dicke verlängert, damit Aussenecken voll sind). Nur achsparallele Kanten werden bemasst;
// schiefe Wände fehlen in den Ketten. Ergebnis sind gewöhnliche Bemassungen (Drawing2D), danach
// frei bearbeitbar.

import type { Drawing2D, Project, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { openingJambs } from "./opening";
import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter } from "./coreFlat";

export type DimSide = "south" | "east" | "north" | "west";
export type DimChain = "openings" | "steps" | "total";

export interface AutoDimension {
  side: DimSide;
  chain: DimChain;
  drawing: Drawing2D;
}

/** Reihenfolge wie im Rust-Kern (`auto_dimensions.rs`: SIDES, CHAIN_*). */
const SIDES: DimSide[] = ["south", "east", "north", "west"];
const CHAINS: DimChain[] = ["openings", "steps", "total"];

function thicknessOf(project: Project, w: Wall): number {
  try {
    return wallTypeThickness(getWallType(project, w));
  } catch {
    return 0.3; // verwaister Wandtyp
  }
}

/**
 * Erzeugt die Aussenbemassung eines Geschosses. `scaleDenominator` bestimmt den Abstand der
 * Ketten (Papier-mm → Modell-Meter), `categoryCode` die Ebene der neuen Bemassungen. Die Ketten
 * rechnet der Rust-Kern aus Wandachsen/-dicken und Öffnungs-Leibungen.
 */
export function autoExteriorDimensions(
  project: Project,
  floorId: string,
  categoryCode: string,
  scaleDenominator = 100,
  idPrefix = "autodim",
): AutoDimension[] {
  const walls = project.walls.filter((w) => w.floorId === floorId);
  if (walls.length === 0) return [];
  const ww = new FlatWriter().num(walls.length);
  for (const w of walls) ww.num(w.start.x, w.start.y, w.end.x, w.end.y, thicknessOf(project, w));
  const index = new Map<string, number>();
  walls.forEach((w, i) => index.has(w.id) || index.set(w.id, i));
  const ow = new FlatWriter();
  const count = ow.slot();
  let nOpenings = 0;
  for (const o of project.openings ?? []) {
    const i = index.get(o.hostWallId);
    if (i === undefined) continue;
    const j = openingJambs(walls[i], o);
    if (!j) continue;
    ow.num(i, j.jambStart.x, j.jambStart.y, j.jambEnd.x, j.jambEnd.y);
    nOpenings++;
  }
  ow.set(count, nOpenings);

  const rd = new FlatReader(core().autodim_chains(ww.done(), ow.done(), scaleDenominator));
  const out: AutoDimension[] = [];
  for (let n = rd.count(); n > 0; n--) {
    const side = SIDES[rd.num()];
    const chain = CHAINS[rd.num()];
    const offset = rd.num();
    const pts = rd.ring();
    out.push({
      side,
      chain,
      drawing: {
        id: `${idPrefix}-${floorId}-${side}-${chain}`,
        type: "drawing2d",
        levelId: floorId,
        categoryCode,
        geom: { shape: "dimension", pts, offset },
      } as Drawing2D,
    });
  }
  return out;
}
