// VORÜBERGEHEND ([K3c]): Zufallsprojekte und Schnitt-/Ansichtsebenen für den Gleichheitstest
// alt (TS) gegen neu (Kern). Wird mit dem Test gelöscht.

import type { DrawingLevel, ExtrudedSolid, Project, TerrainMesh, Wall } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { bigSampleProject } from "./bigSampleProject.testing";

export function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const round = (v: number) => Math.round(v * 1e4) / 1e4;

const HATCHES = ["none", "insulation", "diagonal", "crosshatch", "solid-concrete", "sia-concrete", "sia-brick", "sia-insulation", "missing-hatch"];
const COLORS = ["#ff0000", "#00aa33", " #123456 ", "#abc", "#000000"];

function terrain(r: () => number): TerrainMesh {
  const n = 12;
  const positions: number[] = [];
  const tilt = (r() - 0.5) * 0.3;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) positions.push(i * 2 - 8, j * 2 - 8, tilt * (i - 5) + (r() - 0.5) * 0.4 - 0.2);
  const indices: number[] = [];
  for (let j = 0; j + 1 < n; j++)
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i;
      indices.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  return { id: "terrain" + Math.floor(r() * 100), type: "terrainMesh", name: "Gelände", positions, indices, categoryCode: r() < 0.5 ? "99" : undefined } as TerrainMesh;
}

/** Zufallsprojekt auf Basis des Beispielhauses (Wände, Öffnungen, Dächer, Treppen, Abzugskörper, Overrides …). */
export function randomSectionProject(seed: number): Project {
  const r = rng(seed);
  const p = clone(sampleProject) as Project;
  const jit = (v: number, a: number) => round(v + (r() - 0.5) * a);
  // Wände: verschieben, Typen, Overrides, Terminierung, zusätzliche Wände
  const extra: Wall[] = [];
  for (let k = 0; k < Math.floor(r() * 4); k++) {
    const x0 = jit(2.5, 6), y0 = jit(2, 5);
    const ang = r() < 0.6 ? (r() < 0.5 ? 0 : Math.PI / 2) : r() * Math.PI;
    const len = 1 + r() * 4;
    extra.push({
      id: `WX${k}`, type: "wall", floorId: r() < 0.7 ? "eg" : "og", categoryCode: r() < 0.8 ? "20" : "22",
      start: { x: x0, y: y0 }, end: { x: round(x0 + Math.cos(ang) * len), y: round(y0 + Math.sin(ang) * len) },
      wallTypeId: pick(r, ["aw", "iw", "iw", "aw", "nope"]), height: round(2 + r()),
    } as Wall);
  }
  p.walls = [...p.walls, ...extra].map((w) => {
    const o: Wall = { ...w };
    if (r() < 0.2) o.start = { x: jit(o.start.x, 0.4), y: jit(o.start.y, 0.4) };
    if (r() < 0.2) o.end = { x: jit(o.end.x, 0.4), y: jit(o.end.y, 0.4) };
    if (r() < 0.15) o.wallTypeId = pick(r, ["aw", "iw"]);
    if (r() < 0.2) {
      o.hatchSource = pick(r, ["layer", "object"] as const);
      if (r() < 0.6) o.hatchId = pick(r, HATCHES);
    }
    if (r() < 0.15) { o.foreground = pick(r, COLORS); o.foregroundSource = pick(r, ["layer", "object"] as const); }
    if (r() < 0.15) { o.background = pick(r, COLORS); o.backgroundSource = pick(r, ["layer", "object"] as const); }
    if (r() < 0.3) o.sliceTermination = pick(r, ["below", "above", "both"] as const);
    if (r() < 0.1) o.height = round(1 + r() * 3);
    return o;
  });
  // Öffnungen
  const ops = [...(p.openings ?? [])];
  for (let k = 0; k < Math.floor(r() * 5); k++) {
    const host = pick(r, p.walls);
    const door = r() < 0.4;
    ops.push({
      id: `OX${k}`, type: "opening", hostWallId: host.id, categoryCode: r() < 0.9 ? "21" : "22",
      kind: door ? "door" : "window",
      typeId: door ? pick(r, ["door-standard", "door-entry", "nope", undefined]) : pick(r, ["window-standard", "window-double", "nope", undefined]),
      position: round(r() * 3), width: round(0.5 + r() * 1.5), height: round(0.8 + r() * 1.6), sillHeight: door ? 0 : round(r() * 1.2),
      ...(door && r() < 0.2 ? { doorType: "wandoeffnung" } : {}),
      ...(r() < 0.2 ? { wingCount: 1 + Math.floor(r() * 3) } : {}),
    } as never);
  }
  p.openings = ops.map((o) => (r() < 0.2 ? { ...o, position: jit(o.position, 1), width: Math.max(0.2, jit(o.width, 0.6)) } : o));
  // Decken
  p.ceilings = (p.ceilings ?? []).map((c) => ({
    ...c,
    ...(r() < 0.3 ? { thickness: round(0.1 + r() * 0.3) } : {}),
    ...(r() < 0.2 ? { ceilingTypeId: undefined, wallTypeId: pick(r, ["aw", "iw", "nope"]) } : {}),
    ...(r() < 0.2 ? { hatchSource: pick(r, ["layer", "object"] as const), hatchId: pick(r, HATCHES) } : {}),
  }));
  if (r() < 0.4) {
    p.ceilings!.push({ ...p.ceilings![0], id: "CX", floorId: "og", outline: [{ x: -1, y: -1 }, { x: 3, y: -1 }, { x: 3, y: 2 }, { x: -1, y: 2 }] });
  }
  // Dächer
  p.roofs = (p.roofs ?? []).map((rf) => ({
    ...rf,
    shape: pick(r, ["sattel", "walm", "pult", "flach", "mansarde", "zelt", "sattel"] as const),
    pitchDeg: round(10 + r() * 40),
    overhang: round(r() * 0.8),
    ridgeAxis: pick(r, ["x", "y"] as const),
    ...(r() < 0.5 ? { roofTypeId: "roof-warm" } : {}),
    ...(r() < 0.2 ? { color: pick(r, COLORS) } : {}),
    ...(r() < 0.3 ? { thickness: round(r() * 0.4) } : {}),
  }));
  if (r() < 0.3) p.roofs!.push({ ...p.roofs![0], id: "RX", outline: [{ x: 5, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 5, y: 3 }], shape: "pult", roofTypeId: undefined });
  // Treppen
  p.stairs = (p.stairs ?? []).map((st) => ({
    ...st,
    typeId: pick(r, ["stair-standard", "stair-massiv", "stair-wange-holz", "stair-aufgesattelt", undefined]),
    shape: pick(r, ["straight", "straight", "L", "spiral"] as const),
    ...(r() < 0.3 ? { start: { x: jit(st.start.x, 2), y: jit(st.start.y, 2) } } : {}),
  }));
  // Abzugskörper und freie Körper
  const solids: ExtrudedSolid[] = [];
  for (let k = 0; k < Math.floor(r() * 4); k++) {
    const cx = jit(2.5, 6), cy = jit(2, 5), w = 0.3 + r() * 1.5, d = 0.3 + r() * 1.5;
    solids.push({
      id: `X${k}`, type: "extrudedSolid", levelId: r() < 0.7 ? "eg" : "og",
      points: [{ x: cx, y: cy }, { x: round(cx + w), y: cy }, { x: round(cx + w), y: round(cy + d) }, { x: cx, y: round(cy + d) }],
      height: round(0.3 + r() * 2.5), baseOffset: round(r() * 1.5),
      ...(r() < 0.7 ? { operation: "subtract" } : {}),
    } as ExtrudedSolid);
  }
  p.extrudedSolids = solids;
  if (r() < 0.3) p.context = [terrain(r)];
  return p;
}

/** Schnitt-/Ansichtsebenen quer durch das Projekt (verschiedene Lagen, Richtungen, Tiefen). */
export function sectionLevels(p: Project, seed: number, count: number): DrawingLevel[] {
  const r = rng(seed * 7 + 1);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of p.walls) for (const q of [w.start, w.end]) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 5; maxY = 4; }
  const out: DrawingLevel[] = [];
  for (let k = 0; k < count; k++) {
    const kind = k % 2 === 0 ? "section" : "elevation";
    const mode = Math.floor(r() * 3);
    let a, b;
    if (mode === 0) {
      const y = round(minY - 1 + r() * (maxY - minY + 2));
      a = { x: minX - 1, y }; b = { x: maxX + 1, y };
    } else if (mode === 1) {
      const x = round(minX - 1 + r() * (maxX - minX + 2));
      a = { x, y: minY - 1 }; b = { x, y: maxY + 1 };
    } else {
      a = { x: round(minX - 1 + r() * 2), y: round(minY - 1 + r() * (maxY - minY)) };
      b = { x: round(maxX + 1 - r() * 2), y: round(minY + r() * (maxY - minY + 1)) };
    }
    if (r() < 0.5) [a, b] = [b, a];
    out.push({
      id: `lvl${k}`, name: `L${k}`, kind, visible: true, locked: false,
      linePoints: [a, b],
      directionSign: r() < 0.5 ? 1 : -1,
      ...(r() < 0.25 ? { depth: round(r() * 6) } : {}),
      ...(r() < 0.4 ? { shadows: true } : {}),
      ...(r() < 0.3 ? { hiddenLines: true } : {}),
    } as DrawingLevel);
  }
  return out;
}

/** Grosses Projekt mit Schnitt-/Ansichtslinien quer über alle Kacheln. */
export function bigSectionProject(n: number): Project {
  const p = bigSampleProject(n);
  const span = n * 8;
  const levels: DrawingLevel[] = [
    { id: "bs1", name: "S1", kind: "section", visible: true, locked: false, linePoints: [{ x: -2, y: 2 }, { x: span, y: 2 }], directionSign: 1 } as DrawingLevel,
    { id: "bs2", name: "S2", kind: "section", visible: true, locked: false, linePoints: [{ x: 3.5, y: -2 }, { x: 3.5, y: span }], directionSign: -1, hiddenLines: true } as DrawingLevel,
    { id: "be1", name: "E1", kind: "elevation", visible: true, locked: false, linePoints: [{ x: -2, y: -3 }, { x: span, y: -3 }], directionSign: 1, shadows: true } as DrawingLevel,
    { id: "be2", name: "E2", kind: "elevation", visible: true, locked: false, linePoints: [{ x: -3, y: span }, { x: -3, y: -2 }], directionSign: 1 } as DrawingLevel,
  ];
  return { ...p, drawingLevels: [...p.drawingLevels, ...levels] };
}
