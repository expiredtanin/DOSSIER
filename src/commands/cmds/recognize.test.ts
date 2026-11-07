/** `recognizeCommand` ([154]): Vorschau + Zähler beim Start, Bericht (B), Quelle (E), Enter = ein Commit. */
import { describe, expect, it } from "vitest";
import { recognizeCommand, reportText } from "./recognize";
import { resolveCommand } from "../registry";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

const poly = (id: string, code: string, pts: [number, number][], level = "imp"): Drawing2D =>
  ({ id, type: "drawing2d", levelId: level, categoryCode: code, geom: { shape: "polyline", closed: true, pts: pts.map(([x, y]) => ({ x, y })) } }) as Drawing2D;

/** Raum 5 × 4 (Achsen), Aussenwände 30 cm, Innenwand 15 cm, Tür mit Bogen, Raumtext — auf einer Zeichnungsebene. */
function project(): Project {
  return {
    id: "t", name: "T", lineStyles: [], hatches: [],
    components: [{ id: "brick", name: "Mauerwerk", color: "#a0522d" }] as Project["components"],
    wallTypes: [{ id: "aw", name: "Aussenwand 30", layers: [{ componentId: "brick", thickness: 0.3 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.8, cutHeight: 1.0, baseElevation: 0 },
      { id: "imp", name: "Import", kind: "drawing", visible: true, locked: false },
    ],
    layers: [
      { code: "20", name: "Wände", color: "#000000", lw: 0.5, visible: true, locked: false },
      { code: "101", name: "A-WALL", color: "#000000", lw: 0.5, visible: true, locked: false },
      { code: "102", name: "A-DOOR", color: "#000000", lw: 0.25, visible: true, locked: false },
    ],
    walls: [], openings: [], ceilings: [], stairs: [], rooms: [], context: [],
    drawings2d: [
      poly("o", "101", [[-0.15, -0.15], [1, -0.15], [1, 0.15], [0.15, 0.15], [0.15, 3.85], [4.85, 3.85], [4.85, 0.15], [1.9, 0.15], [1.9, -0.15], [5.15, -0.15], [5.15, 4.15], [-0.15, 4.15]]),
      poly("i", "101", [[2.425, 0.15], [2.575, 0.15], [2.575, 3.85], [2.425, 3.85]]),
      { id: "arc", type: "drawing2d", levelId: "imp", categoryCode: "102", geom: { shape: "arc", center: { x: 1, y: 0 }, r: 0.9, a0: 0, a1: Math.PI / 2 } } as Drawing2D,
      { id: "t1", type: "drawing2d", levelId: "imp", categoryCode: "102", geom: { shape: "text", at: { x: 0.5, y: 2 }, text: "Wohnen", height: 0.35, angle: 0 } } as Drawing2D,
    ],
  } as Project;
}

const ctxOf = (p: Project, drawingIds: string[] = []): CommandContext =>
  ({ project: p, level: p.drawingLevels[0], defaultCategoryCode: "20", activeLineStyleId: "solid", activeWallTypeId: "aw", lastPoint: null, selection: { wallIds: [], drawingId: null, drawingIds } }) as CommandContext;

describe("recognizeCommand", () => {
  it("Name und Kürzel", () => {
    expect(resolveCommand("erkennen")?.name).toBe("erkennen");
    expect(resolveCommand("bauteileerkennen")?.name).toBe("erkennen");
  });

  it("Start: Vorschau und Zähler aus der Zeichnungsebene, Enter übernimmt als ein Commit", () => {
    const p = project();
    const ctx = ctxOf(p);
    const start = recognizeCommand.autoRun!(ctx);
    expect(start.done).toBeFalsy();
    expect(start.draft?.preview.length).toBeGreaterThan(5);
    expect(start.notice?.key).toBe("cmd.recognize.summary");
    expect(start.notice?.params).toMatchObject({ walls: 5, doors: 1, windows: 0, voids: 0, rooms: 2 });
    const [, mv] = recognizeCommand.onMove(recognizeCommand.init(), { x: 1, y: 1 }, null, ctx);
    expect(mv.draft?.hud?.text).toContain("5");
    const [, r] = recognizeCommand.onConfirm(recognizeCommand.init(), ctx);
    expect(r.done).toBe(true);
    const next = r.commit!(p);
    expect(next.walls.length).toBe(5);
    expect(next.walls.every((w) => w.floorId === "eg" && w.height === 2.8)).toBe(true);
    expect(next.walls.filter((w) => w.wallTypeId === "aw").length).toBe(4);
    expect(next.wallTypes.length).toBe(2);
    expect(next.openings?.length).toBe(1);
    expect(next.openings?.[0].kind).toBe("door");
    expect(next.rooms?.map((x) => x.name).filter((n) => n === "Wohnen" || /^Raum \d$/.test(n)).length).toBe(2);
  });

  it("Auswahl: nur die gewählten Elemente", () => {
    const p = project();
    const r = recognizeCommand.autoRun!(ctxOf(p, ["i"]));
    expect(r.notice?.params).toMatchObject({ walls: 1, doors: 0, rooms: 0 });
  });

  it("Bericht (B) und Quelle (E)", () => {
    const p = project();
    const ctx = ctxOf(p);
    const [, rep] = recognizeCommand.onInput(recognizeCommand.init(), { kind: "option", id: "report" }, ctx);
    expect(rep.notice?.key).toBe("cmd.recognize.reportNotice");
    expect(String(rep.notice?.params?.text)).toMatch(/30|15/);
    const [s1] = recognizeCommand.onInput(recognizeCommand.init(), { kind: "option", id: "source" }, ctx);
    expect(recognizeCommand.options(s1)[0].value).toBe("Import");
  });

  it("Bericht-Text zählt unklare Stellen je Grund", () => {
    const txt = reportText({
      walls: 1, doors: 0, windows: 0, voids: 0, rooms: 0, arcWalls: 0, filledWalls: 0, unnamedRooms: 0, thicknesses: [0.3], layerFilter: true,
      unclear: [{ code: "doorArc", x: 0, y: 0 }, { code: "doorArc", x: 1, y: 0 }, { code: "gapWide", x: 0, y: 0 }],
    });
    expect(txt).toContain("2×");
    expect(txt).toContain("1×");
  });

  it("ohne Zeichnung: Vorbedingung meldet, nichts erkannt → kein Commit", () => {
    const p = { ...project(), drawings2d: [] };
    expect(recognizeCommand.precondition!(ctxOf(p))).toBe("cmd.recognize.noDrawing");
    const p2 = { ...project(), drawings2d: project().drawings2d.slice(3) };
    const [, r] = recognizeCommand.onConfirm(recognizeCommand.init(), ctxOf(p2));
    expect(r.commit).toBeUndefined();
    expect(r.notice?.key).toBe("cmd.recognize.nothing");
  });
});
