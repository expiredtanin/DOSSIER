// OBJ-/STL-/glTF-Export des 3D-Gebäudemodells als Dreiecks-Mesh. Seit [C4] (28.10.) schreibt Rust die
// Datei (`src-tauri/fileio/src/mesh_export.rs`, Format-Modul pkgFileIo, vorher `await loadFileio()`):
// buildScene() liest das Projekt und sammelt Dreiecke, Materialien und Geschosse flach, exportObj()/
// exportStl()/exportGlb()/exportGltf() rufen den Schreiber synchron auf. Kein Datei-IO hier.
//
// TRIANGEL-QUELLE (bewusste v1-Entscheidung, siehe PENDENZEN):
//   • Wände: pickGeometry() aus toWalls3d.ts liefert dieselben Schicht-Bänder,
//     die auch der 3D-Viewer zeichnet (EIN RWall je Materiallage/Achsen-
//     Teilstück, bereits mit End-Cuts/Gehrungen/Decken-Dominanz aufgelöst).
//     Bänder mit Öffnungs-`holes` werden über den gemeinsamen Loch-Ausschnitt-
//     Generator (`plan/wallMeshCut.ts` → Rust-Kern, Gitter-Zerlegung wie render3ds
//     `extrude_layer_segment_with_holes`) ÖFFNUNGSGENAU trianguliert — die
//     Fenster/Türen sind sichtbar ausgestanzt inkl. Laibungsflächen, genau wie
//     im 3D-Viewer. Lochlose Bänder bleiben die klassische geteilte 8-Ecken-Box.
//   • Decken: pickGeometry() liefert den Umriss + zBottom/zTop je Decke;
//     der Umriss wird mit dem vorhandenen Ear-Clipping-Triangulator
//     (`triangulate` aus plan/glPlan/glPlanCompile.ts, bereits getestet und
//     konkav-fähig) zu Boden-/Deckenkappen trianguliert, dazwischen ein
//     Seitenmantel — ein einfaches Umriss-Prisma.
//   • ExtrudedSolids (truck-Profile): `src/engine/truckSolid.ts` liefert zwar
//     "echte" truck-Dreiecke, ABER nur asynchron über WASM
//     (`extrudePolygon`/`extrudeCircle` geben Promises zurück). Das würde die
//     geforderte SYNCHRONE, WASM-freie Signatur `exportObj(project): string`
//     brechen. Deshalb nutzt dieser Export stattdessen DIESELBE Prisma-
//     Triangulierung wie die Decken (Umriss aus `solid.points` — bei
//     Kreisprofilen bereits eine 48-Eck-Tessellierung, siehe
//     `ExtrudedSolid.points`-Doc) inkl. `taper`-Verjüngung (linear zum
//     Schwerpunkt skaliert, wie die truck-Extrusion es tut). Das ist eine
//     bewusste Abweichung vom ursprünglichen Plan ("truckSolid-Dreiecke") zu-
//     gunsten der pure-Modul-Architektur — ehrlich dokumentiert, kein
//     Stillschweigen.
//
// ACHSEN-KONVENTION: identisch zur bestehenden 3D-Pick-/Highlight-Geometrie
// (siehe `selectionHighlightLines` in toWalls3d.ts): Modell (x, y) → Welt
// (x, Höhe, y), Y-UP, rechtshändig. Ein Weltvertex (vx,vy,vz) entspricht also
// (Modell-x, Meter-Höhe, Modell-y) — exakt wie im 3D-Viewer.

import type { Project, Vec2 } from "../model/types";
import { getFloor } from "../model/types";
import { pickGeometry } from "../plan/toWalls3d";
import type { RWall } from "../plan/toWalls3d";
import { wallCutMeshes, type CutMesh } from "../plan/wallMeshCut";
import { triangulate } from "../plan/glPlan/glPlanCompile";
import { emitOpeningMeshes } from "../plan/toWalls3d/openings";
import { fileio } from "../engine/fileioWasm";

/**
 * Ein Teil-Mesh mit EINEM Material und LOKALEN (0-basierten) Vertex-/Dreiecks-Indizes. Der Rust-Schreiber
 * (`mesh_export.rs`) verschiebt die Indizes beim Serialisieren auf die globale OBJ-Nummerierung.
 */
interface MeshPrim {
  /** Index in die Materialtabelle (`SceneBuilder.materials`), −1 = keins. */
  material: number;
  /** Flaches Weltkoordinaten-Array (x,y,z, x,y,z, …), Meter, Y-up. */
  positions: number[];
  /** Dreiecks-Indizes (3 je Dreieck), 0-basiert relativ zu `positions`. */
  indices: number[];
}

/** Eine Mesh-Gruppe = ein Bauteil-Vorkommen (Wand/Decke/Extrusion/Öffnungsteile) mit ≥ 1 Teil-Mesh. */
interface MeshGroup {
  name: string;
  /** Bauteilart für glTF-`extras` ("wall", "slab", "extrusion", "glazing", "frame"). */
  kind: string;
  /** Bauteil-id im Modell ("" bei Sammelgruppen). */
  id: string;
  /** Index in `levels` oder −1. */
  level: number;
  prims: MeshPrim[];
}

function newGroup(name: string, kind: string, id: string, level: number): MeshGroup {
  return { name, kind, id, level, prims: [] };
}

function newPrim(group: MeshGroup, material: number): MeshPrim {
  const prim: MeshPrim = { material, positions: [], indices: [] };
  group.prims.push(prim);
  return prim;
}

/** OBJ-Gruppennamen dürfen keine Whitespaces/Sonderzeichen enthalten. */
function sanitizeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_") || "x";
}

/**
 * Die 6 Quader-Seiten als Eckpunkt-Quadrupel (Index-Bits: bit0=Achse −/+,
 * bit1=Höhe −/+, bit2=Dicke −/+ — dieselbe Konvention wie `emitOpeningMeshes`/
 * `selectionHighlightLines` in toWalls3d.ts), in nach AUSSEN gewundener
 * Reihenfolge (für ein rechtshändiges Dreibein Achse×Höhe=Dicke-Normale, wie
 * es die Wandbox-Konstruktion unten aufspannt). Jedes Quadrupel wird zu 2
 * Dreiecken (0,1,2)+(0,2,3).
 */
const BOX_QUADS: Array<[number, number, number, number]> = [
  [4, 6, 7, 5], // Dicke +
  [1, 3, 2, 0], // Dicke −
  [2, 3, 7, 6], // Höhe + (Wandkopf)
  [4, 5, 1, 0], // Höhe − (Wand-UK)
  [1, 5, 7, 3], // Achse + (Wandende)
  [2, 6, 4, 0], // Achse − (Wandanfang)
];

/**
 * Hängt EIN Wand-Schicht-Band (`RWall`, siehe toWalls3d.ts) an eine Mesh-Gruppe
 * an: hat das Band echte Öffnungs-`holes`, wird das öffnungsgenaue Loch-Ausschnitt-
 * Mesh `cut` (vorab für alle Bänder über {@link wallCutMeshes}) verwendet — die
 * Fenster/Türen sind sichtbar ausgestanzt inkl. Laibungen, exakt wie im 3D-Viewer.
 * Ohne Löcher bleibt es die klassische, geteilte 8-Ecken-Box ({@link pushWallBox})
 * (Joins/Gehrungen stecken schon in `start`/`end`).
 */
function pushWall(group: MeshPrim, w: RWall, cut: CutMesh | undefined): void {
  if (cut) {
    const base = group.positions.length / 3;
    for (const p of cut.positions) group.positions.push(p);
    for (const idx of cut.indices) group.indices.push(base + idx);
    return;
  }
  pushWallBox(group, w);
}

/**
 * Hängt EINEN vollen Wand-Schicht-Quader (`RWall`) an eine Mesh-Gruppe an — Box
 * über Achse×Höhe×Dicke, OHNE Öffnungs-Ausschnitt (nur für lochlose Bänder, siehe
 * {@link pushWall}). Degenerierte Bänder (Länge/Höhe/Dicke ≤ 0) werden übersprungen.
 */
function pushWallBox(group: MeshPrim, w: RWall): void {
  const [sx, sy] = w.start;
  const [ex, ey] = w.end;
  const dx = ex - sx;
  const dz = ey - sy;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9 || w.height <= 1e-9 || w.thickness <= 1e-9) return;
  const ax = dx / len;
  const az = dz / len;
  // Normale = Welt-Hoch × Achse (rechtshändig), dieselbe Konvention wie
  // `selectionHighlightLines`: normal = (az, 0, −ax).
  const nx = az;
  const nz = -ax;
  const halfLen = len / 2;
  const halfHeight = w.height / 2;
  const halfThick = w.thickness / 2;
  const cx = (sx + ex) / 2;
  const cz = (sy + ey) / 2;
  const cy = w.baseElevation + w.height / 2;
  const base = group.positions.length / 3;
  for (let i = 0; i < 8; i++) {
    const sL = i & 1 ? 1 : -1;
    const sH = i & 2 ? 1 : -1;
    const sT = i & 4 ? 1 : -1;
    group.positions.push(
      cx + sL * halfLen * ax + sT * halfThick * nx,
      cy + sH * halfHeight,
      cz + sL * halfLen * az + sT * halfThick * nz,
    );
  }
  for (const [a, b, c, d] of BOX_QUADS) {
    group.indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
}

/** Signierte Fläche eines Modell-XY-Umrisses (Shoelace); ≥0 = CCW. */
function signedAreaXY(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return a / 2;
}

/**
 * Hängt ein extrudiertes Umriss-Prisma (Decke ODER truck-Profil-Extrusion,
 * siehe Moduldoc) an eine Mesh-Gruppe an: Boden-/Deckkappe (Ear-Clipping-
 * Triangulierung via `triangulate`) + Seitenmantel. `taper` (0..1) verjüngt
 * den OBEREN Ring linear zum Flächenschwerpunkt — dieselbe Semantik wie
 * `ExtrudedSolid.taper`/die truck-Extrusion (0 = Prisma, 1 = Spitze/Pyramide).
 * Der Umriss wird intern auf CCW (Modell-XY) normalisiert, damit die
 * Seitenmantel-Normalen unabhängig von der Eingabe-Wicklung nach außen zeigen.
 */
function pushPrism(
  group: MeshPrim,
  outline: Vec2[],
  zBottom: number,
  zTop: number,
  taper = 0,
): void {
  if (outline.length < 3 || zTop - zBottom <= 1e-9) return;
  const ccw = signedAreaXY(outline) >= 0 ? outline : [...outline].reverse();
  const n = ccw.length;
  let cx = 0;
  let cyModel = 0;
  for (const p of ccw) {
    cx += p.x;
    cyModel += p.y;
  }
  cx /= n;
  cyModel /= n;
  const t = Math.min(1, Math.max(0, taper));
  const base = group.positions.length / 3;
  // Unterer Ring (base + 0..n-1), oberer Ring (base + n..2n-1).
  for (const p of ccw) group.positions.push(p.x, zBottom, p.y);
  for (const p of ccw) {
    const tx = cx + (p.x - cx) * (1 - t);
    const ty = cyModel + (p.y - cyModel) * (1 - t);
    group.positions.push(tx, zTop, ty);
  }
  // Kappen: `triangulate` liefert bei CCW-Eingabe stets CCW-in-Modell-XY-
  // Dreiecke — eingebettet in die Weltebene (x, const, y) entspricht das einer
  // nach UNTEN (−Y) zeigenden Flächennormale (Kreuzprodukt-Herleitung siehe
  // Moduldoc-Kommentar oben). Die Bodenkappe nutzt diese Wicklung direkt
  // (Normale zeigt nach unten = nach außen), die Deckkappe braucht die
  // umgekehrte Wicklung (Normale nach oben).
  const capTris = triangulate(ccw);
  for (let i = 0; i < capTris.length; i += 3) {
    const a = capTris[i];
    const b = capTris[i + 1];
    const c = capTris[i + 2];
    group.indices.push(base + a, base + b, base + c);
    group.indices.push(base + n + a, base + n + c, base + n + b);
  }
  // Seitenmantel: je Umrisskante ein Quad (2 Dreiecke), Wicklung so, dass die
  // Normale nach außen zeigt (siehe Moduldoc-Herleitung).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const bi = base + i;
    const bj = base + j;
    const ti = base + n + i;
    const tj = base + n + j;
    group.indices.push(bi, ti, tj);
    group.indices.push(bi, tj, bj);
  }
}

type Rgb = [number, number, number];

/** Material der Szene: Farbe sRGB 0..1, `rgba[3]` < 1 = transparent (Glas). */
interface SceneMaterial {
  name: string;
  rgba: [number, number, number, number];
  metallic: number;
  roughness: number;
}

/** Materialtabelle: gleiche Farbe + Name = ein Material. */
class Materials {
  readonly list: SceneMaterial[] = [];
  private readonly byKey = new Map<string, number>();

  get(name: string, rgb: Rgb, alpha = 1, metallic = 0, roughness = 0.9): number {
    const key = `${name}|${rgb.join(",")}|${alpha}|${metallic}|${roughness}`;
    let i = this.byKey.get(key);
    if (i === undefined) {
      i = this.list.length;
      this.list.push({ name, rgba: [rgb[0], rgb[1], rgb[2], alpha], metallic, roughness });
      this.byKey.set(key, i);
    }
    return i;
  }
}

/** Die für den Rust-Schreiber gesammelte Szene. */
interface MeshScene {
  groups: MeshGroup[];
  materials: SceneMaterial[];
  levels: { id: string; name: string }[];
}

/** Standardfarbe der Extrusionen/Decken (wie `SLAB_RGB` in toWalls3d/shared.ts). */
const SLAB_COLOR: Rgb = [0.86, 0.86, 0.88];
/** Verglasung und Rahmenteile aus `emitOpeningMeshes` (Farben `PART_RGB` in toWalls3d/openings.ts). */
const GLASS_COLOR: Rgb = [0.62, 0.76, 0.85];
const OPENING_PART_NAMES: Array<[Rgb, string]> = [
  [[0.85, 0.85, 0.83], "Blendrahmen"],
  [[0.88, 0.88, 0.9], "Fluegelrahmen"],
  [[0.8, 0.8, 0.78], "Fensterbank/Zarge"],
  [[0.25, 0.27, 0.3], "Schwelle"],
  [[0.93, 0.9, 0.85], "Tuerblatt"],
];
const sameRgb = (a: readonly number[], b: readonly number[]) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/** Vorzeichen des Volumens eines Dreiecks-Meshes (Weltkoordinaten): < 0 = Wicklung zeigt nach innen. */
function signedVolume(pos: readonly number[], idx: readonly number[]): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v;
}

/**
 * Baut alle Mesh-Gruppen (Wände, Decken, Extrusionen; mit `parts` zusätzlich Verglasung und
 * Rahmenteile der Öffnungen) und die Materialtabelle. OBJ/STL bleiben beim Bestand (`parts` aus, nur
 * Dreiecke, Materialien ungenutzt); glTF nimmt die Öffnungsteile mit, damit Fenster Glas haben.
 */
function buildScene(project: Project, parts: boolean): MeshScene {
  const groups: MeshGroup[] = [];
  const mats = new Materials();
  const { walls, slabs } = pickGeometry(project);
  const levels = project.drawingLevels.filter((l) => l.kind === "floor").map((l) => ({ id: l.id, name: l.name }));
  const levelOf = (floorId: string | undefined): number => levels.findIndex((l) => l.id === floorId);
  const componentName = (id: string | undefined, fallback: string): string =>
    (id !== undefined && project.components.find((c) => c.id === id)?.name) || fallback;

  // Wände: alle Schicht-Bänder DERSELBEN Wand-Id in EINE Gruppe (mehrere
  // Materiallagen ergeben mehrere Boxen im selben Bauteil-Vorkommen).
  const wallGroups = new Map<string, MeshGroup>();
  const wallFloor = new Map(project.walls.map((w) => [w.id, w.floorId]));
  // Loch-Ausschnitte aller gelochten Bänder in EINEM Kern-Aufruf.
  const holed = walls.filter((w) => w.holes && w.holes.length > 0);
  const cuts = new Map<RWall, CutMesh>();
  wallCutMeshes(holed).forEach((m, i) => cuts.set(holed[i], m));
  for (const w of walls) {
    let g = wallGroups.get(w.wallId);
    if (!g) {
      g = newGroup(`Wand_${sanitizeName(w.wallId)}`, "wall", w.wallId, levelOf(wallFloor.get(w.wallId)));
      wallGroups.set(w.wallId, g);
      groups.push(g);
    }
    const mat = mats.get(componentName(w.cut?.componentId, "Wand"), w.color);
    pushWall(newPrim(g, mat), w, cuts.get(w));
  }

  // Decken: ein Prisma je Decke.
  const ceilingFloor = new Map((project.ceilings ?? []).map((c) => [c.id, c.floorId]));
  for (const s of slabs) {
    const g = newGroup(`Decke_${sanitizeName(s.ceilingId)}`, "slab", s.ceilingId, levelOf(ceilingFloor.get(s.ceilingId)));
    const outline: Vec2[] = s.outline.map(([x, y]) => ({ x, y }));
    pushPrism(newPrim(g, mats.get(componentName(s.cut?.componentId, "Decke"), s.color)), outline, s.zBottom, s.zTop);
    groups.push(g);
  }

  // Extrudierte Profile (truck-Integration): eigenes Prisma je Körper (siehe
  // Moduldoc — bewusst NICHT die truck-WASM-Dreiecke, aus Sync-/Pure-Gründen).
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.points.length < 3 || solid.height <= 0) continue;
    let baseZ = 0;
    try {
      baseZ = getFloor(project, solid.levelId).baseElevation ?? 0;
    } catch {
      // Geschoss nicht (mehr) auflösbar: bei UK 0 extrudieren (Fallback, wie toWalls3d).
    }
    const g = newGroup(`Extrusion_${sanitizeName(solid.id)}`, "extrusion", solid.id, levelOf(solid.levelId));
    pushPrism(newPrim(g, mats.get("Extrusion", SLAB_COLOR)), solid.points, baseZ, baseZ + solid.height, solid.taper ?? 0);
    groups.push(g);
  }

  if (parts) {
    // Öffnungsteile haben keine Bauteil-id (emitOpeningMeshes liefert nur Quader mit Farbe): Glas und
    // Rahmenteile je EIN Sammelknoten, die Quader je Material zu einem Teil-Mesh zusammengefasst.
    const glazing = newGroup("Verglasung", "glazing", "", -1);
    const frames = newGroup("Oeffnungsteile", "frame", "", -1);
    const prims = new Map<string, MeshPrim>();
    for (const m of emitOpeningMeshes(project, "mittel")) {
      const glass = sameRgb(m.color, GLASS_COLOR);
      const name = glass ? "Glas" : (OPENING_PART_NAMES.find(([c]) => sameRgb(c, m.color))?.[1] ?? "Oeffnungsteil");
      const group = glass ? glazing : frames;
      const key = `${glass}|${name}`;
      let prim = prims.get(key);
      if (!prim) {
        // Glas transparent und glatt (BLEND), Rahmen matt.
        const mat = glass ? mats.get(name, m.color, 0.35, 0, 0.05) : mats.get(name, m.color, 1, 0, 0.6);
        prim = newPrim(group, mat);
        prims.set(key, prim);
      }
      // Modell (x, y, z-hoch) → Welt (x, z, y); danach Wicklung so, dass das Volumen positiv ist.
      const pos: number[] = [];
      for (let i = 0; i + 2 < m.positions.length; i += 3) pos.push(m.positions[i], m.positions[i + 2], m.positions[i + 1]);
      let idx = m.indices;
      if (signedVolume(pos, idx) < 0) {
        idx = [];
        for (let i = 0; i + 2 < m.indices.length; i += 3) idx.push(m.indices[i], m.indices[i + 2], m.indices[i + 1]);
      }
      const base = prim.positions.length / 3;
      for (const p of pos) prim.positions.push(p);
      for (const i of idx) prim.indices.push(base + i);
    }
    for (const g of [glazing, frames]) if (g.prims.length > 0) groups.push(g);
  }

  return {
    groups: groups.filter((g) => g.prims.some((p) => p.indices.length > 0)),
    materials: mats.list,
    levels,
  };
}

// ── Flacher Puffer (Gegenstück zu src-tauri/fileio/src/mesh_export.rs, dort die Kodierung) ─────

const FLAT_VERSION = 1;

/** Kodiert die Szene als `[Zahlenpuffer, Zeichenketten durch \0 getrennt]`. */
function encodeScene(scene: MeshScene, byLevel: boolean): [Float64Array, string] {
  const nums: number[] = [FLAT_VERSION, byLevel ? 1 : 0];
  const strings: string[] = [];
  const str = (s: string): number => {
    strings.push(s.replace(/\0/g, ""));
    return strings.length - 1;
  };
  nums.push(scene.materials.length);
  for (const m of scene.materials) nums.push(str(m.name), m.rgba[0], m.rgba[1], m.rgba[2], m.rgba[3], m.metallic, m.roughness);
  nums.push(scene.levels.length);
  for (const l of scene.levels) nums.push(str(l.id), str(l.name));
  nums.push(scene.groups.length);
  for (const g of scene.groups) {
    nums.push(str(g.name), str(g.kind), str(g.id), g.level, g.prims.length);
    for (const p of g.prims) {
      nums.push(p.material, p.positions.length / 3);
      for (let i = 0; i < p.positions.length; i++) nums.push(p.positions[i]);
      nums.push(p.indices.length / 3);
      for (let i = 0; i < p.indices.length; i++) nums.push(p.indices[i]);
    }
  }
  return [new Float64Array(nums), strings.join("\0")];
}

/** Ruft eine Rust-Bindung; leeres Ergebnis (kaputter Puffer) wird zum Fehler mit dem Grund. */
function write<T extends string | Uint8Array>(project: Project, parts: boolean, byLevel: boolean, run: (m: ReturnType<typeof fileio>, buf: Float64Array, strings: string) => T): T {
  const m = fileio();
  const [buf, strings] = encodeScene(buildScene(project, parts), byLevel);
  const out = run(m, buf, strings);
  if (out.length === 0) {
    const why = m.export_mesh_check_flat(buf, strings);
    throw new Error(`Mesh-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
  }
  return out;
}

/**
 * Baut einen vollständigen Wavefront-OBJ-String des 3D-Gebäudemodells (Meter, Y-up — siehe Moduldoc).
 * Ein `o`-Objekt je Bauteil-Vorkommen (Wand/Decke/Extrusion). Leeres Projekt ⇒ gültige Datei nur mit
 * Kopf-Kommentaren. Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function exportObj(project: Project): string {
  return write(project, false, false, (m, b, s) => m.export_mesh_obj_flat(b, s));
}

/**
 * Baut einen vollständigen ASCII-STL-String (Meter, dieselbe Achsen-Konvention wie {@link exportObj});
 * je Dreieck eine Facettennormale. Leeres Projekt ⇒ gültiges leeres `solid`-Gerüst. Verlangt das
 * geladene Format-Modul (`await loadFileio()`).
 */
export function exportStl(project: Project): string {
  return write(project, false, false, (m, b, s) => m.export_mesh_stl_flat(b, s));
}

/** Optionen des glTF-Exports. */
export interface GltfOptions {
  /** Geschoss als Eltern-Knoten der Bauteile (Standard: ja). */
  byLevel?: boolean;
}

/**
 * glTF 2.0 binär (GLB) für Blender, Twinmotion, Enscape, Web-Viewer. Ein Knoten je Bauteil (Name
 * `Wand_<id>`/`Decke_<id>`/`Extrusion_<id>`, `extras` = Typ + id), PBR-Materialien mit der Farbe der
 * Bauteilschicht, Verglasung transparent (`BLEND`), Geschosse als Eltern-Knoten. Meter; die Achsen
 * folgen der glTF-Konvention (rechtshändig, Y-up): Modell (x, y, z-hoch) → (x, z, −y), Norden = −Z.
 * Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function exportGlb(project: Project, opts: GltfOptions = {}): Uint8Array {
  return write(project, true, opts.byLevel ?? true, (m, b, s) => m.export_mesh_glb_flat(b, s));
}

/** Wie {@link exportGlb}, aber als `.gltf` (JSON, Puffer als Base64-Data-URI eingebettet). */
export function exportGltf(project: Project, opts: GltfOptions = {}): string {
  return write(project, true, opts.byLevel ?? true, (m, b, s) => m.export_mesh_gltf_flat(b, s));
}
