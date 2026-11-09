// [143] DXF-Höhenlinien (Layer-Name, Erhebung, 3D-Polylinie, Höhentexte) werden beim Import zu Gelände-Höhenlinien
// (`contourSet`) statt zu 2D-Zeichnungen; im leeren Projekt entsteht daraus mit „Gelände erzeugen" das Geländemodell.

import { beforeAll, describe, expect, it } from "vitest";
import { parseDxf } from "./dxfParser";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { importInto } from "./importView.testutil";
import { emptyProject } from "../model/sampleProject";
import { terrainCommand } from "../commands/cmds/terrain";
import type { CommandContext } from "../commands/types";
import type { Project } from "../model/types";

beforeAll(loadFileioForTests);

function dxf(...entities: string[][]): string {
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (const pairs of entities) lines.push(...pairs);
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

/** Rechteck-Ring (Kantenlänge 2·r) als LWPOLYLINE mit Erhebung (Gruppe 38). */
const ring = (layer: string, r: number, z: number | null): string[] => [
  "0", "LWPOLYLINE", "8", layer, "90", "4", "70", "1", ...(z === null ? [] : ["38", String(z)]),
  "10", String(-r), "20", String(-r), "10", String(r), "20", String(-r), "10", String(r), "20", String(r), "10", String(-r), "20", String(r),
];

/** 3D-Polylinie (POLYLINE-Flag 8) mit konstantem Z als offener Zug. */
const poly3d = (layer: string, y: number, z: number): string[] => [
  "0", "POLYLINE", "8", layer, "70", "8",
  ...[0, 5, 10].flatMap((x) => ["0", "VERTEX", "8", layer, "70", "32", "10", String(x), "20", String(y), "30", String(z)]),
  "0", "SEQEND",
];

const text = (layer: string, s: string, x: number, y: number): string[] => ["0", "TEXT", "8", layer, "10", String(x), "20", String(y), "40", "0.5", "1", s];

const ctxOf = (p: Project): CommandContext => ({
  project: p,
  level: p.drawingLevels.find((l) => l.kind === "floor")!,
  defaultCategoryCode: p.layers[0].code,
  activeLineStyleId: "solid",
  activeWallTypeId: p.wallTypes[0]?.id ?? "",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null, drawingIds: [] } as unknown as CommandContext["selection"],
});

const sets = (p: Project) => (p.context ?? []).filter((o) => o.type === "contourSet");

describe("[143] DXF-Höhenlinien als Gelände", () => {
  it("erkennt Polylinien mit Erhebung auf einem Höhenlinien-Layer und zählt sie in der Zusammenfassung", () => {
    const parsed = parseDxf(dxf(ring("Hoehenlinien", 5, 430), ring("Hoehenlinien", 10, 431), ring("Hoehenlinien", 15, 432), ring("Wände", 3, null)));
    expect(parsed.summary.terrainContours).toBe(3);
    const r = importInto(emptyProject, parsed, { terrainContours: true, terrainName: "HL" });
    expect(r.terrainContours).toBe(3);
    expect(r.drawings).toHaveLength(1); // nur die Wand-Linie bleibt Zeichnung
    const [set] = sets(r.project);
    expect(set).toMatchObject({ type: "contourSet", name: "HL", categoryCode: "02" });
    if (set.type !== "contourSet") return;
    expect(set.contours.map((c) => c.z)).toEqual([430, 431, 432]);
    expect(set.contours.every((c) => c.closed && c.pts.length === 4)).toBe(true);
  });

  it("ohne die Option bleibt alles 2D-Zeichnung", () => {
    const parsed = parseDxf(dxf(ring("Hoehenlinien", 5, 430), ring("Hoehenlinien", 10, 431)));
    const r = importInto(emptyProject, parsed, { terrainContours: false });
    expect(r.terrainContours).toBe(0);
    expect(r.drawings).toHaveLength(2);
    expect(sets(r.project)).toHaveLength(0);
  });

  it("3D-Polylinien mit konstantem Z auf beliebigem Layer (drei Höhen), Gefälle-Linien nicht", () => {
    const parsed = parseDxf(dxf(poly3d("L1", 0, 100), poly3d("L1", 10, 101), poly3d("L1", 20, 102)));
    expect(parsed.summary.terrainContours).toBe(3);
    const sloped = [
      "0", "POLYLINE", "8", "L1", "70", "8",
      ...[100, 101, 102].flatMap((z, i) => ["0", "VERTEX", "8", "L1", "70", "32", "10", String(i), "20", "30", "30", String(z)]),
      "0", "SEQEND",
    ];
    expect(parseDxf(dxf(poly3d("L1", 0, 100), poly3d("L1", 10, 101), sloped)).summary.terrainContours).toBeUndefined();
  });

  it("Höhentexte ersetzen fehlendes Z; die Texte werden nicht noch einmal Zeichnung", () => {
    const parsed = parseDxf(
      dxf(ring("HL", 5, null), ring("HL", 10, null), text("Kote", "432.50", 0, 5.1), text("Kote", "433,0", 0, 10.1), text("Kote", "Hang", 0, 5)),
    );
    expect(parsed.summary.terrainContours).toBe(2);
    expect(parsed.summary.terrainFromTexts).toBe(2);
    const r = importInto(emptyProject, parsed, { terrainContours: true });
    const [set] = sets(r.project);
    if (set?.type !== "contourSet") throw new Error("contourSet erwartet");
    expect(set.contours.map((c) => c.z).sort()).toEqual([432.5, 433]);
    expect(r.drawings).toHaveLength(1); // Text „Hang"
  });

  it("im leeren Projekt entsteht mit „Gelände erzeugen“ das Geländemodell aus den importierten Linien", () => {
    const parsed = parseDxf(dxf(ring("Hoehenlinien", 5, 430), ring("Hoehenlinien", 10, 431), ring("Hoehenlinien", 15, 432), ring("Hoehenlinien", 20, 433)));
    const r = importInto(emptyProject, parsed, { terrainContours: true });
    const res = terrainCommand.autoRun!(ctxOf(r.project));
    expect(res.notice).toBeUndefined();
    const out = res.commit!(r.project);
    expect((out.context ?? []).filter((o) => o.type === "terrainMesh")).toHaveLength(1);
  });
});
