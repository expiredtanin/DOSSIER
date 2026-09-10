// Baut die three.js-Szene aus dem semantischen Modell: Kontext (Terrain/Import/
// Konturen), Gebäude (Wände inkl. Öffnungen, Decken, Treppen, freie 2D-Linien).
// Reine THREE.js-Erzeugung — kein Komponenten-/Interaktions-Zugriff; bekommt
// Materialcaches + Render-Modus über `BuildOpts` gereicht.

import * as THREE from "three";
import {
  flattenCategories,
  getCeilingType,
  getComponent,
  getStairType,
  getWallType,
  stairsOfFloor,
  wallTypeThickness,
  type Ceiling,
  type Column,
  type Contour,
  type ContextObject,
  type Drawing2D,
  type DrawingLevel,
  type Opening,
  type Project,
  type Stair,
  type Vec2,
  type Wall,
} from "../../model/types";
import { along, clippedBand } from "../../model/geometry";
import { stairGeometry } from "../../geometry/stair";
import { columnFootprint } from "../../geometry/column";
import {
  doorSymbol,
  openingInterval,
  openingVerticalExtent,
  wallAxisFrame,
} from "../../geometry/opening";
import { computeJoins, type WallCuts } from "../../model/joins";
import {
  ceilingVerticalExtent,
  columnVerticalExtent,
  stairVerticalExtent,
  wallReferenceOffset,
  wallVerticalExtent,
} from "../../model/wall";
import { emitExtrudedSolids } from "../../plan/toWalls3d/extrusions";
import { MaterialRuntime } from "../../materials/runtime";
import type { RenderMode } from "../../ui/TopBar";
import type { DisplayResolver } from "../Viewport3D";

/** Getrennte Material-Caches: normal und gedimmt (je Component-ID). */
export interface MatCaches {
  normal: Map<string, THREE.MeshStandardMaterial>;
  greyed: Map<string, THREE.MeshStandardMaterial>;
  /** Linien-Materialien der 2D-Zeichengeometrie (Schlüssel: `farbe|greyed`). */
  lines: Map<string, THREE.LineBasicMaterial>;
}

/** Bündel der Bau-Optionen, das durch die Bau-Helfer gereicht wird. */
export interface BuildOpts {
  mats: MatCaches;
  renderMode: RenderMode;
  /** Geteiltes flaches Face-Material für den Hidden-Line-Modus. */
  hiddenFace: THREE.MeshBasicMaterial;
  /** Geteiltes Kanten-Material für den Hidden-Line-Modus. */
  edgeMat: THREE.LineBasicMaterial;
  /** Geteiltes mattes helles Material für den „Weiss"-Modus (Clay-Look). */
  whiteFace: THREE.MeshStandardMaterial;
  /** Laufzeit für PBR-Texturen (Render-Modus „textured"); sonst ungenutzt. */
  matRuntime: MaterialRuntime;
}

/** Geteilte Materialien der Kontext-Schicht (Gelände/Mesh/Kontur). */
export interface ContextMats {
  terrain: THREE.MeshStandardMaterial;
  mesh: THREE.MeshStandardMaterial;
  contour: THREE.LineBasicMaterial;
}

/**
 * Baut die Kontext-Gruppe aus `Project.context`:
 *   • TerrainMesh / ImportedMesh → BufferGeometry aus positions/indices.
 *   • ContourSet               → LineSegments je Kontur auf ihrer Z-Höhe.
 *
 * Achs-Konvention: das Modell speichert (x, y, z) mit z = Höhe; Three nutzt y als
 * Höhe. Wir bilden Modell (x,y,z) → Three (x, z, y) ab (wie die übrige Szene, in
 * der Plan-Y auf die Three-Z-Achse fällt und die Höhe auf Three-Y).
 */
export function buildContext(
  context: ContextObject[],
  mats: ContextMats,
): THREE.Group {
  const group = new THREE.Group();
  for (const obj of context) {
    if (obj.type === "terrainMesh" || obj.type === "importedMesh") {
      const mesh = buildContextMesh(
        obj.positions,
        obj.indices,
        obj.type === "terrainMesh" ? mats.terrain : mats.mesh,
      );
      if (mesh) group.add(mesh);
    } else if (obj.type === "contourSet") {
      const lines = buildContourLines(obj.contours, mats.contour);
      if (lines) group.add(lines);
    }
  }
  return group;
}

/** BufferGeometry-Mesh aus rohen (x,y,z)-positions/indices; Modell→Three-Achsen. */
function buildContextMesh(
  positions: number[],
  indices: number[],
  mat: THREE.Material,
): THREE.Mesh | null {
  if (positions.length < 9 || indices.length < 3) return null;
  // Modell (x,y,z) → Three (x, z, y).
  const verts = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    verts[i] = positions[i]; // x
    verts[i + 1] = positions[i + 2]; // y(Three) = z(Modell) = Höhe
    verts[i + 2] = positions[i + 1]; // z(Three) = y(Modell)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, mat);
}

/** LineSegments aller Konturen (jede Kontur als zusammenhängender Linienzug). */
function buildContourLines(
  contours: Contour[],
  mat: THREE.LineBasicMaterial,
): THREE.LineSegments | null {
  const pos: number[] = [];
  for (const c of contours) {
    const n = c.pts.length;
    if (n < 2) continue;
    const segCount = c.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const a = c.pts[i];
      const b = c.pts[(i + 1) % n];
      // Modell (x,y,z=c.z) → Three (x, z, y).
      pos.push(a.x, c.z, a.y, b.x, c.z, b.y);
    }
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeBoundingSphere();
  const seg = new THREE.LineSegments(geo, mat);
  seg.frustumCulled = false;
  return seg;
}

export function buildBuilding(
  project: Project,
  visibleCodes: Set<string>,
  floorDisplay: DisplayResolver,
  categoryDisplay: DisplayResolver,
  opts: BuildOpts,
): THREE.Group {
  const group = new THREE.Group();
  // Geschosse gemäß Darstellungsmodus auswählen; jedes vertikal um seine
  // baseElevation versetzt stapeln. Ein gedimmtes Geschoss färbt all seine
  // Wände gedämpft ein.
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  for (const floor of floors) {
    const d = floorDisplay(floor.id);
    if (!d.render) continue;
    buildFloor(group, project, floor, visibleCodes, categoryDisplay, d.greyed, opts);
  }
  // Stützen (Column) + truck-Profil-Extrusionen (ExtrudedSolid): PARITÄT zum
  // WASM-Default-3D-Pfad (`toWalls3d.ts::emitMeshes`), der beide ebenfalls
  // projektweit UNGEFILTERT emittiert (kein Geschoss-/Kategorie-Gating) —
  // dieselbe Nicht-Filterung hier, statt eine im Primärrenderer gar nicht
  // existierende Filterlogik zu erfinden. Vorher fehlten beide Bauteilarten
  // im Three.js-Fallback komplett (s. PENDENZEN „3D-Elemente-Parität-Audit").
  for (const column of project.columns ?? []) {
    addColumnMeshes(group, project, column, opts);
  }
  addExtrudedSolidMeshes(group, project, opts);
  return group;
}

/**
 * Baut ein einzelnes Geschoss in die Gruppe. Es werden nur die Wände dieses
 * Geschosses mit sichtbarer Kategorie verwendet; die Gehrung wird auf genau
 * dieser Wandmenge berechnet. Jede vertikale Koordinate wird um die
 * baseElevation des Geschosses verschoben, sodass die Geschosse stapeln.
 */
function buildFloor(
  group: THREE.Group,
  project: Project,
  floor: DrawingLevel,
  visibleCodes: Set<string>,
  categoryDisplay: DisplayResolver,
  floorGreyed: boolean,
  opts: BuildOpts,
): void {
  const baseElevation = floor.baseElevation ?? 0;
  // Sichtbarkeit wie bisher; der Kategorie-Darstellungsmodus verfeinert sie.
  const walls = project.walls.filter(
    (w) =>
      w.floorId === floor.id &&
      visibleCodes.has(w.categoryCode) &&
      categoryDisplay(w.categoryCode).render,
  );
  // Gehrungs-Schnittlinien auf der gefilterten Wandmenge berechnen, damit 3D
  // mit dem gehrten Grundriss übereinstimmt.
  const joins = computeJoins(project, walls);
  for (const wall of walls) {
    // Gedimmt, wenn das Geschoss ODER die Kategorie der Wand gedimmt ist.
    const greyed = floorGreyed || categoryDisplay(wall.categoryCode).greyed;
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const wallOpenings = (project.openings ?? []).filter(
      (o) => o.hostWallId === wall.id,
    );
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    addWallMeshes(group, project, wall, doors, wallOpenings, cuts, baseElevation, greyed, opts);
    // Rahmen/Glas/Blatt der Öffnungen NUR, wenn die Öffnungs-Kategorie sichtbar ist.
    for (const o of wallOpenings) {
      const oGreyed = floorGreyed || categoryDisplay(o.categoryCode).greyed;
      if (visibleCodes.has(o.categoryCode) && categoryDisplay(o.categoryCode).render) {
        addOpeningMeshes(group, project, wall, o, oGreyed, opts);
      }
    }
  }

  // Decken dieses Geschosses als extrudierte Slabs (Umriss × Dicke) an der
  // korrekten Z-Lage (OK = Geschoss-Oberkante, wächst nach unten).
  const ceilings = (project.ceilings ?? []).filter(
    (c) =>
      c.floorId === floor.id &&
      visibleCodes.has(c.categoryCode) &&
      categoryDisplay(c.categoryCode).render,
  );
  for (const ceiling of ceilings) {
    const greyed = floorGreyed || categoryDisplay(ceiling.categoryCode).greyed;
    addCeilingMesh(group, project, ceiling, greyed, opts);
  }

  // Treppen dieses Geschosses als gestufte Boxen (Tritte + Setzstufen), von der
  // Geschoss-UK bis zur nächsten Geschoss-OK aufsteigend.
  const stairs = stairsOfFloor(project, floor.id).filter(
    (s) =>
      visibleCodes.has(s.categoryCode) && categoryDisplay(s.categoryCode).render,
  );
  for (const stair of stairs) {
    const greyed = floorGreyed || categoryDisplay(stair.categoryCode).greyed;
    addStairMeshes(group, project, stair, greyed, opts);
  }

  // Freie 2D-Zeichengeometrie dieses Geschosses flach auf der Geschossebene
  // (Z = baseElevation) — z. B. ein Linien-Raster liegt auf dem Boden des Geschosses.
  const drawings = project.drawings2d.filter(
    (d) =>
      d.levelId === floor.id &&
      visibleCodes.has(d.categoryCode) &&
      categoryDisplay(d.categoryCode).render,
  );
  for (const d of drawings) {
    const greyed = floorGreyed || categoryDisplay(d.categoryCode).greyed;
    addDrawing2DLines(group, project, d, baseElevation, greyed, opts);
  }
}

/** Modellfarbe eines 2D-Zeichenelements (color → LineStyle → Kategorie). */
function drawing2DColor(project: Project, d: Drawing2D): string {
  if (d.color) return d.color;
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  if (ls?.color) return ls.color;
  const cat = flattenCategories(project.layers).find((c) => c.code === d.categoryCode);
  return cat?.color ?? "#888888";
}

/** Strecken eines 2D-Zeichenelements (line/polyline/rect); andere → leer. */
function drawing2DSegments(d: Drawing2D): [Vec2, Vec2][] {
  const g = d.geom;
  const out: [Vec2, Vec2][] = [];
  if (g.shape === "line") out.push([g.a, g.b]);
  else if (g.shape === "polyline") {
    for (let i = 0; i < g.pts.length - 1; i++) out.push([g.pts[i], g.pts[i + 1]]);
    if (g.closed && g.pts.length > 2) out.push([g.pts[g.pts.length - 1], g.pts[0]]);
  } else if (g.shape === "rect") {
    const c1 = g.min, c3 = g.max;
    const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
    out.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
  }
  return out;
}

/**
 * Zeichnet ein 2D-Element als flache Linien auf der Geschossebene. Plan (x,y) →
 * Three (x, baseElevation, y); ein winziger Höhen-Offset verhindert Z-Fighting mit
 * dem Boden/Raster. Material je Farbe (+ gedimmt) gecached.
 */
function addDrawing2DLines(
  group: THREE.Group,
  project: Project,
  d: Drawing2D,
  baseElevation: number,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const segs = drawing2DSegments(d);
  if (segs.length === 0) return;
  const color = drawing2DColor(project, d);
  const key = `${color}|${greyed}`;
  let mat = opts.mats.lines.get(key);
  if (!mat) {
    mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      transparent: greyed,
      opacity: greyed ? 0.35 : 1,
    });
    opts.mats.lines.set(key, mat);
  }
  const y = baseElevation + 0.01; // knapp über der Geschossebene (kein Z-Fighting)
  const positions = new Float32Array(segs.length * 6);
  segs.forEach(([a, b], i) => {
    positions.set([a.x, y, a.y, b.x, y, b.y], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  const seg = new THREE.LineSegments(geo, mat);
  // Dünne Liniengeometrie nicht vorzeitig wegcullen; Tiefentest bleibt aktiv,
  // damit Wände die bodennahen Linien korrekt verdecken (natürliche Verdeckung).
  seg.frustumCulled = false;
  group.add(seg);
}

/**
 * Wand als extrudierte Schicht-Bänder — pro Schicht ein eigenes Prisma, um
 * Türen ausgespart, mit Sturz darüber. Es wird DASSELBE gehrte Band-Polygon
 * wie im Grundriss extrudiert, sodass Ecken auch in 3D sauber stoßen.
 * `baseElevation` hebt das gesamte Geschoss vertikal an.
 */
function addWallMeshes(
  group: THREE.Group,
  project: Project,
  wall: Wall,
  doors: Project["doors"],
  wallOpenings: Opening[],
  cuts: WallCuts,
  // baseElevation wird jetzt über wallVerticalExtent (UK/OK-Auflösung) bezogen;
  // der Parameter bleibt für die Aufrufstelle erhalten, wird hier aber nicht
  // mehr direkt genutzt.
  _baseElevation: number,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const wt = getWallType(project, wall);
  const total = wallTypeThickness(wt);
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

  // Vertikale Ausdehnung (absolute Z): UK/OK aus den Wand-Attributen, sonst
  // baseElevation des Geschosses … +height (= heutiges Verhalten). Wir geben
  // die absoluten Z-Werte direkt an addLayerPrism (baseElevation dort = 0).
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  // Tür-/Sturzhöhen sind relativ zur Wand-UK definiert (Türen sitzen am Boden).
  const wallTopRel = zTop - zBottom;

  // Öffnungen (Legacy-Türen + neue Öffnungen) mit sill/head RELATIV zur Wand-UK:
  //   • Tür    — sillRel 0 … headRel = height (Segment darunter entfällt).
  //   • Fenster— sillRel = Brüstung … headRel = sillRel + height (Brüstungsmauer
  //     UNTER dem Fenster bleibt stehen, Sturz DARÜBER ebenfalls).
  const openings = [
    ...doors.map((d) => ({
      from: d.position,
      to: d.position + d.width,
      sillRel: 0,
      headRel: Math.min(d.height, wallTopRel),
    })),
    ...wallOpenings
      .map((o) => {
        const iv = openingInterval(wall, o);
        if (!iv) return null;
        const sillRel = Math.max(0, Math.min(o.sillHeight, wallTopRel));
        const headRel = Math.min(sillRel + o.height, wallTopRel);
        return { from: iv.from, to: iv.to, sillRel, headRel };
      })
      .filter((x): x is { from: number; to: number; sillRel: number; headRel: number } => x != null),
  ].sort((a, b) => a.from - b.from);

  // Referenzlinien-Versatz über die Dicke (center=0 → unverändert).
  const refOff = wallReferenceOffset(wall, total);

  // Schichten von außen (-T/2) nach innen (+T/2) stapeln, um den Referenzversatz
  // verschoben (damit die Achse bei „außen"/„innen" auf der Wandfläche liegt).
  let off = refOff - total / 2;
  for (const layer of wt.layers) {
    // Material je Modus: Hidden-Line nutzt die geteilten flachen weißen Faces,
    // „Weiss" das geteilte matte Clay-Material, „Texturiert" ein PBR-Material je
    // Fläche (s. u., daher hier null), shaded/wireframe das (ggf. gedimmte)
    // Component-Material.
    const textured = opts.renderMode === "textured";
    // Im Texturiert-Modus das (gecachte) PBR-Material des Bauteils (oder null →
    // matte Default-Farbe). Da die Seitenwand-UVs in Welt-Metern liegen und das
    // Material `repeat = 1/sizeM` trägt, gilt EIN Material für alle Flächen.
    const textureMat = textured
      ? opts.matRuntime.get(getComponent(project, layer.componentId).material)
      : null;
    // Material je Modus: Hidden-Line die geteilten flachen weißen Faces, „Weiss"
    // das matte Clay-Material, „Texturiert" das PBR-Material (sonst Fallback auf
    // das matte Component-Material — Wände ohne Textur bleiben sichtbar),
    // shaded/wireframe das (ggf. gedimmte) Component-Material.
    const mat =
      opts.renderMode === "hidden"
        ? opts.hiddenFace
        : opts.renderMode === "white"
          ? opts.whiteFace
          : textured && textureMat
            ? textureMat
            : layerMaterial(project, layer.componentId, greyed, opts);
    const offA = off;
    const offB = off + layer.thickness;

    // Vollhohe Segmente zwischen den Öffnungen. Z-Werte sind ABSOLUT (zBottom…
    // zTop); baseElevation wurde bereits in die Extent-Auflösung eingerechnet,
    // daher hier 0. Tür-/Sturzhöhen sind relativ zur Wand-UK → zBottom + rel.
    let cursor = 0;
    for (const op of openings) {
      if (op.from > cursor)
        addLayerPrism(group, wall, cursor, op.from, zBottom, zTop, offA, offB, cuts, 0, mat, opts);
      // Brüstungsmauer UNTER der Öffnung (Fenster: sillRel > 0; Tür: sillRel 0 → nichts).
      if (op.sillRel > 1e-4)
        addLayerPrism(group, wall, op.from, op.to, zBottom, zBottom + op.sillRel, offA, offB, cuts, 0, mat, opts);
      // Sturz ÜBER der Öffnung (türnahe Enden bleiben rechtwinklig).
      if (op.headRel < wallTopRel)
        addLayerPrism(group, wall, op.from, op.to, zBottom + op.headRel, zTop, offA, offB, cuts, 0, mat, opts);
      cursor = Math.max(cursor, op.to);
    }
    if (cursor < length)
      addLayerPrism(group, wall, cursor, length, zBottom, zTop, offA, offB, cuts, 0, mat, opts);

    off += layer.thickness;
  }
}

/**
 * 3D-Geometrie einer Öffnung: Rahmen (dünne Box um die lichte Öffnung) + Glas
 * (Fenster, halbtransparente Scheibe) bzw. Türblatt (Fenster: entfällt; Tür:
 * flaches Panel in geöffneter Stellung, Winkel aus swingAngle). Alle Meshes
 * tragen `userData.openingId` für die Raycast-Auswahl. Plan (x,y) → Three (x,z=y),
 * Höhe entlang Three-Y. Materialien werden je Aufruf erzeugt (leichtgewichtig).
 */
function addOpeningMeshes(
  group: THREE.Group,
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const iv = openingInterval(wall, o);
  if (!iv) return;
  const { u, n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const { zBottom, zTop } = openingVerticalExtent(project, wall, o);
  const h = zTop - zBottom;
  if (h <= 1e-4) return;
  const p0 = along(wall.start, wall.end, iv.from);
  const width = iv.to - iv.from;
  const frameDepth = Math.min(o.frameThickness ?? total, total);
  const opacity = greyed ? 0.3 : 1;

  // Ein Balken (Box) entlang (u, n, y): Länge len entlang `dir` in der XZ-Ebene,
  // Querschnitt breadth×heightBox. `centerAlong` = Abstand vom p0 entlang `along`,
  // `offN` = Versatz quer (n), `y0..y1` vertikale Lage. Rotiert um Y auf die
  // Achsrichtung.
  const angle = Math.atan2(u.y, u.x); // Achswinkel in der XZ-Ebene (Plan)
  const addBar = (
    mat: THREE.Material,
    aFrom: number,
    aTo: number,
    offN: number,
    breadthN: number,
    y0: number,
    y1: number,
  ) => {
    const lenA = aTo - aFrom;
    const hy = y1 - y0;
    if (lenA <= 1e-5 || hy <= 1e-5 || breadthN <= 1e-5) return;
    const geo = new THREE.BoxGeometry(lenA, hy, breadthN);
    const mesh = new THREE.Mesh(geo, mat);
    // Mittelpunkt: entlang der Achse (aFrom+aTo)/2, quer offN, Höhe (y0+y1)/2.
    const midA = (aFrom + aTo) / 2;
    const cx = p0.x + u.x * midA + n.x * offN;
    const cz = p0.y + u.y * midA + n.y * offN;
    mesh.position.set(cx, (y0 + y1) / 2, cz);
    // Box-Länge liegt auf lokaler X → um Y auf die Plan-Achsrichtung drehen.
    // Plan-Y bildet auf Three-Z ab, daher −angle als Drehung um die Three-Y-Achse.
    mesh.rotation.y = -angle;
    mesh.userData.openingId = o.id;
    if (opts.renderMode === "hidden") {
      const edges = new THREE.EdgesGeometry(geo, 1);
      mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
    }
    group.add(mesh);
  };

  // Rahmen-Material (dunkelgrau) + Glas-Material (bläulich, transparent).
  const frameMat = new THREE.MeshStandardMaterial({
    color: greyed ? 0x9aa0a6 : 0x55606c,
    roughness: 0.55,
    metalness: 0.15,
    envMapIntensity: 0.7,
    transparent: greyed,
    opacity,
  });
  const jambW = 0.05; // 5 cm Rahmenprofil
  // Vertikale Rahmenprofile an beiden Pfosten + oben/unten (nur so breit wie die
  // lichte Öffnung; sie sitzen INNERHALB der Lücke).
  addBar(frameMat, 0, jambW, refOff, frameDepth, zBottom, zTop);
  addBar(frameMat, width - jambW, width, refOff, frameDepth, zBottom, zTop);
  addBar(frameMat, jambW, width - jambW, refOff, frameDepth, zTop - jambW, zTop);
  addBar(frameMat, jambW, width - jambW, refOff, frameDepth, zBottom, zBottom + jambW);

  if (o.kind === "window") {
    // Glasscheibe in der Wandmitte, zwischen den Rahmenprofilen.
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9fc4e8,
      roughness: 0.08,
      metalness: 0,
      envMapIntensity: 1,
      transparent: true,
      opacity: greyed ? 0.18 : 0.35,
      depthWrite: false,
    });
    addBar(
      glassMat,
      jambW,
      width - jambW,
      refOff,
      Math.min(0.02, frameDepth * 0.4),
      zBottom + jambW,
      zTop - jambW,
    );
    return;
  }

  // Tür: flaches Blatt in geöffneter Stellung. Anschlag am Scharnier-Pfosten,
  // gedreht um swingAngle in die Aufschlagrichtung. Das Blatt liegt VERTIKAL vom
  // Boden (zBottom) bis zTop; sein Grundriss-Verlauf folgt der doorSymbol-Achse.
  const sym = doorSymbol(wall, o);
  if (!sym) return;
  const leafMat = new THREE.MeshStandardMaterial({
    color: greyed ? 0xb0b4b8 : 0x8a6f57,
    roughness: 0.75,
    metalness: 0,
    envMapIntensity: 0.6,
    transparent: greyed,
    opacity,
  });
  // Blatt als dünne Box zwischen hinge und openEnd (im Grundriss), vertikal
  // extrudiert. Länge = Türbreite, Dicke ~4 cm.
  const dx = sym.openEnd.x - sym.hinge.x;
  const dz = sym.openEnd.y - sym.hinge.y;
  const leafLen = Math.hypot(dx, dz);
  if (leafLen <= 1e-4) return;
  const leafAngle = Math.atan2(dz, dx);
  const leafGeo = new THREE.BoxGeometry(leafLen, zTop - zBottom, 0.04);
  const leaf = new THREE.Mesh(leafGeo, leafMat);
  leaf.position.set(
    sym.hinge.x + dx / 2,
    (zBottom + zTop) / 2,
    sym.hinge.y + dz / 2,
  );
  leaf.rotation.y = -leafAngle;
  leaf.userData.openingId = o.id;
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(leafGeo, 1);
    leaf.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(leaf);
}

/**
 * MeshStandardMaterial pro Component-ID gecached (3D-Farbe = component.color).
 * Rauigkeit hoch (mattes Putz-/Wandbild), keine Metallizität — passend für
 * Wände/Decken. Gedimmte Variante: Bauteilfarbe Richtung Grau gemischt +
 * transparent, damit gedimmte Geschosse/Kategorien als „andere" sichtbar,
 * aber zurückgenommen sind.
 */
function layerMaterial(
  project: Project,
  componentId: string,
  greyed: boolean,
  opts: BuildOpts,
): THREE.MeshStandardMaterial {
  const { mats } = opts;
  // Drahtgitter: Component-Material mit wireframe=true. Wird mitgecacht; da der
  // Render-Modus den gesamten Szenen-Neuaufbau auslöst, ist der Cache pro Modus
  // konsistent (die Caches leben innerhalb des Aufbau-Effekts).
  const wireframe = opts.renderMode === "wireframe";
  const cache = greyed ? mats.greyed : mats.normal;
  let mat = cache.get(componentId);
  if (!mat) {
    const color = new THREE.Color(getComponent(project, componentId).color);
    if (greyed) {
      // Zu mittlerem Grau hin mischen (entsättigen) und transparent machen.
      color.lerp(new THREE.Color(0x9aa0a6), 0.7);
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
      });
    }
    cache.set(componentId, mat);
  }
  return mat;
}

/**
 * Ein Schicht-Prisma: das (ggf. gehrte) Band-Polygon von Achs-Abstand s..e
 * zwischen den Offsets offA..offB wird vertikal von baseY bis topY extrudiert.
 * Es wird exakt dasselbe Polygon wie im Grundriss verwendet.
 * Gehrung greift nur an den echten Wandenden (s==0 bzw. e==length).
 * `baseElevation` verschiebt das Prisma vertikal (Geschoss-Stapelung).
 */
function addLayerPrism(
  group: THREE.Group,
  wall: Wall,
  s: number,
  e: number,
  baseY: number,
  topY: number,
  offA: number,
  offB: number,
  cuts: WallCuts,
  baseElevation: number,
  mat: THREE.Material,
  opts: BuildOpts,
): void {
  if (e - s <= 1e-6) return;
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const p1 = along(wall.start, wall.end, s);
  const p2 = along(wall.start, wall.end, e);
  const startCut = s <= 1e-6 ? cuts.startCut : null;
  const endCut = e >= length - 1e-6 ? cuts.endCut : null;

  const quad = clippedBand(p1, p2, offA, offB, startCut, endCut);

  // Plan (x,y) → Three (x, y). Y-Spiegelung, damit die Form im Three-XY-
  // System dieselbe Wicklung behält wie im Grundriss; nach der Extrusion
  // wird das Prisma so rotiert, dass Plan-Y auf die Three-Z-Achse fällt.
  const shape = new THREE.Shape();
  const pt = (v: Vec2, i: number) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y));
  quad.forEach(pt);
  shape.closePath();

  const depth = topY - baseY;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  // Texturiert-Modus mit aoMap: die Ambient-Occlusion-Karte liest aus `uv2`.
  // ExtrudeGeometry erzeugt nur `uv`; wir kopieren sie nach `uv2` (gleiche UV-
  // Koordinaten in Welt-Metern → identische Kachelung wie die übrigen Karten).
  const std = mat as THREE.MeshStandardMaterial;
  if (opts.renderMode === "textured" && std.isMeshStandardMaterial && std.aoMap) {
    const uv = geo.getAttribute("uv");
    if (uv && !geo.getAttribute("uv2")) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute((uv as THREE.BufferAttribute).array, 2),
      );
    }
  }
  const mesh = new THREE.Mesh(geo, mat);
  // Wand-ID für die Raycast-Auswahl mitführen (Links-Klick im Viewport).
  mesh.userData.wallId = wall.id;
  // ExtrudeGeometry liegt in der XY-Ebene und wächst entlang +Z. Drehung +90°
  // um X bildet Plan (x,y) → Three (x, z=y) ab (wie zuvor bei den Boxen); die
  // Extrusion zeigt dadurch nach −Y, deshalb sitzt die Form auf topY und
  // wächst hinunter bis baseY. Die baseElevation hebt das gesamte Geschoss an.
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = topY + baseElevation;
  // Verdeckte Kanten: schwarze EdgesGeometry-Linien als Kind des Mesh (erben
  // dessen Transform). Zusammen mit den (tiefen-getesteten) weißen Faces +
  // polygonOffset ergibt das den Hidden-Line-Look (Kanten dahinter verdeckt).
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(geo, 1);
    mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(mesh);
}

/**
 * Eine Decke als extrudierter Slab: das geschlossene Umriss-Polygon wird um die
 * Deckendicke extrudiert und an die OK (zTop) der Decke gesetzt (wächst nach
 * unten bis zBottom) — dieselbe Plan→Three-Abbildung und Extrusions-Konvention
 * wie beim Wand-Schicht-Prisma. Das Material folgt dem Render-Modus (analog Wand)
 * und wird aus dem BAUTEIL der ersten Schicht des Aufbau-Typs aufgelöst.
 * `userData.ceilingId` trägt die Auswahl-ID für den Raycast.
 */
function addCeilingMesh(
  group: THREE.Group,
  project: Project,
  ceiling: Ceiling,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const outline = ceiling.outline;
  if (outline.length < 3) return;
  const wt = getCeilingType(project, ceiling);
  if (wt.layers.length === 0) return;
  const componentId = wt.layers[0].componentId;
  const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
  const depth = zTop - zBottom;
  if (depth <= 1e-6) return;

  // Material je Render-Modus (wie addWallMeshes).
  const textured = opts.renderMode === "textured";
  const textureMat = textured
    ? opts.matRuntime.get(getComponent(project, componentId).material)
    : null;
  const mat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : textured && textureMat
          ? textureMat
          : layerMaterial(project, componentId, greyed, opts);

  const shape = new THREE.Shape();
  outline.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  // aoMap-UV2-Kopie wie beim Wand-Prisma (Texturiert-Modus).
  const std = mat as THREE.MeshStandardMaterial;
  if (opts.renderMode === "textured" && std.isMeshStandardMaterial && std.aoMap) {
    const uv = geo.getAttribute("uv");
    if (uv && !geo.getAttribute("uv2")) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute((uv as THREE.BufferAttribute).array, 2),
      );
    }
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.ceilingId = ceiling.id;
  // Plan (x,y) → Three (x, z=y); Extrusion zeigt nach −Y, daher an OK setzen.
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = zTop;
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(geo, 1);
    mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(mesh);
}

/** Neutraler Tragwerks-Grauton für Stützen ohne Bauteil (identisch zu `COLUMN_RGB` in `toWalls3d/columns.ts`). */
const COLUMN_FALLBACK_COLOR = new THREE.Color(0.7, 0.7, 0.72);

/**
 * Material einer Stütze: mit `componentId` dasselbe gecachte Bauteil-Material
 * wie Wand/Decke (`layerMaterial`); ohne `componentId` ein eigener, ebenfalls
 * gecachter neutraler Grauton (Schlüssel `__column-fallback__`, kollisionsfrei
 * mit echten Component-IDs).
 */
function columnMaterial(
  project: Project,
  componentId: string | undefined,
  greyed: boolean,
  opts: BuildOpts,
): THREE.MeshStandardMaterial {
  if (componentId) return layerMaterial(project, componentId, greyed, opts);
  const { mats } = opts;
  const wireframe = opts.renderMode === "wireframe";
  const cache = greyed ? mats.greyed : mats.normal;
  const key = "__column-fallback__";
  let mat = cache.get(key);
  if (!mat) {
    const color = COLUMN_FALLBACK_COLOR.clone();
    if (greyed) {
      color.lerp(new THREE.Color(0x9aa0a6), 0.7);
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
      });
    }
    cache.set(key, mat);
  }
  return mat;
}

/**
 * Eine Stütze als extrudiertes Prisma (Rechteck- oder Kreis-Profil aus
 * `columnFootprint`, vertikale Lage aus `columnVerticalExtent`) — dieselben
 * reinen Geometrie-Funktionen wie der WASM-Default-3D-Pfad (`toWalls3d/
 * columns.ts::emitColumns`), damit beide Renderer Kontur und Lage identisch
 * zeigen. Bewusst OHNE Geschoss-/Kategorie-Filterung UND ohne Raycast-Auswahl
 * (`userData.columnId` bewusst NICHT gesetzt) — Parität zum WASM-Pfad, der
 * Stützen ebenfalls projektweit ungefiltert emittiert (s. Aufrufer in
 * `buildBuilding`); Interaktion bleibt dem Standard-3D vorbehalten, dieser
 * Fix schliesst nur die Sichtbarkeits-Lücke im Fallback.
 */
function addColumnMeshes(
  group: THREE.Group,
  project: Project,
  column: Column,
  opts: BuildOpts,
): void {
  if (column.height <= 0) return;
  const foot = columnFootprint(column);
  if (foot.length < 3) return;
  const { zBottom, zTop } = columnVerticalExtent(project, column);
  const depth = zTop - zBottom;
  if (depth <= 1e-6) return;

  const mat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : columnMaterial(project, column.componentId, false, opts);

  const shape = new THREE.Shape();
  foot.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  const mesh = new THREE.Mesh(geo, mat);
  // Plan (x,y) → Three (x, z=y); Extrusion zeigt nach −Y, daher an OK setzen.
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = zTop;
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(geo, 1);
    mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(mesh);
}

/**
 * Baut alle `project.extrudedSolids` (truck-Profil-Extrusionen) als Three-
 * Meshes — bislang liess der Three.js-Fallback sie komplett aus (s. PENDENZEN
 * „3D-Elemente-Parität-Audit"). Wiederverwendet `emitExtrudedSolids`
 * (identischer async-truck-Lade-Cache wie der WASM-Pfad, liefert bereits
 * fertige `RMesh`s in Modell-Koordinaten) + den generischen RMesh→Three-
 * Konverter `buildContextMesh` (Modell (x,y,z) → Three (x,z,y), wie bei
 * Kontext-Meshes). Bewusst OHNE Raycast-Auswahl, analog `addColumnMeshes`.
 */
function addExtrudedSolidMeshes(group: THREE.Group, project: Project, opts: BuildOpts): void {
  const meshes = emitExtrudedSolids(project);
  if (meshes.length === 0) return;
  const mat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : extrusionMaterial(opts);
  for (const rmesh of meshes) {
    const mesh = buildContextMesh(rmesh.positions, rmesh.indices, mat);
    if (mesh) group.add(mesh);
  }
}

/** Warmes Orange für truck-Extrusionen im Fallback — identisch zu `EXTRUSION_RGB` in `toWalls3d/extrusions.ts`. */
const EXTRUSION_FALLBACK_COLOR = new THREE.Color(0.85, 0.55, 0.25);

/** Gecachtes, gemeinsames Material für alle truck-Extrusionen im Fallback (fixe Farbe, kein Bauteil-Bezug). */
function extrusionMaterial(opts: BuildOpts): THREE.MeshStandardMaterial {
  const key = "__extrusion-fallback__";
  let mat = opts.mats.normal.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color: EXTRUSION_FALLBACK_COLOR.clone(),
      wireframe: opts.renderMode === "wireframe",
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.6,
    });
    opts.mats.normal.set(key, mat);
  }
  return mat;
}

/**
 * Eine Treppe als gestufte Boxen: jeder Tritt wird als Vollblock von der
 * Treppen-UK (zBottom) bis zur Oberkante SEINER Setzstufe (zBottom + topRise)
 * extrudiert — so entsteht das treppenartige Stufenprofil (Tritt + Setzstufe in
 * einem). Das Zwischenpodest (L/Wendel) wird bis zu seiner Höhe extrudiert. Das
 * Material folgt dem Render-Modus; ein neutraler Beton-Grauton dient als Default.
 * `userData.stairId` trägt die Auswahl-ID für den Raycast.
 *
 * Ist ein Treppentyp (`StairType`) aufgelöst und dessen Tragart ungleich
 * "massiv", wird die Treppe stattdessen UNTEN OFFEN dargestellt: jeder Tritt
 * wird nur als dünne Platte (Dicke `treadThickness`) an seiner Oberkante
 * modelliert, optional mit Trittkanten-Überstand (Nase) und/oder geschlossenen
 * Setzstufen-Platten — je nach `StairType`-Feldern.
 */
function addStairMeshes(
  group: THREE.Group,
  project: Project,
  stair: Stair,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const totalRise = zTop - zBottom;
  if (totalRise <= 1e-6) return;
  const geo = stairGeometry(stair, totalRise);
  const st = getStairType(project, stair);

  // Material je Render-Modus. Ohne Component-Referenz nutzen wir einen neutralen
  // Beton-Grauton (gedimmt heller/transparent).
  const baseMat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : new THREE.MeshStandardMaterial({
            color: greyed ? 0xb8bcc2 : 0x9aa0a6,
            roughness: 0.85,
            metalness: 0,
            envMapIntensity: 0.6,
            transparent: greyed,
            opacity: greyed ? 0.35 : 1,
          });

  // Extrudiert ein geschlossenes Grundriss-Polygon zu einer Platte zwischen
  // `bottom` und `top` (beide relativ zur Treppen-UK `zBottom`). Analog zum
  // Vollblock, aber mit frei wählbarer Unterkante statt immer 0.
  const extrudeSlab = (pts: Vec2[], bottom: number, top: number) => {
    const depth = top - bottom;
    if (pts.length < 3 || depth <= 1e-6) return;
    const shape = new THREE.Shape();
    pts.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    const mesh = new THREE.Mesh(g, baseMat);
    mesh.userData.stairId = stair.id;
    // Plan (x,y) → Three (x, z=y); Extrusion nach −Y, daher an die Platten-OK setzen.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = zBottom + top;
    if (opts.renderMode === "hidden") {
      const edges = new THREE.EdgesGeometry(g, 1);
      mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
    }
    group.add(mesh);
  };

  // Vollblock (Default/"massiv"): von der Treppen-UK bis zur Tritt-Oberkante.
  const extrudeBlock = (pts: Vec2[], top: number) => extrudeSlab(pts, 0, top);

  const centroidOf = (pts: Vec2[]): Vec2 => {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };

  // Bestimmt die "vordere" Kante eines Tritt-Vierecks (die Kante in Richtung
  // des nächsten Tritts). `target` ist der Schwerpunkt eines Nachbartritts;
  // `preferNear` wählt die dem Ziel NÄCHSTE Kante (Nachbar = nächster Tritt),
  // sonst die FERNSTE (Nachbar = vorheriger Tritt, Vorderkante liegt entgegengesetzt).
  // Rückgabe: Indizes der beiden Eckpunkte der Vorderkante + deren Richtung
  // (vom Trittschwerpunkt zur Kantenmitte, normiert).
  const frontEdgeOf = (
    pts: Vec2[],
    target: Vec2,
    preferNear: boolean,
  ): { a: number; b: number; dir: Vec2 } => {
    const c = centroidOf(pts);
    let best = 0;
    let bestDist = preferNear ? Infinity : -Infinity;
    for (let e = 0; e < pts.length; e++) {
      const p0 = pts[e];
      const p1 = pts[(e + 1) % pts.length];
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const d = Math.hypot(mid.x - target.x, mid.y - target.y);
      if (preferNear ? d < bestDist : d > bestDist) {
        bestDist = d;
        best = e;
      }
    }
    const p0 = pts[best];
    const p1 = pts[(best + 1) % pts.length];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const dx = mid.x - c.x;
    const dy = mid.y - c.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    return { a: best, b: (best + 1) % pts.length, dir: { x: dx / len, y: dy / len } };
  };

  if (!st || st.structure === "massiv") {
    // Default/rückwärtskompatibel: durchgehend massive Vollblöcke.
    for (const tr of geo.treads) extrudeBlock(tr.pts, tr.topRise);
  } else {
    // Offene Treppe (Wangen-, aufgesattelte oder Spindeltreppe): dünne
    // Tritt-Platten statt Vollblöcken, darunter bleibt die Treppe offen.
    const treads = geo.treads;
    for (let k = 0; k < treads.length; k++) {
      const tr = treads[k];
      let pts = tr.pts;

      // Nase (Nosing): die Vorderkante des Tritts (Richtung nächster Tritt)
      // um den Überstand nach vorne verlängern. Die Vorderkante wird über den
      // Nachbartritt (Schwerpunkt) bestimmt — für den letzten Tritt (kein
      // Nachfolger) wird stattdessen die dem Vorgänger abgewandte Kante genutzt.
      const nosing = st.nosing ?? 0;
      if (nosing > 1e-6) {
        const hasNext = k + 1 < treads.length;
        const hasPrev = k > 0;
        const ref = hasNext ? treads[k + 1] : hasPrev ? treads[k - 1] : null;
        if (ref) {
          const { a, b, dir } = frontEdgeOf(pts, centroidOf(ref.pts), hasNext);
          const nosed = pts.slice();
          nosed[a] = { x: pts[a].x + dir.x * nosing, y: pts[a].y + dir.y * nosing };
          nosed[b] = { x: pts[b].x + dir.x * nosing, y: pts[b].y + dir.y * nosing };
          pts = nosed;
        }
      }

      // Tritt-Platte: dünne Scheibe, Oberkante an der Setzstufen-Oberkante.
      extrudeSlab(pts, tr.topRise - st.treadThickness, tr.topRise);

      // Geschlossene Setzstufe: vertikale Platte an der RÜCKKante dieses Tritts
      // (= Vorderkante des Vorgängers), von dessen UK (`baseRise`) bis zu
      // dieser Oberkante (`topRise`). Offene Treppe (closedRisers=false) lässt
      // diese Fläche bewusst weg.
      if (st.closedRisers) {
        const hasNext = k + 1 < treads.length;
        const ref = hasNext ? treads[k + 1] : k > 0 ? treads[k - 1] : null;
        if (ref) {
          // Rückkante = Gegenkante der Vorderkante desselben Tritts.
          const front = frontEdgeOf(tr.pts, centroidOf(ref.pts), hasNext);
          const n = tr.pts.length;
          const backA = (front.a + Math.floor(n / 2)) % n;
          const backB = (front.b + Math.floor(n / 2)) % n;
          const riserPts = [tr.pts[backA], tr.pts[backB]];
          // Dünne Platte: Rückkante zu einer flachen Wange in Setzrichtung
          // aufgeweitet (minimaler Versatz nach vorn), damit ein extrudierbares
          // Polygon entsteht.
          const thin = Math.min(st.treadThickness, 0.02) || 0.01;
          const offA = { x: tr.pts[backA].x - front.dir.x * thin, y: tr.pts[backA].y - front.dir.y * thin };
          const offB = { x: tr.pts[backB].x - front.dir.x * thin, y: tr.pts[backB].y - front.dir.y * thin };
          const riserPoly = [riserPts[0], riserPts[1], offB, offA];
          extrudeSlab(riserPoly, tr.baseRise, tr.topRise);
        }
      }

      // TODO Geländer (railing) noch nicht umgesetzt.
    }
  }

  // Podest (L/Wendel-Auge): bis zur mittleren Höhe extrudieren, damit es sichtbar
  // als Absatz erscheint (halber Gesamt-Rise als sinnvoller Default). Bleibt
  // unabhängig von der Tragart immer als Vollblock stehen.
  if (geo.landing && geo.landing.length >= 3) {
    // Höhe des Podests = Höhe des höchsten Tritts unter/an der Podestposition;
    // wir nehmen die halbe Gesamt-Steighöhe als robusten Näherungswert.
    extrudeBlock(geo.landing, totalRise * 0.5);
  }
}
