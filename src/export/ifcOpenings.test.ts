// Türen/Fenster im IFC-Export ([B5]): TS sammelt nur die Parameter aus Typ und Öffnung; die Geometrie
// rechnet Rust (`src-tauri/fileio/src/ifc_openings.rs`, dort die Fälle Rahmen/Blatt/Glas/Ausführung).

import { describe, expect, it } from "vitest";
import { fillParams } from "./ifcOpenings";
import type { DoorType, Opening, Project, Wall, WindowType } from "../model/types";

const wall = { id: "W", start: { x: 0, y: 0 }, end: { x: 5, y: 0 } } as Wall;
const host = { nLo: -0.2, nHi: 0.2 };
const proj = (over: { doorTypes?: DoorType[]; windowTypes?: WindowType[] }) =>
  ({ doorTypes: over.doorTypes ?? [], windowTypes: over.windowTypes ?? [] }) as unknown as Project;
const door = (over: Partial<Opening> = {}) =>
  ({ id: "D", type: "opening", hostWallId: "W", categoryCode: "21", kind: "door", position: 1, width: 1, height: 2.1, sillHeight: 0, ...over }) as Opening;
const win = (over: Partial<Opening> = {}) =>
  ({ id: "F", type: "opening", hostWallId: "W", categoryCode: "21", kind: "window", position: 1, width: 1.2, height: 1.2, sillHeight: 0.9, ...over }) as Opening;
const cut = (o: Opening) => ({ from: o.position, to: o.position + o.width, zBottom: o.sillHeight, zTop: o.sillHeight + o.height });
const wt = (over: Partial<WindowType> = {}): WindowType =>
  ({ id: "wt", name: "Fenster", kind: "dreh", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, ...over }) as WindowType;
const dtp = (over: Partial<DoorType> = {}): DoorType =>
  ({ id: "dt", name: "Tür", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.06, defaultWidth: 1, defaultHeight: 2.1, ...over }) as DoorType;

describe("fillParams", () => {
  it("Fenster: Typwerte, Flügeltabelle, Flügelzahl der Öffnung vor dem Typ", () => {
    const t = wt({
      frameWidth: 0.09,
      frameDepth: 0.1,
      insetFromFace: 0.05,
      insetFace: "innen",
      wingCount: 3,
      sashes: [{ kind: "fluegel", autoWidth: false, width: 0.5 }, { kind: "pfosten", postWidth: 0.1 }, { kind: "fluegel" }],
    });
    const o = win({ typeId: "wt", wingCount: 2 });
    expect(fillParams(proj({ windowTypes: [t] }), wall, o, cut(o), host)).toMatchObject({
      from: 1,
      to: 2.2,
      zBottom: 0.9,
      zTop: 2.1,
      nLo: -0.2,
      nHi: 0.2,
      frameDepth: 0.1,
      frameWidth: 0.09,
      inset: 0.05,
      insetOutside: false,
      wingCount: 2,
      panes: 3,
      sashes: [
        { post: false, fixed: true, width: 0.5 },
        { post: true, postWidth: 0.1, fixed: false },
        { post: false, fixed: false },
      ],
    });
    // Ohne Typ: nichts vom Typ, zwei Scheiben, eine Flügel.
    const p = fillParams(proj({}), wall, win(), cut(win()), host);
    expect(p).toMatchObject({ frameDepth: undefined, frameWidth: undefined, insetOutside: true, wingCount: 1, panes: 2, sashes: [] });
  });

  it("Tür: Art, Blätter, Aufschlag, Scharnier, Oberlicht, Glas", () => {
    const o = door({ typeId: "dt", hinge: "end", swing: "right", openingDir: "out" });
    const t = dtp({ kind: "schiebe", leafCount: 2, transomHeight: 0.4, leafStyle: "glas", glazingRatio: 0.36 });
    expect(fillParams(proj({ doorTypes: [t] }), wall, o, cut(o), host)).toMatchObject({
      doorKind: 1,
      leafCount: 2,
      swingSign: -1,
      dirSign: -1,
      hingeAtStart: false,
      transomHeight: 0.4,
      glazed: true,
      glazingRatio: 0.36,
    });
    const plain = fillParams(proj({}), wall, door(), cut(door()), host);
    expect(plain).toMatchObject({ doorKind: 0, leafCount: 1, swingSign: 1, dirSign: 1, hingeAtStart: true, transomHeight: 0, glazed: false });
    expect(fillParams(proj({}), wall, door({ doorType: "wandoeffnung" }), cut(door()), host).doorKind).toBe(2);
    expect(fillParams(proj({ doorTypes: [dtp({ kind: "wandoeffnung" })] }), wall, door({ typeId: "dt" }), cut(door()), host).doorKind).toBe(2);
  });
});
