// IFC4-Export (STEP Physical File / ISO-10303-21) des semantischen Modells.
// Reiner Rechen-/Serialisierungskern: keine UI, kein Datei-IO, kein WASM, keine
// neue Dependency — IFC wird direkt als Text geschrieben (analog exportDxf.ts/
// exportSchedule.ts). Der Download (Blob+Anchor) passiert im App-Layer.
//
// Abbildung (erste vollständige Scheibe):
//   Project → IfcProject → IfcSite → IfcBuilding → je "floor"-Geschoss ein
//   IfcBuildingStorey (IfcRelAggregates-Kette). Bauteile hängen über
//   IfcRelContainedInSpatialStructure am jeweiligen Geschoss (verwaiste
//   Geschossreferenzen fallen defensiv auf IfcBuilding zurück).
//
//   Decken/Treppen/Extrusionen als IfcExtrudedAreaSolid (unser Modell IST
//   Extrusion): Profil = IfcArbitraryClosedProfileDef(IfcPolyline) in der
//   XY-Ebene, extrudiert entlang +Z. Die horizontale Objekt-Platzierungskette
//   (Site/Building/Storey/Element) trägt bewusst NUR die Z-Verschiebung
//   (Geschoss-Elevation); die Profilpunkte tragen direkt die Welt-X/Y-Koordinaten.
//
//   • Wand      → IfcWall mit ÖFFNUNGSGENAUEM Dreiecks-Mesh (IfcTriangulatedFace
//     Set, IFC4: IfcCartesianPointList3D + CoordIndex) statt einer Profil-
//     Extrusion. Gespeist aus DEMSELBEN Loch-Ausschnitt-Mesh wie STL/OBJ
//     (`pickGeometry` → `plan/wallMeshCut.ts`): Joins/Gehrungen UND ausgeschnittene
//     Fenster/Türen (inkl. Laibungen) sind im Körper enthalten. ABWÄGUNG (bewusst,
//     Nutzer-Priorität "so wie im 3D"): dadurch verliert die Wand die parametrische
//     IfcWall-Profil-Extrusion + IfcOpeningElement-Void-Semantik zugunsten
//     VISUELLER PARITÄT in JEDEM Viewer (der Loch schon im Mesh sieht, ohne eine
//     Boolean-Subtraktion ausführen zu müssen — genau der Bug des Nutzers: "das
//     Fenster ist als Objekt da im IFC, aber die Löcher sind nicht da").
//   • Decke     → IfcSlab (outline-Polygon, PredefinedType FLOOR).
//   • Öffnung   → KEIN IfcOpeningElement/Void mehr (das Loch steckt im Wand-Mesh);
//     Tür/Fenster bleiben als eigenes Objekt IfcDoor/IfcWindow mit eigener Box-
//     Geometrie erhalten (füllt das ausgeschnittene Loch, "sieht aus wie 3D").
//   • Extrusion → IfcBuildingElementProxy aus points+height.
//   • Treppe    → IfcStair, GEOMETRISCH bewusst vereinfacht auf einen
//     extrudierten Bounding-Footprint (Lauf-Rechteck bei "straight"; Achsen-
//     ausgerichtete Bounding-Box der Kontrollpunkte bei "L"/"spiral") — die
//     echte Stufengeometrie ist ausgelassen (siehe stairFootprint()).
//
//   Material-Layer (IfcMaterialLayerSet/-Usage) sind NICHT enthalten — die
//   korrekte Direction/Offset-Semantik von IfcMaterialLayerSetUsage ließ sich
//   ohne Gegenprüfung an einem echten Viewer nicht mit ausreichender Sicherheit
//   umsetzen; Geometrie/Hierarchie hatten Vorrang (siehe Bericht/PENDENZEN).
//
//   GUIDs: deterministisch aus der Element-ID über einen 128-Bit-Hash (zwei
//   FNV-1a-64-Läufe) + Standard-IFC-GUID-Kompression (Base64-Variante,
//   Zeichensatz 0-9,A-Z,a-z,_,$) — stabil über Re-Exporte hinweg.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheit: METER.

import type {
  Opening,
  Project,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import {
  getCeilingType,
  getWallType,
  openingLabel,
  wallTypeThickness,
} from "../model/types";
import { projectToWorldCoords } from "../model/geoRebase";
import {
  ceilingVerticalExtent,
  stairVerticalExtent,
  wallReferenceOffset,
  wallVerticalExtent,
} from "../model/wall";
import { pickGeometry } from "../plan/toWalls3d";
import type { RWall } from "../plan/toWalls3d";
import { isWatertight, wallCutMesh } from "../plan/wallMeshCut";

// ── IFC-GUID (Base64-Kompression, 22 Zeichen) ───────────────────────────────
// Standard-Kompressionsalgorithmus (IfcOpenShell guid.compress): das erste
// Byte des 128-Bit-Werts wird auf 2 Zeichen abgebildet, die restlichen 15
// Byte in 5 Dreiergruppen zu je 4 Zeichen — macht 2 + 5×4 = 22 Zeichen.

const IFC_GUID_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** Kodiert `v` big-endian in `len` IFC-GUID-Zeichen (Basis 64). */
function ifcGuidB64(v: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out += IFC_GUID_CHARS[Math.floor(v / 64 ** i) % 64];
  }
  return out;
}

/** Komprimiert einen 128-Bit-Wert (32 Hex-Zeichen) zur 22-stelligen IFC-GUID. */
function compressGuidHex(hex32: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex32.slice(i, i + 2), 16));
  let out = ifcGuidB64(bytes[0], 2);
  for (let i = 1; i < 16; i += 3) {
    const v = (bytes[i] << 16) + (bytes[i + 1] << 8) + bytes[i + 2];
    out += ifcGuidB64(v, 4);
  }
  return out;
}

/** FNV-1a-64 (BigInt) — reines Determinismus-/Streuungs-Werkzeug, keine Kryptografie. */
function fnv1a64(str: string, seed: bigint): bigint {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = seed & mask;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

/** Leitet aus einer stabilen Element-ID einen deterministischen 128-Bit-Hex-Wert ab. */
function idToHex32(id: string): string {
  const h1 = fnv1a64(id, 0xcbf29ce484222325n);
  const h2 = fnv1a64(`${id}salt`, 0x9e3779b97f4a7c15n);
  return h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0");
}

/** Deterministische 22-stellige IFC-GUID aus einer beliebigen Element-ID. */
export function ifcGuid(id: string): string {
  return compressGuidHex(idToHex32(id));
}

// ── STEP-Formatierung ───────────────────────────────────────────────────────

/** STEP-String-Literal ('…', Apostroph verdoppelt, Backslash verdoppelt). */
function S(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `'${escaped}'`;
}

/** STEP-REAL-Literal — immer mit Dezimalpunkt, ohne unnötige Nachkommastellen. */
function R(x: number): string {
  const v = Object.is(x, -0) ? 0 : x;
  let s = v.toFixed(6);
  s = s.replace(/0+$/, "");
  if (s.endsWith(".")) s += "0";
  if (!s.includes(".")) s += ".0";
  return s;
}

/** STEP-Enumerationswert `.WERT.`. */
function ENUM(v: string): string {
  return `.${v}.`;
}

/** STEP-Liste `(a,b,c)`. */
function LIST(items: string[]): string {
  return `(${items.join(",")})`;
}

// ── STEP-Writer ──────────────────────────────────────────────────────────────

class StepWriter {
  private lines: string[] = [];
  private nextId = 1;

  /** Schreibt eine neue Entity-Zeile und liefert ihre `#id`. */
  add(type: string, params: string): number {
    const id = this.nextId++;
    this.lines.push(`#${id}=${type}(${params});`);
    return id;
  }

  get entityLines(): readonly string[] {
    return this.lines;
  }
}

// ── Geometrie-Helfer (reines 2D-Vec2-Rechnen, Welt-Meter) ───────────────────

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}
function leftNormal(u: Vec2): Vec2 {
  return { x: -u.y, y: u.x };
}
function addScaled(p: Vec2, d: Vec2, s: number): Vec2 {
  return { x: p.x + d.x * s, y: p.y + d.y * s };
}

/** Rechteck-Footprint einer Öffnung im Wandloch (volle Wanddicke tief), CCW. */
function openingFootprint(project: Project, wall: Wall, opening: Opening): Vec2[] {
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u);
  const t = wallTypeThickness(getWallType(project, wall));
  const off = wallReferenceOffset(wall, t);
  const inner = -t / 2 + off;
  const outer = t / 2 + off;
  const a = addScaled(wall.start, u, opening.position);
  const b = addScaled(wall.start, u, opening.position + opening.width);
  return [
    addScaled(a, n, inner),
    addScaled(b, n, inner),
    addScaled(b, n, outer),
    addScaled(a, n, outer),
  ];
}

/**
 * Vereinfachter Bounding-Footprint einer Treppe (bewusst NICHT die echte
 * Stufen-/Podestkontur, siehe Dateikopf):
 *   • "straight" — echtes, ausgerichtetes Lauf-Rechteck (Länge × Breite).
 *   • "L"/"spiral" — achsenausgerichtete Bounding-Box der Kontrollpunkte
 *     (Start/Eckpunkt/Ende bzw. Wendel-Zentrum±Radius), um die halbe
 *     Laufbreite erweitert.
 */
function stairFootprint(stair: Stair): Vec2[] {
  const halfW = Math.max(stair.width, 0) / 2;
  if (stair.shape === "straight") {
    const u = normalize(stair.dir);
    const n = leftNormal(u);
    const end = addScaled(stair.start, u, stair.runLength);
    return [
      addScaled(stair.start, n, -halfW),
      addScaled(end, n, -halfW),
      addScaled(end, n, halfW),
      addScaled(stair.start, n, halfW),
    ];
  }
  const pts: Vec2[] = [stair.start];
  const u = normalize(stair.dir);
  const corner = addScaled(stair.start, u, stair.runLength);
  pts.push(corner);
  if (stair.shape === "L" && stair.run2Length && stair.turn) {
    const n = leftNormal(u);
    const turnDir: Vec2 = { x: n.x * stair.turn, y: n.y * stair.turn };
    pts.push(addScaled(corner, turnDir, stair.run2Length));
  }
  if (stair.shape === "spiral" && stair.center) {
    const r = (stair.radius ?? 0) + halfW;
    const c = stair.center;
    return [
      { x: c.x - r, y: c.y - r },
      { x: c.x + r, y: c.y - r },
      { x: c.x + r, y: c.y + r },
      { x: c.x - r, y: c.y + r },
    ];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  minX -= halfW;
  minY -= halfW;
  maxX += halfW;
  maxY += halfW;
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

// ── IFC4-Export ──────────────────────────────────────────────────────────────

interface StoreyRef {
  entityId: number;
  placementId: number;
  baseElevation: number;
}

interface Structure {
  entityId: number;
  placementId: number;
  baseElevation: number;
}

/**
 * Baut aus einem Projekt einen vollständigen IFC4-SPF-String (STEP Physical
 * File). Reiner Rechenkern — kein Datei-IO. Leeres Projekt ⇒ valider Minimal-
 * IFC (Project/Site/Building, kein Crash).
 */
export function exportIfcSpf(projectIn: Project): string {
  // Georeferenziert exportieren: ist ein Standort-Bezug gesetzt (geoAnchor),
  // wird die gesamte Geometrie auf die ECHTEN LV95-Weltkoordinaten verschoben,
  // damit die IFC-Datei in anderer Software lagerichtig sitzt — auch wenn das
  // Modell lokal nahe (0,0) bearbeitet wurde (s. projectToWorldCoords / der
  // „Neuer Bezugspunkt"-Workflow). Ohne Bezug bleibt alles lokal (Identität).
  const project = projectToWorldCoords(projectIn);
  const w = new StepWriter();

  // Geteilte Grundgeometrie: Ursprung, Z-Extrusionsrichtung, Identitäts-
  // Placement (Position aller ExtrudedAreaSolid — Profile tragen direkt
  // Welt-X/Y, siehe Dateikopf).
  const originPoint = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(0)]));
  const extrudeDir = w.add("IFCDIRECTION", LIST([R(0), R(0), R(1)]));
  const identityAxis = w.add("IFCAXIS2PLACEMENT3D", `#${originPoint},$,$`);

  // Owner-History (minimal, aber vorhanden — manche Importer verlangen sie).
  const org = w.add("IFCORGANIZATION", `$,${S("dossier")},$,$,$`);
  const person = w.add(
    "IFCPERSON",
    `${S("dossier")},$,$,$,$,$,$,$`,
  );
  const personOrg = w.add("IFCPERSONANDORGANIZATION", `#${person},#${org},$`);
  const app = w.add(
    "IFCAPPLICATION",
    `#${org},${S("1.0")},${S("dossier")},${S("dossier")}`,
  );
  const ownerHistory = w.add(
    "IFCOWNERHISTORY",
    `#${personOrg},#${app},$,${ENUM("ADDED")},$,$,$,${Math.floor(Date.now() / 1000)}`,
  );

  // Einheiten (Meter, Radiant, m², m³).
  const lenUnit = w.add("IFCSIUNIT", `*,${ENUM("LENGTHUNIT")},$,${ENUM("METRE")}`);
  const areaUnit = w.add("IFCSIUNIT", `*,${ENUM("AREAUNIT")},$,${ENUM("SQUARE_METRE")}`);
  const volUnit = w.add("IFCSIUNIT", `*,${ENUM("VOLUMEUNIT")},$,${ENUM("CUBIC_METRE")}`);
  const angleUnit = w.add(
    "IFCSIUNIT",
    `*,${ENUM("PLANEANGLEUNIT")},$,${ENUM("RADIAN")}`,
  );
  const unitAssignment = w.add(
    "IFCUNITASSIGNMENT",
    LIST([`#${lenUnit}`, `#${areaUnit}`, `#${volUnit}`, `#${angleUnit}`]),
  );

  // Geometrischer Kontext (3D, Precision 1e-5).
  const context = w.add(
    "IFCGEOMETRICREPRESENTATIONCONTEXT",
    `$,${S("Model")},3,${R(0.00001)},#${identityAxis},$`,
  );

  // Räumliche Hierarchie: Project → Site → Building → Storeys.
  const siteAxis = w.add("IFCAXIS2PLACEMENT3D", `#${originPoint},$,$`);
  const sitePlacement = w.add("IFCLOCALPLACEMENT", `$,#${siteAxis}`);
  const buildingAxis = w.add("IFCAXIS2PLACEMENT3D", `#${originPoint},$,$`);
  const buildingPlacement = w.add(
    "IFCLOCALPLACEMENT",
    `#${sitePlacement},#${buildingAxis}`,
  );

  const projectId = w.add(
    "IFCPROJECT",
    `${S(ifcGuid(`${project.id}:project`))},#${ownerHistory},${S(project.name || "Projekt")},$,$,$,$,${LIST([`#${context}`])},#${unitAssignment}`,
  );
  // RefElevation (m ü. M.): reale Datumshöhe des Standorts aus dem
  // Georeferenzierungs-Bezug (wie ArchiCADs Vermessungspunkt). Rein informativ —
  // die Geometrie wird NICHT verschoben (das Terrain trägt bereits reale Höhen).
  const refElevation = project.geoAnchor?.height;
  const siteRefElev = typeof refElevation === "number" ? R(refElevation) : "$";
  const siteId = w.add(
    "IFCSITE",
    `${S(ifcGuid(`${project.id}:site`))},#${ownerHistory},${S("Standort")},$,$,#${sitePlacement},$,$,${ENUM("ELEMENT")},$,$,${siteRefElev},$,$`,
  );
  const buildingId = w.add(
    "IFCBUILDING",
    `${S(ifcGuid(`${project.id}:building`))},#${ownerHistory},${S(project.name || "Gebäude")},$,$,#${buildingPlacement},$,$,${ENUM("ELEMENT")},$,$,$`,
  );
  w.add(
    "IFCRELAGGREGATES",
    `${S(ifcGuid(`${project.id}:agg-site`))},#${ownerHistory},$,$,#${projectId},${LIST([`#${siteId}`])}`,
  );
  w.add(
    "IFCRELAGGREGATES",
    `${S(ifcGuid(`${project.id}:agg-building`))},#${ownerHistory},$,$,#${siteId},${LIST([`#${buildingId}`])}`,
  );

  // Je "floor"-Geschoss ein IfcBuildingStorey (Elevation = baseElevation).
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  const storeyByFloorId = new Map<string, StoreyRef>();
  const storeyEntityIds: number[] = [];
  for (const floor of floors) {
    const base = floor.baseElevation ?? 0;
    const pt = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(base)]));
    const axis = w.add("IFCAXIS2PLACEMENT3D", `#${pt},$,$`);
    const placementId = w.add("IFCLOCALPLACEMENT", `#${buildingPlacement},#${axis}`);
    const entityId = w.add(
      "IFCBUILDINGSTOREY",
      `${S(ifcGuid(`${floor.id}:storey`))},#${ownerHistory},${S(floor.name)},$,$,#${placementId},$,$,${ENUM("ELEMENT")},${R(base)}`,
    );
    storeyByFloorId.set(floor.id, { entityId, placementId, baseElevation: base });
    storeyEntityIds.push(entityId);
  }
  if (storeyEntityIds.length > 0) {
    w.add(
      "IFCRELAGGREGATES",
      `${S(ifcGuid(`${project.id}:agg-storeys`))},#${ownerHistory},$,$,#${buildingId},${LIST(storeyEntityIds.map((id) => `#${id}`))}`,
    );
  }

  /** Geschoss → Trägerstruktur (Storey), oder defensiv das Gebäude (verwaiste floorId). */
  const resolveStructure = (floorId: string): Structure => {
    const s = storeyByFloorId.get(floorId);
    if (s) return { entityId: s.entityId, placementId: s.placementId, baseElevation: s.baseElevation };
    return { entityId: buildingId, placementId: buildingPlacement, baseElevation: 0 };
  };

  // Räumliche Eingliederung sammelt sich je Trägerstruktur (Storey/Building)
  // und wird am Ende in EINE IfcRelContainedInSpatialStructure je Struktur
  // gebündelt (Öffnungen NICHT — die hängen nur über RelVoidsElement an ihrer
  // Wand, wie in IFC üblich).
  const containment = new Map<number, number[]>();
  const addToContainment = (structureId: number, elementId: number): void => {
    const arr = containment.get(structureId);
    if (arr) arr.push(elementId);
    else containment.set(structureId, [elementId]);
  };

  /** Baut Profil+Extrusion+Shape+Placement für einen geschlossenen Footprint. */
  const emitBoxProduct = (
    footprint: Vec2[],
    zBottomRel: number,
    depth: number,
    placementRelTo: number,
  ): { placementId: number; shapeId: number } => {
    const closed = [...footprint, footprint[0]];
    const ptIds = closed.map((p) => w.add("IFCCARTESIANPOINT", LIST([R(p.x), R(p.y)])));
    const polylineId = w.add("IFCPOLYLINE", LIST(ptIds.map((id) => `#${id}`)));
    const profileId = w.add(
      "IFCARBITRARYCLOSEDPROFILEDEF",
      `${ENUM("AREA")},$,#${polylineId}`,
    );
    const solidId = w.add(
      "IFCEXTRUDEDAREASOLID",
      `#${profileId},#${identityAxis},#${extrudeDir},${R(Math.max(depth, 0.001))}`,
    );
    const shapeRepId = w.add(
      "IFCSHAPEREPRESENTATION",
      `#${context},${S("Body")},${S("SweptSolid")},${LIST([`#${solidId}`])}`,
    );
    const shapeId = w.add("IFCPRODUCTDEFINITIONSHAPE", `$,$,${LIST([`#${shapeRepId}`])}`);
    const elemOrigin = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(zBottomRel)]));
    const elemAxis = w.add("IFCAXIS2PLACEMENT3D", `#${elemOrigin},$,$`);
    const placementId = w.add("IFCLOCALPLACEMENT", `#${placementRelTo},#${elemAxis}`);
    return { placementId, shapeId };
  };

  /**
   * Baut aus einem Dreiecks-Mesh (`positions` flach x,y,z in IFC-Koordinaten —
   * bereits Z-up und relativ zur `placementRelTo`-Herkunft, `indices` je 3 =
   * 1-basiert-1 CoordIndex-Tripel) ein IfcTriangulatedFaceSet + Shape + Placement.
   * IFC4-Tessellierung: IfcCartesianPointList3D (CoordList) + IfcTriangulatedFace
   * Set (CoordIndex, 1-basiert). Das Element-Placement sitzt im Ursprung der
   * Trägerstruktur (die Punkte tragen die Geometrie bereits absolut in deren Frame).
   */
  const emitTriangulatedProduct = (
    positions: number[],
    indices: number[],
    placementRelTo: number,
    closed: boolean,
  ): { placementId: number; shapeId: number } => {
    const coords: string[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      coords.push(`(${R(positions[i])},${R(positions[i + 1])},${R(positions[i + 2])})`);
    }
    const pointListId = w.add("IFCCARTESIANPOINTLIST3D", `(${coords.join(",")})`);
    const tris: string[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      tris.push(`(${indices[i] + 1},${indices[i + 1] + 1},${indices[i + 2] + 1})`);
    }
    // Closed=.T. NUR wenn das Mesh nachweislich ein dichtes, aussen orientiertes
    // Volumen ist (siehe isWatertight): Wände sind extrudierte Querschnitts-
    // Polygone (Fenster = Durchgangsloch, Tür = umlaufende П-Kerbe) → geschlossene
    // Körper → `.T.` (Viewer rendern sie als Solid statt als offene Fläche). Der
    // Guard fängt echte Defekte ab (invertierte Wicklung → Volumen < 0 → `$`).
    // Normals=$ (Viewer leitet sie aus der — jetzt aussen orientierten — Wicklung ab).
    const closedFlag = closed ? ".T." : "$";
    const faceSetId = w.add("IFCTRIANGULATEDFACESET", `#${pointListId},$,${closedFlag},(${tris.join(",")}),$`);
    const shapeRepId = w.add(
      "IFCSHAPEREPRESENTATION",
      `#${context},${S("Body")},${S("Tessellation")},${LIST([`#${faceSetId}`])}`,
    );
    const shapeId = w.add("IFCPRODUCTDEFINITIONSHAPE", `$,$,${LIST([`#${shapeRepId}`])}`);
    const elemOrigin = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(0)]));
    const elemAxis = w.add("IFCAXIS2PLACEMENT3D", `#${elemOrigin},$,$`);
    const placementId = w.add("IFCLOCALPLACEMENT", `#${placementRelTo},#${elemAxis}`);
    return { placementId, shapeId };
  };

  /** Baut ein IfcBuildingElement-Subtyp mit dem üblichen 9-Attribut-Flatten. */
  const emitBuildingElement = (
    type: string,
    guid: string,
    name: string,
    placementId: number,
    shapeId: number,
    predefinedType: string | null,
  ): number =>
    w.add(
      type,
      `${S(guid)},#${ownerHistory},${S(name)},$,$,#${placementId},#${shapeId},$,${predefinedType ?? "$"}`,
    );

  // ── Wände (öffnungsgenaues Dreiecks-Mesh statt Profil-Extrusion) ────────
  // Die Wand-Schicht-Bänder kommen aus DEMSELBEN geflachten Modell wie STL/OBJ
  // (`pickGeometry`, Joins/Gehrungen + Öffnungs-`holes` bereits aufgelöst). Alle
  // Bänder einer Wand-Id werden zu EINEM Face-Set vereint. IFC-Koordinaten: das
  // Mesh liegt in Welt (Modell-x, Höhe, Modell-y) mit Y-up → IFC (x, y, z=Höhe)
  // mit Z-up, also (mx, mz, my); Z relativ zur Geschoss-UK, damit die Storey-
  // Placement-Elevation nicht doppelt zählt.
  //
  // WICHTIG — WICKLUNG: der Achsen-Swap (x,y,z)→(x,z,y) ist eine REFLEXION
  // (Determinante −1) und KEHRT die Dreiecks-Wicklung UM → aus aussen orientierten
  // würden innen orientierte Normalen, der Viewer cullt dann die Vorderseiten und
  // die Wand wirkt HOHL/offen (genau der gemeldete Bug). Deshalb wird beim Swap
  // die Wicklung jedes Dreiecks umgedreht (i0,i2,i1), damit die Aussen-Normalen
  // aussen bleiben. Watertightness (isWatertight) misst das anschliessend am
  // fertigen IFC-Mesh → treibt das Closed-Flag des Face-Sets.
  const bandsByWallId = new Map<string, RWall[]>();
  for (const band of pickGeometry(project).walls) {
    const list = bandsByWallId.get(band.wallId);
    if (list) list.push(band);
    else bandsByWallId.set(band.wallId, [band]);
  }
  const wallEntityIdByWallId = new Map<string, number>();
  for (const wall of project.walls ?? []) {
    const bands = bandsByWallId.get(wall.id);
    if (!bands || bands.length === 0) continue; // degenerierte Wand / keine Geometrie
    const structure = resolveStructure(wall.floorId);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const band of bands) {
      const cut = wallCutMesh(band);
      const base = positions.length / 3;
      for (let i = 0; i < cut.positions.length; i += 3) {
        positions.push(
          cut.positions[i],
          cut.positions[i + 2],
          cut.positions[i + 1] - structure.baseElevation,
        );
      }
      // Wicklung umkehren (Reflexions-Ausgleich, s. o.): (a,b,c) → (a,c,b).
      for (let i = 0; i < cut.indices.length; i += 3) {
        indices.push(base + cut.indices[i], base + cut.indices[i + 2], base + cut.indices[i + 1]);
      }
    }
    if (indices.length === 0) continue;
    const closed = isWatertight({ positions, indices });
    const { placementId, shapeId } = emitTriangulatedProduct(positions, indices, structure.placementId, closed);
    let name = wall.id;
    try {
      name = getWallType(project, wall).name;
    } catch {
      /* verwaister Wandtyp — Roh-ID als Name */
    }
    const entityId = emitBuildingElement("IFCWALL", ifcGuid(wall.id), name, placementId, shapeId, null);
    wallEntityIdByWallId.set(wall.id, entityId);
    addToContainment(structure.entityId, entityId);
  }

  // ── Decken ─────────────────────────────────────────────────────────────
  for (const ceiling of project.ceilings ?? []) {
    if (ceiling.outline.length < 3) continue;
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    const structure = resolveStructure(ceiling.floorId);
    const { placementId, shapeId } = emitBoxProduct(
      ceiling.outline,
      zBottom - structure.baseElevation,
      zTop - zBottom,
      structure.placementId,
    );
    let name: string = ceiling.id;
    try {
      name = getCeilingType(project, ceiling).name;
    } catch {
      /* verwaister Deckentyp — Roh-ID als Name */
    }
    const entityId = emitBuildingElement(
      "IFCSLAB",
      ifcGuid(ceiling.id),
      name,
      placementId,
      shapeId,
      ENUM("FLOOR"),
    );
    addToContainment(structure.entityId, entityId);
  }

  // ── Fenster/Türen als eigene Objekte (IfcDoor/IfcWindow) ────────────────
  // KEIN IfcOpeningElement/IfcRelVoidsElement/IfcRelFillsElement mehr: das Loch
  // steckt bereits im Wand-Face-Set (s. o.). Eine Void-Relation beschriebe eine
  // Boolean-Subtraktion gegen einen Swept-Solid, den es nicht mehr gibt — sie
  // brächte in den Viewern nur Verwirrung (der Nutzer-Bug war genau, dass die
  // Void nicht subtrahiert wurde). Tür/Fenster bleiben als EIGENES Objekt mit
  // eigener Box-Geometrie erhalten, die das ausgeschnittene Loch füllt ("sieht
  // aus wie 3D"): kein Blatt-/Rahmendetail (bewusste Vereinfachung).
  for (const opening of project.openings ?? []) {
    const wall = (project.walls ?? []).find((wl) => wl.id === opening.hostWallId);
    if (!wall) continue; // verwaiste Wirtswand — keine Geometrie ableitbar
    if (!wallEntityIdByWallId.has(wall.id)) continue; // Wirtswand übersprungen (degeneriert)

    const wallExtent = wallVerticalExtent(project, wall);
    const structure = resolveStructure(wall.floorId);
    const footprint = openingFootprint(project, wall, opening);
    const zSillAbs = wallExtent.zBottom + opening.sillHeight;

    const { placementId: fillPlacement, shapeId: fillShape } = emitBoxProduct(
      footprint,
      zSillAbs - structure.baseElevation,
      opening.height,
      structure.placementId,
    );
    const fillGuid = ifcGuid(`${opening.id}:fill`);
    const fillName = openingLabel(opening);
    const fillEntityId =
      opening.kind === "door"
        ? w.add(
            "IFCDOOR",
            `${S(fillGuid)},#${ownerHistory},${S(fillName)},$,$,#${fillPlacement},#${fillShape},$,${R(opening.height)},${R(opening.width)},${ENUM("DOOR")},$,$`,
          )
        : w.add(
            "IFCWINDOW",
            `${S(fillGuid)},#${ownerHistory},${S(fillName)},$,$,#${fillPlacement},#${fillShape},$,${R(opening.height)},${R(opening.width)},${ENUM("WINDOW")},$,$`,
          );
    addToContainment(structure.entityId, fillEntityId);
  }

  // ── Treppen (vereinfachter Bounding-Footprint, siehe Dateikopf) ────────
  for (const stair of project.stairs ?? []) {
    const footprint = stairFootprint(stair);
    if (footprint.length < 3) continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const structure = resolveStructure(stair.floorId);
    const { placementId, shapeId } = emitBoxProduct(
      footprint,
      zBottom - structure.baseElevation,
      zTop - zBottom,
      structure.placementId,
    );
    const predefinedType =
      stair.shape === "straight"
        ? ENUM("STRAIGHT_RUN_STAIR")
        : stair.shape === "spiral"
          ? ENUM("SPIRAL_STAIR")
          : ENUM("QUARTER_TURN_STAIR");
    const entityId = emitBuildingElement(
      "IFCSTAIR",
      ifcGuid(stair.id),
      "Treppe",
      placementId,
      shapeId,
      predefinedType,
    );
    addToContainment(structure.entityId, entityId);
  }

  // ── Extrudierte Körper (truck-Integration) → IfcBuildingElementProxy ───
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.points.length < 3) continue;
    const floor = floors.find((f) => f.id === solid.levelId);
    const base = floor?.baseElevation ?? 0;
    const structure = resolveStructure(solid.levelId);
    const { placementId, shapeId } = emitBoxProduct(
      solid.points,
      base - structure.baseElevation,
      solid.height,
      structure.placementId,
    );
    const entityId = emitBuildingElement(
      "IFCBUILDINGELEMENTPROXY",
      ifcGuid(solid.id),
      "Extrusion",
      placementId,
      shapeId,
      null,
    );
    addToContainment(structure.entityId, entityId);
  }

  // ── Räumliche Eingliederung (gebündelt je Trägerstruktur) ──────────────
  for (const [structureId, elementIds] of containment) {
    w.add(
      "IFCRELCONTAINEDINSPATIALSTRUCTURE",
      `${S(ifcGuid(`contain:${structureId}`))},#${ownerHistory},$,$,${LIST(elementIds.map((id) => `#${id}`))},#${structureId}`,
    );
  }

  // ── Kopf + Zusammenbau ───────────────────────────────────────────────────
  const iso = new Date().toISOString().replace(/\.\d+Z$/, "");
  const fileName = `${project.name || "modell"}.ifc`;
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(${LIST([S("")])},${S("2;1")});`,
    `FILE_NAME(${S(fileName)},${S(iso)},${LIST([S("dossier")])},${LIST([S("dossier")])},${S("dossier")},${S("dossier")},${S("")});`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "",
    "DATA;",
  ];
  const footer = ["ENDSEC;", "END-ISO-10303-21;"];

  return [...header, ...w.entityLines, ...footer].join("\n") + "\n";
}
