// [270] Die Blender-Kopie der Blickrichtungen (`scripts/blender/render_dossier.py`, PRESET_DIRECTIONS) stimmt mit der
// gemeinsamen Tabelle `render3d::view_dir` überein — hier über die Orbit-Startlagen der 3D-Ansicht (`VIEW3D_ORBIT`,
// selbst gegen die Himmelsrichtungen geprüft in `viewport/view270.test.ts`). „Südost“ = Betrachter im Südosten.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEW3D_ORBIT } from "./cameraBridge";
import type { View3d } from "../model/viewTypes";

const ALIAS: Record<string, View3d> = {
  iso: "iso", southeast: "iso", southwest: "isoFrontLeft", northeast: "isoBackRight", northwest: "isoBackLeft",
  perspective: "perspective", front: "front", south: "front", back: "back", north: "back",
  side: "side", right: "side", east: "side", left: "left", west: "left",
};

function pythonTable(): Record<string, [number, number, number]> {
  const src = readFileSync(new URL("../../scripts/blender/render_dossier.py", import.meta.url), "utf8");
  const block = src.split("PRESET_DIRECTIONS = {")[1].split("\n}")[0];
  const out: Record<string, [number, number, number]> = {};
  for (const m of block.matchAll(/"(\w+)":\s*\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

describe("[270] Blickrichtungen Blender = 3D-Ansicht", () => {
  it("jede Voreinstellung des Skripts blickt wie der gleichnamige Blickwinkel", () => {
    const py = pythonTable();
    expect(Object.keys(py).length).toBeGreaterThanOrEqual(16);
    for (const [name, d] of Object.entries(py)) {
      if (name === "top") {
        expect(d).toEqual([0, 0, -1]);
        continue;
      }
      const view = ALIAS[name];
      expect(view, name).toBeDefined();
      const { yaw, pitch } = VIEW3D_ORBIT[view];
      // Richtung zum Betrachter in Modell-Koordinaten (world (x, Höhe, y) → Modell (x, y, Höhe)).
      const toViewer = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch)];
      const l = Math.hypot(...d);
      toViewer.forEach((v, i) => expect(-d[i] / l, `${name}[${i}]`).toBeCloseTo(v, 5));
    }
  });
});
