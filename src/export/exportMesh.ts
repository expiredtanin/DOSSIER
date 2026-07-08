// OBJ-/STL-Export des 3D-Gebäudemodells als reines Dreiecks-Mesh. Pures Modul
// (kein Datei-IO, kein WASM) — Architektur wie exportDxf.ts/exportSchedule.ts:
// buildGroups() liest das Projekt und liefert reine Zahlen-Arrays, exportObj()/
// exportStl() serialisieren sie synchron zu Text.
//
// TRIANGEL-QUELLE (bewusste v1-Entscheidung, siehe PENDENZEN):
//   • Wände: pickGeometry() aus toWalls3d.ts liefert dieselben Schicht-Bänder,
//     die auch der 3D-Viewer zeichnet (EIN RWall je Materiallage/Achsen-
//     Teilstück, bereits mit End-Cuts/Gehrungen/Decken-Dominanz aufgelöst).
//     Bänder mit Öffnungs-`holes` werden über den gemeinsamen Loch-Ausschnitt-
//     Generator (`plan/wallMeshCut.ts`, TS-Port von render3ds Gitter-Zerlegung
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
import { wallCutMesh } from "../plan/wallMeshCut";
import { triangulate } from "../plan/glPlan/glPlanCompile";

/**
 * Eine Mesh-Gruppe (ein Bauteil-Vorkommen: Wand/Decke/Extrusion) mit LOKALEN
 * (0-basierten) Vertex-/Dreiecks-Indizes. `exportObj` verschiebt die Indizes
 * beim Serialisieren auf die globale, 1-basierte OBJ-Nummerierung; `exportStl`
 * braucht gar keine Indizes über Gruppen hinweg (STL ist unindiziert).
 */
interface MeshGroup {
  name: string;
  /** Flaches Weltkoordinaten-Array (x,y,z, x,y,z, …), Meter, Y-up. */
  positions: number[];
  /** Dreiecks-Indizes (3 je Dreieck), 0-basiert relativ zu `positions`. */
  indices: number[];
}

function newGroup(name: string): MeshGroup {
  return { name, positions: [], indices: [] };
}

/** OBJ-Gruppennamen dürfen keine Whitespaces/Sonderzeichen enthalten. */
function sanitizeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_") || "x";
}

/**
 * Die 6 Quader-Seiten als Eckpunkt-Quadrupel (Index-Bits: bit0=Achse −/+,
 * bit1=Höhe −/+, bit2=Dicke −/+ — dieselbe Konvention wie `emitOpeningGlass`/
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
 * Mesh (siehe {@link wallCutMesh}) verwendet — die Fenster/Türen sind sichtbar
 * ausgestanzt inkl. Laibungen, exakt wie im 3D-Viewer. Ohne Löcher bleibt es die
 * klassische, geteilte 8-Ecken-Box ({@link pushWallBox}) — bitgleich zum
 * bisherigen Verhalten (Joins/Gehrungen stecken schon in `start`/`end`).
 */
function pushWall(group: MeshGroup, w: RWall): void {
  if (w.holes && w.holes.length > 0) {
    const cut = wallCutMesh(w);
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
function pushWallBox(group: MeshGroup, w: RWall): void {
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
  group: MeshGroup,
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

/** Baut alle Mesh-Gruppen (Wände, Decken, Extrusionen) des Projekts. */
function buildGroups(project: Project): MeshGroup[] {
  const groups: MeshGroup[] = [];
  const { walls, slabs } = pickGeometry(project);

  // Wände: alle Schicht-Bänder DERSELBEN Wand-Id in EINE Gruppe (mehrere
  // Materiallagen ergeben mehrere Boxen im selben Bauteil-Vorkommen).
  const wallGroups = new Map<string, MeshGroup>();
  for (const w of walls) {
    let g = wallGroups.get(w.wallId);
    if (!g) {
      g = newGroup(`Wand_${sanitizeName(w.wallId)}`);
      wallGroups.set(w.wallId, g);
      groups.push(g);
    }
    pushWall(g, w);
  }

  // Decken: ein Prisma je Decke.
  for (const s of slabs) {
    const g = newGroup(`Decke_${sanitizeName(s.ceilingId)}`);
    const outline: Vec2[] = s.outline.map(([x, y]) => ({ x, y }));
    pushPrism(g, outline, s.zBottom, s.zTop);
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
    const g = newGroup(`Extrusion_${sanitizeName(solid.id)}`);
    pushPrism(g, solid.points, baseZ, baseZ + solid.height, solid.taper ?? 0);
    groups.push(g);
  }

  return groups.filter((g) => g.indices.length > 0);
}

/** Kompakte, verlustarme Zahlformatierung (bis 6 Nachkommastellen, ohne Nullen). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0.0";
  const s = v.toFixed(6);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
}

/**
 * Baut einen vollständigen Wavefront-OBJ-String des 3D-Gebäudemodells (Meter,
 * rechtshändig, Y-up — siehe Moduldoc). Ein `o`-Objekt je Bauteil-Vorkommen
 * (Wand/Decke/Extrusion). Leeres Projekt ⇒ gültige Datei nur mit Kopf-
 * Kommentaren, kein `v`/`f` (kein Crash).
 */
export function exportObj(project: Project): string {
  const groups = buildGroups(project);
  const lines: string[] = [
    "# DOSSIER OBJ-Export - Dreiecks-Mesh des 3D-Gebaeudemodells",
    "# Achsen: rechtshaendig, Y-up (Y = Hoehe ueber OKFF), wie der 3D-Viewer.",
    "# Waende: Schicht-Baender mit oeffnungsgenau ausgeschnittenen Loechern (inkl. Laibungen).",
    "# Decken/Extrusionen: Umriss-Prisma (Ear-Clipping-Triangulierung).",
  ];
  let offset = 0;
  for (const g of groups) {
    const vertCount = g.positions.length / 3;
    if (vertCount === 0) continue;
    lines.push(`o ${g.name}`);
    for (let i = 0; i < g.positions.length; i += 3) {
      lines.push(`v ${fmt(g.positions[i])} ${fmt(g.positions[i + 1])} ${fmt(g.positions[i + 2])}`);
    }
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = g.indices[i] + 1 + offset;
      const b = g.indices[i + 1] + 1 + offset;
      const c = g.indices[i + 2] + 1 + offset;
      lines.push(`f ${a} ${b} ${c}`);
    }
    offset += vertCount;
  }
  return lines.join("\n") + "\n";
}

/**
 * Baut einen vollständigen ASCII-STL-String des 3D-Gebäudemodells (Meter,
 * dieselbe Achsen-Konvention wie {@link exportObj}). Jedes Dreieck trägt eine
 * aus dem Kreuzprodukt berechnete Facettennormale (konsistente Winding, siehe
 * `pushWallBox`/`pushPrism`). Leeres Projekt ⇒ gültiges leeres `solid`-Gerüst.
 */
export function exportStl(project: Project): string {
  const groups = buildGroups(project);
  const lines: string[] = ["solid dossier"];
  for (const g of groups) {
    for (let i = 0; i < g.indices.length; i += 3) {
      const ia = g.indices[i] * 3;
      const ib = g.indices[i + 1] * 3;
      const ic = g.indices[i + 2] * 3;
      const ax = g.positions[ia];
      const ay = g.positions[ia + 1];
      const az = g.positions[ia + 2];
      const bx = g.positions[ib];
      const by = g.positions[ib + 1];
      const bz = g.positions[ib + 2];
      const cx = g.positions[ic];
      const cy = g.positions[ic + 1];
      const cz = g.positions[ic + 2];
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0;
        ny = 0;
        nz = 0;
      }
      lines.push(`facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
      lines.push("outer loop");
      lines.push(`vertex ${fmt(ax)} ${fmt(ay)} ${fmt(az)}`);
      lines.push(`vertex ${fmt(bx)} ${fmt(by)} ${fmt(bz)}`);
      lines.push(`vertex ${fmt(cx)} ${fmt(cy)} ${fmt(cz)}`);
      lines.push("endloop");
      lines.push("endfacet");
    }
  }
  lines.push("endsolid dossier");
  return lines.join("\n") + "\n";
}
