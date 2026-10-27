/**
 * `extendCommand` — Gegenstück zu Trim (`extendSegment` im Kernel existierte
 * bereits, hatte aber keinen Aufrufer). Test: eine kurze Linie wird bis zu
 * einer kreuzenden Cutter-Linie verlängert.
 */

import { describe, it, expect } from "vitest";
import { extendCommand } from "./extend";
import { bulgeArc } from "../../geometry/bulge";
import type { CommandContext, Project } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [
      // Cutter: vertikale Linie bei x=5, deckt y=-10..10 ab.
      { id: "cutter", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 5, y: -10 }, b: { x: 5, y: 10 } } },
      // Ziel: kurze horizontale Linie von (0,0) bis (3,0) — reicht nicht bis zum Cutter.
      { id: "target", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } } },
    ],
    context: [],
  };
}

function makeCtx(p: Project): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("extendCommand", () => {
  it("verlängert das nähere Ende der Linie bis zum nächsten Cutter", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 3, y: 0 } }, // nahe am Ende (3,0) der Ziellinie
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const target = next.drawings2d.find((d) => d.id === "target")!;
    expect(target.geom.shape).toBe("line");
    if (target.geom.shape === "line") {
      expect(target.geom.a).toEqual({ x: 0, y: 0 }); // unverändertes Ende bleibt stehen
      expect(target.geom.b.x).toBeCloseTo(5, 9); // bis zum Cutter (x=5) verlängert
      expect(target.geom.b.y).toBeCloseTo(0, 9);
    }
  });

  it("kein Cutter getroffen → No-op (kein commit-Effekt)", () => {
    const p = project();
    // Cutter entfernen: nichts zum Verlängern-bis da.
    p.drawings2d = p.drawings2d.filter((d) => d.id !== "cutter");
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 3, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next).toBe(p); // unverändert (No-op)
  });
});

/**
 * `extendBulgeSegment` — ist das äusserste Segment ein echter Bogen (bulge),
 * muss die Verlängerung DENSELBEN Kreis weiterschwenken (Mittelpunkt/Radius
 * unverändert), nicht die Sehne zur Geraden verlängern.
 */
function bulgeProject(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [
      // Cutter: waagrechte Linie bei y=-1 — tangential an den Einheitskreis unten (0,-1).
      { id: "cutter", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: -10, y: -1 }, b: { x: 10, y: -1 } } },
      // Ziel: oberer Halbkreis von (-1,0) nach (1,0), bulge=1 (Apex bei (0,1)).
      { id: "target", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "polyline", pts: [{ x: -1, y: 0 }, { x: 1, y: 0 }], closed: false, bulge: [1] } },
    ],
    context: [],
  };
}

describe("extendCommand — Bogen-Enden (bulge)", () => {
  it("verlängert das Ende-Segment (Bogen) auf DEMSELBEN Kreis bis zum Cutter", () => {
    const p = bulgeProject();
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 1, y: 0 } }, // nahe am Ende (1,0)
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const target = next.drawings2d.find((d) => d.id === "target")!;
    expect(target.geom.shape).toBe("polyline");
    if (target.geom.shape !== "polyline") return;
    expect(target.geom.pts[0]).toEqual({ x: -1, y: 0 }); // unverändertes Ende bleibt stehen
    // Neuer Endpunkt: der Bogen wächst über die obere Hälfte hinaus bis zur
    // Tangente y=-1 — trifft exakt den Berührpunkt (0,-1).
    expect(target.geom.pts[1].x).toBeCloseTo(0, 6);
    expect(target.geom.pts[1].y).toBeCloseTo(-1, 6);
    // Der neue bulge-Wert muss wieder DENSELBEN Kreis (Mittelpunkt/Radius) ergeben.
    const bulge = target.geom.bulge?.[0];
    expect(bulge).toBeDefined();
    const arc = bulgeArc(target.geom.pts[0], target.geom.pts[1], bulge!);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 6);
    expect(arc!.center.y).toBeCloseTo(0, 6);
    expect(arc!.r).toBeCloseTo(1, 6);
  });

  it("verlängert das Start-Segment (Bogen) symmetrisch, wenn das nähere Ende der Kurvenanfang ist", () => {
    const p = bulgeProject();
    // Zusätzliches gerades Segment ab (1,0), damit das Bogen-Segment (Index 0)
    // NICHT mehr das letzte, sondern weiterhin das erste (Start-)Segment ist.
    const target = p.drawings2d.find((d) => d.id === "target")!;
    if (target.geom.shape === "polyline") {
      target.geom.pts.push({ x: 2, y: 0 });
      target.geom.bulge = [1, 0];
    }
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: -1, y: 0 } }, // nahe am Kurvenanfang (-1,0)
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const out = next.drawings2d.find((d) => d.id === "target")!;
    expect(out.geom.shape).toBe("polyline");
    if (out.geom.shape !== "polyline") return;
    expect(out.geom.pts[out.geom.pts.length - 1]).toEqual({ x: 2, y: 0 }); // anderes Ende unverändert
    expect(out.geom.pts[0].x).toBeCloseTo(0, 6);
    expect(out.geom.pts[0].y).toBeCloseTo(-1, 6);
    const bulge = out.geom.bulge?.[0];
    expect(bulge).toBeDefined();
    const arc = bulgeArc(out.geom.pts[0], out.geom.pts[1], bulge!);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 6);
    expect(arc!.center.y).toBeCloseTo(0, 6);
    expect(arc!.r).toBeCloseTo(1, 6);
  });

  it("kein Cutter auf dem Bogen getroffen → No-op", () => {
    const p = bulgeProject();
    p.drawings2d = p.drawings2d.filter((d) => d.id !== "cutter");
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 1, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next).toBe(p);
  });
});
