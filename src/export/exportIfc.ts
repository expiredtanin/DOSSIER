// IFC4-Export (STEP Physical File / ISO-10303-21) des semantischen Modells.
// Reiner Rechen-/Serialisierungskern: keine UI, kein Datei-IO, kein WASM, keine
// neue Dependency — IFC wird direkt als Text geschrieben (analog exportDxf.ts/
// exportSchedule.ts). Der Download (Blob+Anchor) passiert im App-Layer.
//
// Abbildung:
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
//   • Wand      → IfcWall aus denselben Schicht-Bändern wie das 3D (`pickGeometry`: Joins/
//     Gehrungen, Decken-Dominanz, Durchgangs-Aussparungen bereits aufgelöst). Zwei Wege ([B5]):
//       – Regelfall: UNGESCHNITTENER Körper, je Band ein IfcExtrudedAreaSolid (Rechteck × Höhe)
//         in EINER SweptSolid-Darstellung; Fenster/Türen als IfcOpeningElement (IfcRelVoids
//         Element), der Viewer zieht sie ab. Gewählt nur, wenn das exakt dasselbe ergibt wie das
//         3D: jedes Band ist ein Quader (keine schräge Oberkante) und seine Löcher sind genau die
//         Öffnungen (`bandsMatchOpenings`).
//       – sonst (Wand unter Dach mit schräger Oberkante, Laibungs-Rücksprung der innersten
//         Schicht …): öffnungsgenaues Dreiecks-Mesh (IfcTriangulatedFaceSet) wie STL/OBJ
//         (`plan/wallMeshCut.ts`, Löcher inkl. Laibungen schon ausgestanzt). Öffnung + Füllung
//         werden trotzdem als Beziehung angelegt; die Öffnung liegt im Loch und zieht nichts ab.
//   • Decke     → IfcSlab (outline-Polygon, PredefinedType FLOOR).
//   • Öffnung   → IfcOpeningElement (Quader über die ganze Wanddicke, etwas vorstehend) in der
//     Wand (IfcRelVoidsElement), darin IfcDoor/IfcWindow (IfcRelFillsElement) mit eigener
//     Box-Geometrie; kein Blatt-/Rahmendetail (bewusste Vereinfachung).
//   • Extrusion → IfcBuildingElementProxy aus points+height.
//   • Dach      → IfcRoof (Schicht-Meshes wie im 3D), Dachtyp → IfcRoofType mit Schichten.
//   • Stütze    → IfcColumn (Profil-Extrusion), Bauteil → IfcMaterial.
//   • Raum      → IfcSpace (im Geschoss aggregiert) mit Qto_SpaceBaseQuantities und SIA-416-Kategorie.
//   • Treppe    → IfcStair, GEOMETRISCH bewusst vereinfacht auf einen
//     extrudierten Bounding-Footprint (Lauf-Rechteck bei "straight"; Achsen-
//     ausgerichtete Bounding-Box der Kontrollpunkte bei "L"/"spiral") — die
//     echte Stufengeometrie ist ausgelassen (siehe stairFootprint()).
//
//   Material-Schichten: je Wand-/Deckentyp ein IfcWallType/IfcSlabType mit
//   IfcMaterialLayerSet, die Exemplare erben ihn über IfcRelDefinesByType. (Noch) KEIN
//   IfcMaterialLayerSetUsage am Exemplar: die Wand hat keine Achs-Darstellung.
//
//   Eigenschaften ([B5]): Pset_WallCommon/SlabCommon/RoofCommon/ColumnCommon/DoorCommon/
//   WindowCommon/SpaceCommon nur mit Werten, die das Modell hergibt (Reference = Typname,
//   IsExternal beim Dach und bei SIA-416-AGF-Räumen, Glasanteil der Glastür). Kein U-Wert,
//   keine Tragfunktion: dafür hat das Modell keine Felder.
//
//   GUIDs ([B5]/[10]): deterministisch aus `<Projekt-id>/<Art>/<id>[/<Zusatz>]` über einen
//   128-Bit-Hash + Standard-IFC-GUID-Kompression (Zeichensatz 0-9,A-Z,a-z,_,$) — zweimal
//   exportieren gibt dieselben GlobalIds, BIM-Koordination (Solibri, BIMcollab) erkennt die
//   Bauteile wieder. Abgeleitete Entitäten (Rels, Typen, Psets) hängen an Element-/Geschoss-/
//   Typ-ids, nie an STEP-Nummern.
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
  columnLabel,
  getCeilingType,
  getDoorType,
  getWallType,
  getWindowType,
  openingLabel,
  openingsOfWall,
} from "../model/types";
import { projectToWorldCoords } from "../model/geoRebase";
import {
  ceilingVerticalExtent,
  columnVerticalExtent,
  stairVerticalExtent,
} from "../model/wall";
import { pickGeometry } from "../plan/toWalls3d";
import type { RWall } from "../plan/toWalls3d";
import { isWatertight, wallCutMeshes, type CutMesh } from "../plan/wallMeshCut";
import { evaluateRoom } from "../geometry/roomArea";
import { columnFootprint } from "../geometry/column";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { emitRoofs } from "../plan/toWalls3d/roofs";

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

const MASK64 = 0xffffffffffffffffn;

/** Mischt die Bits eines 64-Bit-Werts (MurmurHash3-fmix64): jedes Eingabebit wirkt auf alle Ausgabebits. */
function fmix64(k: bigint): bigint {
  k ^= k >> 33n;
  k = (k * 0xff51afd7ed558ccdn) & MASK64;
  k ^= k >> 33n;
  k = (k * 0xc4ceb9fe1a85ec53n) & MASK64;
  k ^= k >> 33n;
  return k;
}

/** FNV-1a-64 über Bytes (vorwärts oder rückwärts) — reines Streuungswerkzeug, keine Kryptografie. */
function fnv1a64(bytes: Uint8Array, seed: bigint, reverse: boolean): bigint {
  const prime = 0x100000001b3n;
  let hash = seed & MASK64;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[reverse ? bytes.length - 1 - i : i]);
    hash = (hash * prime) & MASK64;
  }
  return hash;
}

const utf8 = new TextEncoder();

/**
 * Deterministischer 128-Bit-Wert (32 Hex-Zeichen) aus einem Namen: zwei unabhängige 64-Bit-Läufe
 * (FNV-1a vorwärts/rückwärts mit verschiedenen Startwerten, je fmix64-nachgemischt), gekennzeichnet
 * als RFC-9562-UUID Version 8 (namensbasiert, eigener Hash) mit Variante 10.
 */
function nameToHex32(name: string): string {
  const bytes = utf8.encode(name);
  const h1 = fmix64(fnv1a64(bytes, 0xcbf29ce484222325n, false));
  const h2 = fmix64(fnv1a64(bytes, 0x9e3779b97f4a7c15n, true) ^ BigInt(bytes.length));
  const hex = (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).split("");
  hex[12] = "8"; // Version 8
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // Variante 10xx
  return hex.join("");
}

/**
 * Deterministische 22-stellige IFC-GUID aus einem Namen. Im Export lautet der Name immer
 * `<Projekt-id>/<Art>/<id>[/<Zusatz>]` (s. `exportIfcSpf`), damit gleiche ids verschiedener
 * Bauteilarten oder Projekte nicht kollidieren.
 */
export function ifcGuid(name: string): string {
  return compressGuidHex(nameToHex32(name));
}

// ── STEP-Formatierung ───────────────────────────────────────────────────────

/**
 * STEP-String-Literal (ISO 10303-21): druckbares ASCII bleibt, Backslash und Apostroph werden
 * verdoppelt, alles andere (Umlaute, Steuerzeichen) als \X2\HHHH…\X0\ (BMP) bzw.
 * \X4\HHHHHHHH…\X0\ (ausserhalb der BMP). Die Datei bleibt so reines ASCII.
 */
export function ifcString(s: string): string {
  let out = "";
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const wide = run.some((c) => c > 0xffff);
    const hex = run.map((c) => c.toString(16).toUpperCase().padStart(wide ? 8 : 4, "0")).join("");
    out += `${wide ? "\\X4\\" : "\\X2\\"}${hex}\\X0\\`;
    run = [];
  };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === "\\" ? "\\\\" : ch === "'" ? "''" : ch;
    } else {
      // \X2\ und \X4\ nicht mischen: Wechsel der Breite beginnt einen neuen Block.
      if (run.length > 0 && (run[0] > 0xffff) !== (c > 0xffff)) flush();
      run.push(c);
    }
  }
  flush();
  return `'${out}'`;
}

const S = ifcString;

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
function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** Rechteck `[from,to]` entlang der Wandachse × `[nLo,nHi]` quer dazu (Welt-XY, CCW). */
function axisRect(wall: Wall, from: number, to: number, nLo: number, nHi: number): Vec2[] {
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u);
  const a = addScaled(wall.start, u, from);
  const b = addScaled(wall.start, u, to);
  return [addScaled(a, n, nLo), addScaled(b, n, nLo), addScaled(b, n, nHi), addScaled(a, n, nHi)];
}

/** Öffnung einer Wand, wie sie das 3D als Loch in die Bänder stanzt (Achs-Intervall + absolute Z). */
interface WallCutout {
  opening: Opening;
  from: number;
  to: number;
  zBottom: number;
  zTop: number;
}

/** Toleranz des Rust-Kerns (`wall_bands.rs::EPS`) für „Öffnung trifft Band". */
const BAND_EPS = 1e-4;

/**
 * Ob die Schicht-Bänder einer Wand exakt „Quader minus Öffnungen" sind: kein Band mit schräger
 * Oberkante, und jedes Band trägt genau die Öffnungen als Löcher, die es in der Höhe trifft — in
 * derselben Grösse (kein Laibungs-Rücksprung o. ä.). Dann ergibt Extrusion je Band minus
 * IfcOpeningElement denselben Körper wie das 3D-Mesh.
 */
function bandsMatchOpenings(wall: Wall, bands: readonly RWall[], cutouts: readonly WallCutout[]): boolean {
  const u = normalize(sub(wall.end, wall.start));
  const byFrom = (p: number[], q: number[]) => p[0] - q[0] || p[2] - q[2];
  for (const b of bands) {
    if (b.topDrop && (Math.abs(b.topDrop[0]) > 1e-9 || Math.abs(b.topDrop[1]) > 1e-9)) return false;
    const a = dot({ x: b.start[0] - wall.start.x, y: b.start[1] - wall.start.y }, u);
    const zb = b.baseElevation;
    const zt = b.baseElevation + b.height;
    const expected = cutouts
      .filter((h) => h.zTop > zb + BAND_EPS && h.zBottom < zt - BAND_EPS)
      .map((h) => [h.from - a, h.to - a, h.zBottom, h.zTop])
      .sort(byFrom);
    const actual = (b.holes ?? []).map((h) => [h.from, h.to, h.zBottom, h.zTop]).sort(byFrom);
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      for (let k = 0; k < 4; k++) if (!(Math.abs(expected[i][k] - actual[i][k]) <= 1e-6)) return false;
    }
  }
  return true;
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

interface Structure {
  entityId: number;
  placementId: number;
  baseElevation: number;
  /** Stabiler Schlüssel für abgeleitete GUIDs (`storey/<floorId>` oder `building`). */
  key: string;
}

/** Was die Öffnungen von ihrer Wirtswand brauchen. */
interface WallRef {
  entityId: number;
  placementId: number;
  /** Ausdehnung aller Bänder quer zur Wandachse (entlang der linken Normalen ab `wall.start`). */
  nLo: number;
  nHi: number;
}

/** Wie weit der Öffnungskörper beidseits über die Wandflächen vorsteht (keine koplanaren Booleans). */
const OPENING_OVERSHOOT = 0.02;

/** IFC-Wert-Ausdruck einer Pset-Eigenschaft, z. B. `IFCIDENTIFIER('…')`. */
type PropValue = string;

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

  /** Dauerhafte GlobalId (als STEP-String) aus `<Art>/<id>[/<Zusatz>]`, im Namensraum des Projekts. */
  const gid = (key: string): string => S(ifcGuid(`${project.id}/${key}`));

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
  // ChangeAction ADDED verlangt ein LastModifiedDate (IFC4-Regel IfcOwnerHistory.CorrectChangeAction):
  // beim frischen Export ist es der Erstellungszeitpunkt.
  const now = Math.floor(Date.now() / 1000);
  const ownerHistory = w.add(
    "IFCOWNERHISTORY",
    `#${personOrg},#${app},$,${ENUM("ADDED")},${now},$,$,${now}`,
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

  // Georeferenz: Die Geometrie liegt bereits in LV95-Weltkoordinaten (s. oben), die Abbildung
  // lokal→Welt ist daher die Identität; das Koordinatensystem wird trotzdem deklariert, damit
  // Importer die Datei als EPSG:2056 erkennen (IFC4 IfcProjectedCRS + IfcMapConversion).
  if (project.geoAnchor) {
    const crs = w.add(
      "IFCPROJECTEDCRS",
      `${S("EPSG:2056")},${S("CH1903+ / LV95")},${S("CH1903+")},$,${S("Swiss Oblique Mercator")},$,#${lenUnit}`,
    );
    w.add("IFCMAPCONVERSION", `#${context},#${crs},${R(0)},${R(0)},${R(0)},${R(1)},${R(0)},${R(1)}`);
  }

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
    `${gid("project")},#${ownerHistory},${S(project.name || "Projekt")},$,$,$,$,${LIST([`#${context}`])},#${unitAssignment}`,
  );
  // RefElevation (m ü. M.): reale Datumshöhe des Standorts aus dem
  // Georeferenzierungs-Bezug (wie ArchiCADs Vermessungspunkt). Rein informativ —
  // die Geometrie wird NICHT verschoben (das Terrain trägt bereits reale Höhen).
  const refElevation = project.geoAnchor?.height;
  const siteRefElev = typeof refElevation === "number" ? R(refElevation) : "$";
  const siteId = w.add(
    "IFCSITE",
    `${gid("site")},#${ownerHistory},${S("Standort")},$,$,#${sitePlacement},$,$,${ENUM("ELEMENT")},$,$,${siteRefElev},$,$`,
  );
  const buildingId = w.add(
    "IFCBUILDING",
    `${gid("building")},#${ownerHistory},${S(project.name || "Gebäude")},$,$,#${buildingPlacement},$,$,${ENUM("ELEMENT")},$,$,$`,
  );
  w.add(
    "IFCRELAGGREGATES",
    `${gid("aggregates/site")},#${ownerHistory},$,$,#${projectId},${LIST([`#${siteId}`])}`,
  );
  w.add(
    "IFCRELAGGREGATES",
    `${gid("aggregates/building")},#${ownerHistory},$,$,#${siteId},${LIST([`#${buildingId}`])}`,
  );

  // Je "floor"-Geschoss ein IfcBuildingStorey (Elevation = baseElevation).
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  const storeyByFloorId = new Map<string, Structure>();
  const storeyEntityIds: number[] = [];
  for (const floor of floors) {
    const base = floor.baseElevation ?? 0;
    const pt = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(base)]));
    const axis = w.add("IFCAXIS2PLACEMENT3D", `#${pt},$,$`);
    const placementId = w.add("IFCLOCALPLACEMENT", `#${buildingPlacement},#${axis}`);
    const entityId = w.add(
      "IFCBUILDINGSTOREY",
      `${gid(`storey/${floor.id}`)},#${ownerHistory},${S(floor.name)},$,$,#${placementId},$,$,${ENUM("ELEMENT")},${R(base)}`,
    );
    storeyByFloorId.set(floor.id, { entityId, placementId, baseElevation: base, key: `storey/${floor.id}` });
    storeyEntityIds.push(entityId);
  }
  if (storeyEntityIds.length > 0) {
    w.add(
      "IFCRELAGGREGATES",
      `${gid("aggregates/storeys")},#${ownerHistory},$,$,#${buildingId},${LIST(storeyEntityIds.map((id) => `#${id}`))}`,
    );
  }

  /** Geschoss → Trägerstruktur (Storey), oder defensiv das Gebäude (verwaiste floorId). */
  const buildingStructure: Structure = { entityId: buildingId, placementId: buildingPlacement, baseElevation: 0, key: "building" };
  const resolveStructure = (floorId: string): Structure => storeyByFloorId.get(floorId) ?? buildingStructure;

  // Räumliche Eingliederung sammelt sich je Trägerstruktur (Storey/Building)
  // und wird am Ende in EINE IfcRelContainedInSpatialStructure je Struktur
  // gebündelt (Öffnungen NICHT — die hängen nur über RelVoidsElement an ihrer
  // Wand, wie in IFC üblich).
  const containment = new Map<Structure, number[]>();
  const addToContainment = (structure: Structure, elementId: number): void => {
    const arr = containment.get(structure);
    if (arr) arr.push(elementId);
    else containment.set(structure, [elementId]);
  };

  // Eigenschaftssätze: gleicher Inhalt ⇒ EIN IfcPropertySet + EINE IfcRelDefinesByProperties für
  // alle Bauteile (z. B. alle Wände eines Typs). GUID aus dem Inhalt — stabil, solange er gleich bleibt.
  const psets = new Map<string, { name: string; props: [string, PropValue][]; related: number[] }>();
  const addPset = (name: string, props: [string, PropValue][], elementId: number): void => {
    if (props.length === 0) return; // IfcPropertySet verlangt mindestens eine Eigenschaft
    const key = `${name}/${JSON.stringify(props)}`;
    const hit = psets.get(key);
    if (hit) hit.related.push(elementId);
    else psets.set(key, { name, props, related: [elementId] });
  };
  const identifier = (v: string): PropValue => `IFCIDENTIFIER(${S(v)})`;
  const bool = (v: boolean): PropValue => `IFCBOOLEAN(${v ? ".T." : ".F."})`;

  /** Profil (geschlossenes Polygon in Welt-XY) als IfcExtrudedAreaSolid, Unterkante `zRel` in `+Z`. */
  const emitExtrusion = (footprint: Vec2[], zRel: number, depth: number): number => {
    const closed = [...footprint, footprint[0]];
    const ptIds = closed.map((p) => w.add("IFCCARTESIANPOINT", LIST([R(p.x), R(p.y)])));
    const polylineId = w.add("IFCPOLYLINE", LIST(ptIds.map((id) => `#${id}`)));
    const profileId = w.add(
      "IFCARBITRARYCLOSEDPROFILEDEF",
      `${ENUM("AREA")},$,#${polylineId}`,
    );
    let position = identityAxis;
    if (zRel !== 0) {
      const pt = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(zRel)]));
      position = w.add("IFCAXIS2PLACEMENT3D", `#${pt},$,$`);
    }
    return w.add(
      "IFCEXTRUDEDAREASOLID",
      `#${profileId},#${position},#${extrudeDir},${R(Math.max(depth, 0.001))}`,
    );
  };

  /** Placement im Abstand `zRel` über `placementRelTo`. */
  const emitPlacement = (zRel: number, placementRelTo: number): number => {
    const elemOrigin = w.add("IFCCARTESIANPOINT", LIST([R(0), R(0), R(zRel)]));
    const elemAxis = w.add("IFCAXIS2PLACEMENT3D", `#${elemOrigin},$,$`);
    return w.add("IFCLOCALPLACEMENT", `#${placementRelTo},#${elemAxis}`);
  };

  /** SweptSolid-Körper aus Extrusionen. */
  const emitSweptShape = (solids: number[]): number => {
    const shapeRepId = w.add(
      "IFCSHAPEREPRESENTATION",
      `#${context},${S("Body")},${S("SweptSolid")},${LIST(solids.map((id) => `#${id}`))}`,
    );
    return w.add("IFCPRODUCTDEFINITIONSHAPE", `$,$,${LIST([`#${shapeRepId}`])}`);
  };

  /** Baut Profil+Extrusion+Shape+Placement für einen geschlossenen Footprint. */
  const emitBoxProduct = (
    footprint: Vec2[],
    zBottomRel: number,
    depth: number,
    placementRelTo: number,
  ): { placementId: number; shapeId: number } => {
    const shapeId = emitSweptShape([emitExtrusion(footprint, 0, depth)]);
    return { placementId: emitPlacement(zBottomRel, placementRelTo), shapeId };
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
    return { placementId: emitPlacement(0, placementRelTo), shapeId };
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
      `${guid},#${ownerHistory},${S(name)},$,$,#${placementId},#${shapeId},$,${predefinedType ?? "$"}`,
    );

  // ── Bauteiltypen mit Materialschichten ─────────────────────────────────
  // Je Wand-/Deckentyp ein IfcWallType/IfcSlabType mit IfcMaterialLayerSet (Schichten in der
  // Reihenfolge des Typs, Material = Bauteil). Die Wände/Decken erben ihn über
  // IfcRelDefinesByType. Bewusst KEIN IfcMaterialLayerSetUsage am Exemplar (s. Dateikopf).
  const materialIdByComponent = new Map<string, number>();
  const materialOf = (componentId: string): number => {
    const hit = materialIdByComponent.get(componentId);
    if (hit !== undefined) return hit;
    const name = project.components.find((c) => c.id === componentId)?.name ?? componentId;
    const id = w.add("IFCMATERIAL", `${S(name)},$,$`);
    materialIdByComponent.set(componentId, id);
    return id;
  };
  interface ElementTypeRef {
    typeId: number;
    occurrences: number[];
  }
  const elementTypes = new Map<string, ElementTypeRef>();
  const typeFor = (
    ifcType: "IFCWALLTYPE" | "IFCSLABTYPE" | "IFCROOFTYPE",
    predefined: string,
    t: { id: string; name: string; layers: { componentId: string; thickness: number }[] },
  ): ElementTypeRef => {
    const key = `type/${ifcType}/${t.id}`;
    const hit = elementTypes.get(key);
    if (hit) return hit;
    const layerIds = t.layers.map((l) =>
      w.add("IFCMATERIALLAYER", `#${materialOf(l.componentId)},${R(Math.max(0, Number.isFinite(l.thickness) ? l.thickness : 0))},$,$,$,$,$`),
    );
    const typeId = w.add(
      ifcType,
      `${gid(key)},#${ownerHistory},${S(t.name)},$,$,$,$,$,$,${ENUM(predefined)}`,
    );
    if (layerIds.length > 0) {
      const setId = w.add("IFCMATERIALLAYERSET", `${LIST(layerIds.map((id) => `#${id}`))},${S(t.name)},$`);
      w.add(
        "IFCRELASSOCIATESMATERIAL",
        `${gid(`${key}/material`)},#${ownerHistory},$,$,${LIST([`#${typeId}`])},#${setId}`,
      );
    }
    const ref = { typeId, occurrences: [] };
    elementTypes.set(key, ref);
    return ref;
  };

  // ── Wände ──────────────────────────────────────────────────────────────
  // Die Wand-Schicht-Bänder kommen aus DEMSELBEN geflachten Modell wie STL/OBJ
  // (`pickGeometry`, Joins/Gehrungen + Öffnungs-`holes` bereits aufgelöst).
  //
  // Extrusions-Weg (s. Dateikopf): je Band ein Rechteck-Profil (Achse ± halbe Banddicke)
  // von der Band-UK über die Bandhöhe; die Öffnungen schneidet der Viewer über RelVoids.
  //
  // Mesh-Weg: alle Bänder einer Wand-Id zu EINEM Face-Set. IFC-Koordinaten: das
  // Mesh liegt in Welt (Modell-x, Höhe, Modell-y) mit Y-up → IFC (x, y, z=Höhe)
  // mit Z-up, also (mx, mz, my); Z relativ zur Geschoss-UK, damit die Storey-
  // Placement-Elevation nicht doppelt zählt.
  // WICHTIG — WICKLUNG: der Achsen-Swap (x,y,z)→(x,z,y) ist eine REFLEXION
  // (Determinante −1) und KEHRT die Dreiecks-Wicklung UM → aus aussen orientierten
  // würden innen orientierte Normalen, der Viewer cullt dann die Vorderseiten und
  // die Wand wirkt HOHL/offen. Deshalb wird beim Swap die Wicklung jedes Dreiecks
  // umgedreht (i0,i2,i1). Watertightness (isWatertight) misst das anschliessend am
  // fertigen IFC-Mesh → treibt das Closed-Flag des Face-Sets.
  const bandsByWallId = new Map<string, RWall[]>();
  const allBands = pickGeometry(project).walls;
  for (const band of allBands) {
    const list = bandsByWallId.get(band.wallId);
    if (list) list.push(band);
    else bandsByWallId.set(band.wallId, [band]);
  }
  const cutoutsOf = (wall: Wall): WallCutout[] => {
    const out: WallCutout[] = [];
    for (const opening of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, opening);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, opening);
      out.push({ opening, from: iv.from, to: iv.to, zBottom: v.zBottom, zTop: v.zTop });
    }
    return out;
  };
  const meshWalls: { wall: Wall; bands: RWall[] }[] = [];
  const wallRefById = new Map<string, WallRef>();
  const cutoutsByWallId = new Map<string, WallCutout[]>();
  const emitWallEntity = (wall: Wall, structure: Structure, placementId: number, shapeId: number, bands: RWall[]): void => {
    let name = wall.id;
    let wallType: ElementTypeRef | null = null;
    let reference: string | null = null;
    try {
      const wt = getWallType(project, wall);
      name = wt.name;
      reference = wt.name;
      wallType = typeFor("IFCWALLTYPE", "STANDARD", wt);
    } catch {
      /* verwaister Wandtyp — Roh-ID als Name, kein Typ */
    }
    const entityId = emitBuildingElement("IFCWALL", gid(`wall/${wall.id}`), name, placementId, shapeId, null);
    wallType?.occurrences.push(entityId);
    addToContainment(structure, entityId);
    if (reference !== null) addPset("Pset_WallCommon", [["Reference", identifier(reference)]], entityId);
    // Querausdehnung aller Bänder (für den Öffnungskörper).
    const u = normalize(sub(wall.end, wall.start));
    const n = leftNormal(u);
    let nLo = Infinity;
    let nHi = -Infinity;
    for (const b of bands) {
      const off = dot({ x: b.start[0] - wall.start.x, y: b.start[1] - wall.start.y }, n);
      nLo = Math.min(nLo, off - b.thickness / 2);
      nHi = Math.max(nHi, off + b.thickness / 2);
    }
    wallRefById.set(wall.id, { entityId, placementId, nLo, nHi });
  };
  for (const wall of project.walls ?? []) {
    const bands = (bandsByWallId.get(wall.id) ?? []).filter(
      (b) => Math.hypot(b.end[0] - b.start[0], b.end[1] - b.start[1]) > 1e-9 && b.height > 1e-9 && b.thickness > 1e-9,
    );
    if (bands.length === 0) continue; // degenerierte Wand / keine Geometrie
    const cutouts = cutoutsOf(wall);
    cutoutsByWallId.set(wall.id, cutouts);
    if (!bandsMatchOpenings(wall, bands, cutouts)) {
      meshWalls.push({ wall, bands: bandsByWallId.get(wall.id)! });
      continue;
    }
    const structure = resolveStructure(wall.floorId);
    const solids = bands.map((b) => {
      const s: Vec2 = { x: b.start[0], y: b.start[1] };
      const e: Vec2 = { x: b.end[0], y: b.end[1] };
      const n = leftNormal(normalize(sub(e, s)));
      const h = b.thickness / 2;
      const rect = [addScaled(s, n, -h), addScaled(e, n, -h), addScaled(e, n, h), addScaled(s, n, h)];
      return emitExtrusion(rect, b.baseElevation - structure.baseElevation, b.height);
    });
    emitWallEntity(wall, structure, emitPlacement(0, structure.placementId), emitSweptShape(solids), bands);
  }
  // Mesh-Weg: Loch-Ausschnitte aller betroffenen Bänder in EINEM Kern-Aufruf.
  const meshBands = meshWalls.flatMap((m) => m.bands);
  const cutOf = new Map<RWall, CutMesh>();
  wallCutMeshes(meshBands).forEach((m, i) => cutOf.set(meshBands[i], m));
  for (const { wall, bands } of meshWalls) {
    const structure = resolveStructure(wall.floorId);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const band of bands) {
      const cut = cutOf.get(band);
      if (!cut) continue;
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
    emitWallEntity(wall, structure, placementId, shapeId, bands);
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
    let slabType: ElementTypeRef | null = null;
    let reference: string | null = null;
    try {
      const ct = getCeilingType(project, ceiling);
      name = ct.name;
      reference = ct.name;
      slabType = typeFor("IFCSLABTYPE", "FLOOR", ct);
    } catch {
      /* verwaister Deckentyp — Roh-ID als Name, kein Typ */
    }
    const entityId = emitBuildingElement(
      "IFCSLAB",
      gid(`slab/${ceiling.id}`),
      name,
      placementId,
      shapeId,
      ENUM("FLOOR"),
    );
    slabType?.occurrences.push(entityId);
    addToContainment(structure, entityId);
    if (reference !== null) addPset("Pset_SlabCommon", [["Reference", identifier(reference)]], entityId);
  }

  // ── Öffnungen: IfcOpeningElement in der Wand, IfcDoor/IfcWindow darin ───
  // Der Öffnungskörper ist ein Quader über das Achs-Intervall und die Höhe, wie sie das 3D
  // stanzt (`openingInterval`/`openingVerticalExtent`), quer über alle Bänder der Wand plus
  // OPENING_OVERSHOOT. Die Füllung (Tür/Fenster) sitzt im Öffnungs-Placement, über die
  // Banddicke, ohne Blatt-/Rahmendetail.
  for (const wall of project.walls ?? []) {
    const host = wallRefById.get(wall.id);
    if (!host) continue; // Wirtswand übersprungen (degeneriert)
    const structure = resolveStructure(wall.floorId);
    for (const c of cutoutsByWallId.get(wall.id) ?? []) {
      const { opening } = c;
      const depth = c.zTop - c.zBottom;
      if (!(depth > 1e-6)) continue;
      const voidRect = axisRect(wall, c.from, c.to, host.nLo - OPENING_OVERSHOOT, host.nHi + OPENING_OVERSHOOT);
      const { placementId: openingPlacement, shapeId: openingShape } = emitBoxProduct(
        voidRect,
        c.zBottom - structure.baseElevation,
        depth,
        host.placementId,
      );
      const openingEntityId = w.add(
        "IFCOPENINGELEMENT",
        `${gid(`opening/${opening.id}`)},#${ownerHistory},${S(opening.kind === "door" ? "Türöffnung" : "Fensteröffnung")},$,$,#${openingPlacement},#${openingShape},$,${ENUM("OPENING")}`,
      );
      w.add(
        "IFCRELVOIDSELEMENT",
        `${gid(`voids/${opening.id}`)},#${ownerHistory},$,$,#${host.entityId},#${openingEntityId}`,
      );

      const { placementId: fillPlacement, shapeId: fillShape } = emitBoxProduct(
        axisRect(wall, c.from, c.to, host.nLo, host.nHi),
        0,
        depth,
        openingPlacement,
      );
      const fillName = openingLabel(opening);
      const isDoor = opening.kind === "door";
      const fillEntityId = w.add(
        isDoor ? "IFCDOOR" : "IFCWINDOW",
        `${gid(`fill/${opening.id}`)},#${ownerHistory},${S(fillName)},$,$,#${fillPlacement},#${fillShape},$,${R(depth)},${R(c.to - c.from)},${ENUM(isDoor ? "DOOR" : "WINDOW")},$,$`,
      );
      w.add(
        "IFCRELFILLSELEMENT",
        `${gid(`fills/${opening.id}`)},#${ownerHistory},$,$,#${openingEntityId},#${fillEntityId}`,
      );
      addToContainment(structure, fillEntityId);

      const props: [string, PropValue][] = [];
      if (isDoor) {
        const dt = getDoorType(project, opening);
        if (dt) props.push(["Reference", identifier(dt.name)]);
        const ratio = dt?.glazingRatio;
        if (dt?.leafStyle === "glas" && typeof ratio === "number" && ratio > 0 && ratio <= 1) {
          props.push(["GlazingAreaFraction", `IFCPOSITIVERATIOMEASURE(${R(ratio)})`]);
        }
        addPset("Pset_DoorCommon", props, fillEntityId);
      } else {
        const wt = getWindowType(project, opening);
        if (wt) props.push(["Reference", identifier(wt.name)]);
        addPset("Pset_WindowCommon", props, fillEntityId);
      }
    }
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
      gid(`stair/${stair.id}`),
      "Treppe",
      placementId,
      shapeId,
      predefinedType,
    );
    addToContainment(structure, entityId);
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
      gid(`extrusion/${solid.id}`),
      "Extrusion",
      placementId,
      shapeId,
      null,
    );
    addToContainment(structure, entityId);
  }

  // ── Räume → IfcSpace ───────────────────────────────────────────────────
  // Je Raum ein IfcSpace (Name = Raumnummer, LongName = Raumname), als Extrusion der lichten
  // Innenkontur über die lichte Geschosshöhe. Räume sind räumliche Elemente: sie werden im
  // Geschoss AGGREGIERT (IfcRelAggregates), nicht enthalten. Dazu Basismengen
  // (Qto_SpaceBaseQuantities), die SIA-416-Kategorie als Eigenschaft und Pset_SpaceCommon
  // (AGF = Aussengeschossfläche ⇒ aussen, alles andere innen).
  const spacesByStructure = new Map<Structure, number[]>();
  for (const room of project.rooms ?? []) {
    if (room.boundary.length < 3) continue;
    const structure = resolveStructure(room.floorId);
    const floor = floors.find((f) => f.id === room.floorId);
    const height = floor?.floorHeight && floor.floorHeight > 0 ? floor.floorHeight : 2.5;
    const { placementId, shapeId } = emitBoxProduct(room.boundary, 0, height, structure.placementId);
    const external = room.siaCategory === "AGF";
    const spaceId = w.add(
      "IFCSPACE",
      `${gid(`space/${room.id}`)},#${ownerHistory},${S(room.stamp?.number || room.id)},$,$,#${placementId},#${shapeId},${S(room.name)},${ENUM("ELEMENT")},${ENUM(external ? "EXTERNAL" : "INTERNAL")},$`,
    );
    const list = spacesByStructure.get(structure);
    if (list) list.push(spaceId);
    else spacesByStructure.set(structure, [spaceId]);

    const area = evaluateRoom(room.boundary, room.siaCategory);
    const qNet = w.add("IFCQUANTITYAREA", `${S("NetFloorArea")},$,$,${R(area.netArea)},$`);
    const qGross = w.add("IFCQUANTITYAREA", `${S("GrossFloorArea")},$,$,${R(area.grossArea)},$`);
    const qHeight = w.add("IFCQUANTITYLENGTH", `${S("Height")},$,$,${R(height)},$`);
    const qto = w.add(
      "IFCELEMENTQUANTITY",
      `${gid(`space/${room.id}/qto`)},#${ownerHistory},${S("Qto_SpaceBaseQuantities")},$,$,${LIST([`#${qNet}`, `#${qGross}`, `#${qHeight}`])}`,
    );
    w.add(
      "IFCRELDEFINESBYPROPERTIES",
      `${gid(`space/${room.id}/qto-rel`)},#${ownerHistory},$,$,${LIST([`#${spaceId}`])},#${qto}`,
    );
    const sia = w.add("IFCPROPERTYSINGLEVALUE", `${S("SIA416")},$,IFCLABEL(${S(room.siaCategory)}),$`);
    const pset = w.add(
      "IFCPROPERTYSET",
      `${gid(`space/${room.id}/pset`)},#${ownerHistory},${S("CH_Raum")},$,${LIST([`#${sia}`])}`,
    );
    w.add(
      "IFCRELDEFINESBYPROPERTIES",
      `${gid(`space/${room.id}/pset-rel`)},#${ownerHistory},$,$,${LIST([`#${spaceId}`])},#${pset}`,
    );
    const common: [string, PropValue][] = [];
    if (room.stamp?.number) common.push(["Reference", identifier(room.stamp.number)]);
    common.push(["IsExternal", bool(external)]);
    addPset("Pset_SpaceCommon", common, spaceId);
  }
  for (const [structure, spaceIds] of spacesByStructure) {
    w.add(
      "IFCRELAGGREGATES",
      `${gid(`aggregates/spaces/${structure.key}`)},#${ownerHistory},$,$,#${structure.entityId},${LIST(spaceIds.map((id) => `#${id}`))}`,
    );
  }

  // ── Dächer → IfcRoof ───────────────────────────────────────────────────
  // Dieselben geschlossenen Schicht-Meshes wie das 3D (`emitRoofs`: Dachflächen je Schicht,
  // an First/Grat gehrt), zu EINEM Face-Set je Dach vereint. Modell-Koordinaten sind bereits
  // Z-oben (kein Achsentausch wie bei den Wänden); die Wicklung wird so gewählt, dass das Volumen
  // positiv ist — nur dann ist das Face-Set als geschlossen markiert.
  const ROOF_PREDEFINED: Record<string, string> = {
    flach: "FLAT_ROOF",
    pult: "SHED_ROOF",
    sattel: "GABLE_ROOF",
    walm: "HIP_ROOF",
    mansarde: "MANSARD_ROOF",
    zelt: "HIPPED_GABLE_ROOF",
  };
  for (const roof of project.roofs ?? []) {
    const structure = resolveStructure(roof.floorId);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const mesh of emitRoofs({ ...project, roofs: [roof] })) {
      const base = positions.length / 3;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        positions.push(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2] - structure.baseElevation);
      }
      for (const ix of mesh.indices) indices.push(base + ix);
    }
    if (indices.length === 0) continue;
    let closed = isWatertight({ positions, indices });
    if (!closed) {
      const flipped: number[] = [];
      for (let i = 0; i < indices.length; i += 3) flipped.push(indices[i], indices[i + 2], indices[i + 1]);
      if (isWatertight({ positions, indices: flipped })) {
        indices.splice(0, indices.length, ...flipped);
        closed = true;
      }
    }
    const { placementId, shapeId } = emitTriangulatedProduct(positions, indices, structure.placementId, closed);
    const predefined = ROOF_PREDEFINED[roof.shape] ?? "NOTDEFINED";
    const roofType = roof.roofTypeId ? (project.roofTypes ?? []).find((t) => t.id === roof.roofTypeId) : undefined;
    const entityId = emitBuildingElement("IFCROOF", gid(`roof/${roof.id}`), roofType?.name ?? "Dach", placementId, shapeId, ENUM(predefined));
    if (roofType) typeFor("IFCROOFTYPE", predefined, roofType).occurrences.push(entityId);
    addToContainment(structure, entityId);
    // Ein Dach ist Gebäudehülle: IsExternal folgt aus der Bauteilart, nicht aus einer Annahme.
    const props: [string, PropValue][] = [];
    if (roofType) props.push(["Reference", identifier(roofType.name)]);
    props.push(["IsExternal", bool(true)]);
    addPset("Pset_RoofCommon", props, entityId);
  }

  // ── Stützen → IfcColumn (Profil-Extrusion, Material = Bauteil) ──────────
  const materialAssoc = new Map<string, number[]>();
  for (const col of project.columns ?? []) {
    const footprint = columnFootprint(col);
    if (footprint.length < 3) continue;
    const { zBottom, zTop } = columnVerticalExtent(project, col);
    if (!(zTop > zBottom)) continue;
    const structure = resolveStructure(col.floorId);
    const { placementId, shapeId } = emitBoxProduct(footprint, zBottom - structure.baseElevation, zTop - zBottom, structure.placementId);
    const label = columnLabel(col);
    const entityId = emitBuildingElement("IFCCOLUMN", gid(`column/${col.id}`), label, placementId, shapeId, ENUM("COLUMN"));
    addToContainment(structure, entityId);
    addPset("Pset_ColumnCommon", [["Reference", identifier(label)]], entityId);
    if (col.componentId) {
      const list = materialAssoc.get(col.componentId);
      if (list) list.push(entityId);
      else materialAssoc.set(col.componentId, [entityId]);
    }
  }
  for (const [componentId, ids] of materialAssoc) {
    w.add(
      "IFCRELASSOCIATESMATERIAL",
      `${gid(`material/${componentId}/columns`)},#${ownerHistory},$,$,${LIST(ids.map((id) => `#${id}`))},#${materialOf(componentId)}`,
    );
  }

  // ── Typ-Zuordnung (je Bauteiltyp eine IfcRelDefinesByType) ─────────────
  for (const [key, ref] of elementTypes) {
    if (ref.occurrences.length === 0) continue;
    w.add(
      "IFCRELDEFINESBYTYPE",
      `${gid(`${key}/occurrences`)},#${ownerHistory},$,$,${LIST(ref.occurrences.map((id) => `#${id}`))},#${ref.typeId}`,
    );
  }

  // ── Eigenschaftssätze (Pset_*Common) ───────────────────────────────────
  for (const [key, ps] of psets) {
    const propIds = ps.props.map(([name, value]) => w.add("IFCPROPERTYSINGLEVALUE", `${S(name)},$,${value},$`));
    const psetId = w.add(
      "IFCPROPERTYSET",
      `${gid(`pset/${key}`)},#${ownerHistory},${S(ps.name)},$,${LIST(propIds.map((id) => `#${id}`))}`,
    );
    w.add(
      "IFCRELDEFINESBYPROPERTIES",
      `${gid(`pset/${key}/rel`)},#${ownerHistory},$,$,${LIST(ps.related.map((id) => `#${id}`))},#${psetId}`,
    );
  }

  // ── Räumliche Eingliederung (gebündelt je Trägerstruktur) ──────────────
  for (const [structure, elementIds] of containment) {
    w.add(
      "IFCRELCONTAINEDINSPATIALSTRUCTURE",
      `${gid(`contains/${structure.key}`)},#${ownerHistory},$,$,${LIST(elementIds.map((id) => `#${id}`))},#${structure.entityId}`,
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
