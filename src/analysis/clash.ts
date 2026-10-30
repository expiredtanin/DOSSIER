// Kollisionsprüfung (truck-meshalgo): findet Durchdringungen zwischen freien Körpern
// (Extrusionen/B-Rep-Grundkörper, importierte Meshes) und allen übrigen Bauteilen
// (Wandschichten, Decken, andere Körper). Wand↔Wand und Wand↔Decke werden NICHT geprüft —
// sie greifen konstruktiv ineinander (Gehrungen, Auflager) und wären reine Falschmeldungen.
//
// Ergebnis: je Kollision ein Paar + Durchdringungsvolumen + Mittelpunkt. `clashMarkers`
// macht daraus rote Markierungen (Kreis + Text, nicht druckend) auf dem passenden Geschoss.

import type { Drawing2D, Project, Vec2 } from "../model/types";
import { addItems, removeItems } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";
import { getFloor } from "../model/types";
import { projectToModel3d } from "../plan/toWalls3d";
import { extrudedSolidSpec } from "../plan/extrudedSolidSpec";
import { wallSpec } from "../plan/wallSpec";
import { solidClash, solidProps } from "../engine/truckSolid";
import type { SolidSpec } from "../engine/truckSolid";

export type ClashKind = "wall" | "slab" | "solid" | "mesh";

export interface ClashItem {
  /** Id des Ursprungs-Elements (Wand, Decke, Körper, Import). */
  id: string;
  kind: ClashKind;
  spec: SolidSpec;
}

export interface Clash {
  a: ClashItem;
  b: ClashItem;
  /** Durchdringungsvolumen (m³), `null` wenn nicht berechenbar. */
  volume: number | null;
  /** Mittelpunkt der Durchdringungslinien (Modell-Meter, z = Höhe). */
  center: [number, number, number];
  /** Hüllquader der Durchdringungslinien (Modell-Meter) — für Hervorhebung und Zoom. */
  min: [number, number, number];
  max: [number, number, number];
}

/** Prefix der Marker-Ids (ein neuer Lauf ersetzt die alten Marker). */
export const CLASH_MARKER_PREFIX = "clash-";
/** Kleinere Überlappung gilt als Berührung (Rundung, bündige Flächen). */
const MIN_VOLUME = 1e-5;

const FREE: ReadonlySet<ClashKind> = new Set(["solid", "mesh"]);

/** Alle prüfbaren Bauteile des Projekts (reiner Kern, kein WASM). */
export function clashItems(project: Project): ClashItem[] {
  const out: ClashItem[] = [];
  const model = projectToModel3d(project, { layeredWalls: true });
  for (const w of model.walls) {
    const spec = wallSpec(w);
    if (spec) out.push({ id: w.wallId, kind: "wall", spec });
  }
  for (const s of model.slabs) {
    if (s.outline.length < 3 || s.zTop - s.zBottom < 1e-4) continue;
    out.push({
      id: s.ceilingId,
      kind: "slab",
      spec: { kind: "extrude", points: s.outline.flatMap((p) => [p[0], p[1]]), height: s.zTop - s.zBottom, z0: s.zBottom },
    });
  }
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.operation === "subtract") continue; // Abzugskörper sind gewollte Durchdringungen
    let baseZ = 0;
    try {
      baseZ = solid.levelId ? (getFloor(project, solid.levelId).baseElevation ?? 0) : 0;
    } catch {
      baseZ = 0;
    }
    const spec = extrudedSolidSpec(solid, baseZ);
    if (spec) out.push({ id: solid.id, kind: "solid", spec });
  }
  for (const m of project.context ?? []) {
    if (m.type !== "importedMesh") continue;
    if (m.indices.length >= 12) out.push({ id: m.id, kind: "mesh", spec: { kind: "mesh", positions: m.positions, indices: m.indices } });
  }
  return out;
}

type Box = { min: [number, number, number]; max: [number, number, number] };

const overlaps = (a: Box, b: Box, eps = 0.002): boolean =>
  a.min[0] < b.max[0] - eps && b.min[0] < a.max[0] - eps &&
  a.min[1] < b.max[1] - eps && b.min[1] < a.max[1] - eps &&
  a.min[2] < b.max[2] - eps && b.min[2] < a.max[2] - eps;

/** Zu prüfende Paare: mindestens ein freier Körper, Hüllquader überlappen (reiner Kern). */
export function candidatePairs(items: ClashItem[], boxes: Box[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!FREE.has(items[i].kind) && !FREE.has(items[j].kind)) continue;
      if (items[i].id === items[j].id) continue;
      if (overlaps(boxes[i], boxes[j])) pairs.push([i, j]);
    }
  }
  return pairs;
}

/** Führt die Kollisionsprüfung aus. `onProgress(done, total)` für lange Läufe. */
export async function runClashCheck(
  project: Project,
  onProgress?: (done: number, total: number) => void,
): Promise<Clash[]> {
  const items = clashItems(project);
  const boxes: Box[] = [];
  const valid: boolean[] = [];
  for (const it of items) {
    try {
      const p = await solidProps(it.spec, 0.02);
      boxes.push({ min: p.min, max: p.max });
      valid.push(true);
    } catch {
      boxes.push({ min: [0, 0, 0], max: [0, 0, 0] });
      valid.push(false);
    }
  }
  const pairs = candidatePairs(items, boxes).filter(([i, j]) => valid[i] && valid[j]);
  const found = new Map<string, Clash>();
  let done = 0;
  for (const [i, j] of pairs) {
    onProgress?.(done++, pairs.length);
    let r;
    try {
      r = await solidClash(items[i].spec, items[j].spec, 0.01);
    } catch {
      continue;
    }
    if (!r.colliding || r.lines.length === 0) continue;
    if (r.overlapVolume !== null && r.overlapVolume < MIN_VOLUME) continue;
    const c: [number, number, number] = [0, 0, 0];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const l of r.lines) {
      for (let k = 0; k < 3; k++) {
        c[k] += (l[k] + l[k + 3]) / 2;
        min[k] = Math.min(min[k], l[k], l[k + 3]);
        max[k] = Math.max(max[k], l[k], l[k + 3]);
      }
    }
    const n = r.lines.length;
    const clash: Clash = { a: items[i], b: items[j], volume: r.overlapVolume, center: [c[0] / n, c[1] / n, c[2] / n], min, max };
    // Mehrere Wandschichten derselben Wand → eine Kollision (grösstes Volumen).
    const key = [items[i].id, items[j].id].sort().join("|");
    const prev = found.get(key);
    if (!prev || (clash.volume ?? 0) > (prev.volume ?? 0)) found.set(key, clash);
  }
  onProgress?.(pairs.length, pairs.length);
  return [...found.values()];
}

/** Geschoss, in dessen Höhenbereich `z` liegt (sonst das unterste). */
export function floorAtElevation(project: Project, z: number): string | null {
  const floors = project.drawingLevels
    .filter((l) => l.kind === "floor")
    .sort((a, b) => (a.baseElevation ?? 0) - (b.baseElevation ?? 0));
  let best: string | null = floors[0]?.id ?? null;
  for (const f of floors) if ((f.baseElevation ?? 0) <= z + 1e-6) best = f.id;
  return best;
}

/** Ersetzt alte Kollisions-Marker durch neue (Kreis + Beschriftung, rot, nicht druckend). */
export function clashMarkerOps(project: Project, clashes: Clash[], categoryCode: string): CoreOp[] {
  const markers: Drawing2D[] = [];
  clashes.forEach((c, k) => {
    const levelId = floorAtElevation(project, c.center[2]);
    if (!levelId) return;
    const at: Vec2 = { x: c.center[0], y: c.center[1] };
    const base = { type: "drawing2d" as const, levelId, categoryCode, color: "#e0242a", noPrint: true };
    markers.push({ ...base, id: `${CLASH_MARKER_PREFIX}${k}-c`, geom: { shape: "circle", center: at, r: 0.35 } });
    const vol = c.volume !== null ? ` ${c.volume.toFixed(3)} m³` : "";
    markers.push({
      ...base,
      id: `${CLASH_MARKER_PREFIX}${k}-t`,
      geom: { shape: "text", at: { x: at.x + 0.45, y: at.y + 0.1 }, text: `K${k + 1}${vol}`, height: 0.2, angle: 0 },
    });
  });
  // Frühere Marken raus, neue hinten dran.
  return [
    ...removeItems(project, "drawings2d", (d) => d.id.startsWith(CLASH_MARKER_PREFIX)),
    ...addItems("drawings2d", markers),
  ];
}

/**
 * Rote Hüllquader der Kollisionen als Linienliste für den 3D-Viewport (`set_highlight_lines`):
 * `[x, y, z, r, g, b]` je Vertex, 2 Vertices je Kante, 12 Kanten je Kollision. Modell (x, y, Höhe)
 * → Viewport-Welt (x, Höhe, y). Mindestkantenlänge 0.1 m, damit hauchdünne Durchdringungen sichtbar bleiben.
 */
export function clashHighlightLines(clashes: Clash[], rgb: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(clashes.length * 12 * 2 * 6);
  let o = 0;
  const vert = (p: readonly number[]) => {
    out[o++] = p[0];
    out[o++] = p[2];
    out[o++] = p[1];
    out[o++] = rgb[0];
    out[o++] = rgb[1];
    out[o++] = rgb[2];
  };
  for (const c of clashes) {
    const lo = [0, 1, 2].map((k) => Math.min(c.min[k], c.center[k] - 0.05));
    const hi = [0, 1, 2].map((k) => Math.max(c.max[k], c.center[k] + 0.05));
    const corner = (i: number) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        vert(corner(i));
        vert(corner(i | bit));
      }
    }
  }
  return out;
}

/** Bauteile einer Kollision je Auswahlkanal (Wand, Decke, Körper, Import). */
export function clashSelection(c: Clash): { wallIds: string[]; ceilingIds: string[]; extrudedSolidIds: string[]; contextObjectIds: string[] } {
  const sel = { wallIds: [] as string[], ceilingIds: [] as string[], extrudedSolidIds: [] as string[], contextObjectIds: [] as string[] };
  for (const it of [c.a, c.b]) {
    const list = it.kind === "wall" ? sel.wallIds : it.kind === "slab" ? sel.ceilingIds : it.kind === "solid" ? sel.extrudedSolidIds : sel.contextObjectIds;
    if (!list.includes(it.id)) list.push(it.id);
  }
  return sel;
}
