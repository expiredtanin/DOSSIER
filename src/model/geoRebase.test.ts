import { describe, it, expect } from "vitest";
import type { Column, ExtrudedSolid, Project } from "./types";
import { sampleProject } from "./sampleProject";
import { translateProject } from "./geoRebase";

const DX = 100;
const DY = -50;

describe("translateProject", () => {
  it("dx=dy=0 -> unverändertes Projekt (Referenzgleichheit)", () => {
    expect(translateProject(sampleProject, 0, 0)).toBe(sampleProject);
  });

  it("verschiebt Wand-Achsen (start/end)", () => {
    const out = translateProject(sampleProject, DX, DY);
    const w = sampleProject.walls[0];
    const ow = out.walls.find((x) => x.id === w.id)!;
    expect(ow.start).toEqual({ x: w.start.x + DX, y: w.start.y + DY });
    expect(ow.end).toEqual({ x: w.end.x + DX, y: w.end.y + DY });
  });

  it("verschiebt Decken-Umriss inkl. Aussparungen", () => {
    const withHole: Project = {
      ...sampleProject,
      ceilings: [
        {
          ...sampleProject.ceilings![0],
          openings: [
            [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
          ],
        },
      ],
    };
    const out = translateProject(withHole, DX, DY);
    const oc = out.ceilings![0];
    const src = withHole.ceilings![0];
    expect(oc.outline).toEqual(src.outline.map((p) => ({ x: p.x + DX, y: p.y + DY })));
    expect(oc.openings![0]).toEqual(src.openings![0].map((p) => ({ x: p.x + DX, y: p.y + DY })));
  });

  it("verschiebt Dach-Umriss", () => {
    const out = translateProject(sampleProject, DX, DY);
    const r = sampleProject.roofs![0];
    const or_ = out.roofs!.find((x) => x.id === r.id)!;
    expect(or_.outline).toEqual(r.outline.map((p) => ({ x: p.x + DX, y: p.y + DY })));
  });

  it("Treppe: start/center verschieben sich, dir (Richtungsvektor) bleibt unverändert", () => {
    const withSpiral: Project = {
      ...sampleProject,
      stairs: [...sampleProject.stairs!, { ...sampleProject.stairs![0], id: "ST2", center: { x: 5, y: 5 } }],
    };
    const out = translateProject(withSpiral, DX, DY);
    const st1 = out.stairs!.find((s) => s.id === "ST1")!;
    const st2 = out.stairs!.find((s) => s.id === "ST2")!;
    expect(st1.start).toEqual({ x: sampleProject.stairs![0].start.x + DX, y: sampleProject.stairs![0].start.y + DY });
    expect(st1.dir).toEqual(sampleProject.stairs![0].dir); // Richtung bleibt
    expect(st2.center).toEqual({ x: 5 + DX, y: 5 + DY });
  });

  it("Raum: boundary + stampAnchor verschieben sich", () => {
    const out = translateProject(sampleProject, DX, DY);
    const r = sampleProject.rooms![0];
    const or_ = out.rooms!.find((x) => x.id === r.id)!;
    expect(or_.boundary).toEqual(r.boundary.map((p) => ({ x: p.x + DX, y: p.y + DY })));
    expect(or_.stampAnchor).toEqual({ x: r.stampAnchor!.x + DX, y: r.stampAnchor!.y + DY });
  });

  it("Stütze: position verschiebt sich, rotation bleibt unverändert", () => {
    const col: Column = {
      id: "C1",
      type: "column",
      floorId: "eg",
      categoryCode: "50",
      position: { x: 2, y: 3 },
      profile: { kind: "round", radius: 0.15 },
      rotation: Math.PI / 4,
      height: 2.6,
    };
    const withColumn: Project = { ...sampleProject, columns: [col] };
    const out = translateProject(withColumn, DX, DY);
    const oc = out.columns![0];
    expect(oc.position).toEqual({ x: 2 + DX, y: 3 + DY });
    expect(oc.rotation).toBe(col.rotation);
  });

  it("Extrusion: points + Kreis-Mitte verschieben sich", () => {
    const solid: ExtrudedSolid = {
      id: "EX1",
      type: "extrudedSolid",
      levelId: "eg",
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
      height: 1,
      circle: { center: { x: 5, y: 5 }, r: 1 },
    };
    const withSolid: Project = { ...sampleProject, extrudedSolids: [solid] };
    const out = translateProject(withSolid, DX, DY);
    const os = out.extrudedSolids![0];
    expect(os.points).toEqual(solid.points.map((p) => ({ x: p.x + DX, y: p.y + DY })));
    expect(os.circle!.center).toEqual({ x: 5 + DX, y: 5 + DY });
  });

  it("Drawing2D: alle Geometrie-Varianten verschieben ihre Punkte", () => {
    const withDrawings: Project = {
      ...sampleProject,
      drawings2d: [
        { id: "D1", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } },
        { id: "D2", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false } },
        { id: "D3", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "rect", min: { x: 0, y: 0 }, max: { x: 1, y: 1 } } },
        { id: "D4", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "circle", center: { x: 1, y: 1 }, r: 0.5 } },
        { id: "D5", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "arc", center: { x: 2, y: 2 }, r: 0.5, a0: 0, a1: 1 } },
        { id: "D6", type: "drawing2d", levelId: "eg", categoryCode: "10", geom: { shape: "text", at: { x: 3, y: 3 }, text: "x", height: 0.2, angle: 0.7 } },
      ],
    };
    const out = translateProject(withDrawings, DX, DY);
    const byId = (id: string) => out.drawings2d.find((d) => d.id === id)!.geom;
    expect(byId("D1")).toMatchObject({ a: { x: DX, y: DY }, b: { x: 1 + DX, y: 1 + DY } });
    expect(byId("D2")).toMatchObject({ pts: [{ x: DX, y: DY }, { x: 1 + DX, y: DY }] });
    expect(byId("D3")).toMatchObject({ min: { x: DX, y: DY }, max: { x: 1 + DX, y: 1 + DY } });
    expect(byId("D4")).toMatchObject({ center: { x: 1 + DX, y: 1 + DY } });
    expect(byId("D5")).toMatchObject({ center: { x: 2 + DX, y: 2 + DY }, a0: 0, a1: 1 }); // Winkel unverändert
    expect(byId("D6")).toMatchObject({ at: { x: 3 + DX, y: 3 + DY }, angle: 0.7 }); // Winkel unverändert
  });

  it("Kontext-Mesh: nur x/y verschieben sich, Höhe (z) bleibt", () => {
    const withContext: Project = {
      ...sampleProject,
      context: [
        {
          id: "CTX1",
          type: "importedMesh",
          name: "Test",
          positions: [0, 0, 5, 2, 3, 7],
          indices: [0, 1, 0],
        },
      ],
    };
    const out = translateProject(withContext, DX, DY);
    const obj = out.context![0];
    if (obj.type !== "importedMesh") throw new Error("expected importedMesh");
    expect(obj.positions).toEqual([0 + DX, 0 + DY, 5, 2 + DX, 3 + DY, 7]);
  });

  it("Konturen-Satz: Punkte + Kreis-/Bogen-Mitte verschieben sich, Winkel bleiben", () => {
    const withContours: Project = {
      ...sampleProject,
      context: [
        {
          id: "CS1",
          type: "contourSet",
          name: "Höhenlinien",
          contours: [
            {
              z: 400,
              pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
              closed: false,
              curve: { kind: "arc", cx: 1, cy: 1, r: 0.5, a0: 0, a1: 1 },
            },
          ],
        },
      ],
    };
    const out = translateProject(withContours, DX, DY);
    const obj = out.context![0];
    if (obj.type !== "contourSet") throw new Error("expected contourSet");
    expect(obj.contours[0].pts).toEqual([{ x: DX, y: DY }, { x: 1 + DX, y: DY }]);
    expect(obj.contours[0].curve).toEqual({ kind: "arc", cx: 1 + DX, cy: 1 + DY, r: 0.5, a0: 0, a1: 1 });
  });

  it("Schnittlinie (DrawingLevel.linePoints) verschiebt sich", () => {
    const withSection: Project = {
      ...sampleProject,
      drawingLevels: [
        ...sampleProject.drawingLevels,
        {
          id: "SEC1",
          name: "Schnitt A",
          kind: "section",
          visible: true,
          locked: false,
          linePoints: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        },
      ],
    };
    const out = translateProject(withSection, DX, DY);
    const lvl = out.drawingLevels.find((l) => l.id === "SEC1")!;
    expect(lvl.linePoints).toEqual([{ x: DX, y: DY }, { x: 5 + DX, y: DY }]);
  });

  it("geoAnchor.model verschiebt sich mit, lv95 bleibt unverändert (Bezug bleibt exakt erhalten)", () => {
    const withAnchor: Project = {
      ...sampleProject,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 }, label: "Test" },
    };
    const out = translateProject(withAnchor, DX, DY);
    expect(out.geoAnchor).toEqual({ lv95: { e: 2600000, n: 1200000 }, model: { x: DX, y: DY }, label: "Test" });
  });

  it("kein geoAnchor gesetzt -> bleibt undefined", () => {
    const out = translateProject(sampleProject, DX, DY);
    expect(out.geoAnchor).toBeUndefined();
  });
});
