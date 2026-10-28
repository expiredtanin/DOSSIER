// Testhilfe ([K3d]): grosses Projekt für Messungen — das Beispielhaus n × n Mal gekachelt
// (n = 20: 3600 Wände, 1200 Öffnungen, 400 Decken/Räume/Treppen/Dächer, 1600 Stützen).
// Ids bekommen ein Kachel-Suffix, Verweise (Öffnung → Wand) werden mitgeführt.

import type { Column, Project, Vec2 } from "../model/types";
import { sampleProject } from "../model/sampleProject";

const shift = (p: Vec2, dx: number, dy: number): Vec2 => ({ x: p.x + dx, y: p.y + dy });

export function bigSampleProject(n = 20, pitch = 8): Project {
  const s = sampleProject;
  const out: Project = {
    ...s,
    walls: [],
    openings: [],
    ceilings: [],
    roofs: [],
    stairs: [],
    rooms: [],
    columns: [],
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = i * pitch;
      const dy = j * pitch;
      const sfx = `_${i}_${j}`;
      for (const w of s.walls) out.walls.push({ ...w, id: w.id + sfx, start: shift(w.start, dx, dy), end: shift(w.end, dx, dy) });
      for (const o of s.openings ?? []) out.openings!.push({ ...o, id: o.id + sfx, hostWallId: o.hostWallId + sfx });
      for (const c of s.ceilings ?? []) out.ceilings!.push({ ...c, id: c.id + sfx, outline: c.outline.map((p) => shift(p, dx, dy)) });
      for (const r of s.roofs ?? []) out.roofs!.push({ ...r, id: r.id + sfx, outline: r.outline.map((p) => shift(p, dx, dy)) });
      for (const st of s.stairs ?? []) out.stairs!.push({ ...st, id: st.id + sfx, start: shift(st.start, dx, dy) });
      for (const r of s.rooms ?? []) {
        out.rooms!.push({
          ...r,
          id: r.id + sfx,
          boundary: r.boundary.map((p) => shift(p, dx, dy)),
          ...(r.stampAnchor ? { stampAnchor: shift(r.stampAnchor, dx, dy) } : {}),
        });
      }
      for (let k = 0; k < 4; k++) {
        const col: Column = {
          id: `COL${k}${sfx}`,
          type: "column",
          floorId: "eg",
          categoryCode: "50",
          position: { x: dx + 1 + k, y: dy + 2 },
          profile: k % 2 ? { kind: "round", radius: 0.12 } : { kind: "rect", width: 0.25, depth: 0.25 },
          rotation: k * 0.3,
          height: 2.6,
        };
        out.columns!.push(col);
      }
    }
  }
  return out;
}
