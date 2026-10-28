// IFC-Export (IFC4 oder IFC2x3, STEP Physical File / ISO-10303-21) des semantischen Modells.
//
// Schema ([B5], 28.10.): `options.schema` = "IFC4" (Standard) oder "IFC2X3" (Coordination View 2.0).
// TS sammelt in beiden Fällen dasselbe; nur das META trägt die Wahl (und die WGS84-Breite/Länge des
// Bezugspunkts für `IfcSite.RefLatitude/RefLongitude`), die Entitäten des Schemas schreibt Rust.
//
// Seit [B5] (28.10.) schreibt Rust die Datei (`src-tauri/fileio/src/ifc_export.rs`, Format-Modul
// pkgFileIo): TS sammelt hier aus Projekt und Plan die Bauteile samt fertig gerechneter Geometrie
// (Wand-Bänder, Öffnungen, Dach-Meshes, Raumflächen) als flachen Puffer, Rust vergibt die Nummern und
// baut Entitäten, GUIDs, Typen mit Materialschichten, Psets und Beziehungen. Verlangt das geladene
// Format-Modul (`await loadFileio()`, wie `buildPlanDxf`). Der Download passiert im App-Layer.
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
//     Wand (IfcRelVoidsElement), darin IfcDoor/IfcWindow (IfcRelFillsElement) aus getrennten Körpern
//     ([B5], 28.10., Parameter `ifcOpenings.ts`, Rechnung `ifc_openings.rs`): Rahmen/Zarge + Türblatt bzw. Glas je Flügel, mit Farbe/
//     Transparenz je Rolle; OperationType (Tür: Blattzahl, Scharnierseite, Schiebe) und
//     PartitioningType (Fenster: Flügelzahl). Masse aus dem Modell (Rahmenbreite/-tiefe, Einzug,
//     Verglasung, Glasanteil, Oberlicht), sonst die Konstanten des 3D. Ohne Sprossen, Fensterbank,
//     Schwelle; reine Wandöffnung ohne Körper.
//   • Extrusion → IfcBuildingElementProxy aus points+height.
//   • Dach      → IfcRoof (Schicht-Meshes wie im 3D), Dachtyp → IfcRoofType mit Schichten.
//   • Stütze    → IfcColumn (Profil-Extrusion), Bauteil → IfcMaterial.
//   • Raum      → IfcSpace (im Geschoss aggregiert) mit Qto_SpaceBaseQuantities und SIA-416-Kategorie.
//   • Treppe    → IfcStair ohne eigene Darstellung, zusammengefasst (IfcRelAggregates) aus Läufen
//     (IfcStairFlight: Prismen der Tritte bzw. glatte Ortbeton-Laufplatte als Netz, Steigungs-/Auftrittsmasse),
//     Podest (IfcSlab LANDING, nur "L") und Handlauf/Pfosten (IfcRailing HANDRAIL, wo das 3D sie zeigt) —
//     dieselben Ableitungen wie das 3D (`ifcStairs.ts`). Ohne Teile bleibt der Fussabdruck-Quader
//     (`stairFootprint()`).
//
//   Material-Schichten: je Wand-/Deckentyp ein IfcWallType/IfcSlabType mit
//   IfcMaterialLayerSet, die Exemplare erben ihn über IfcRelDefinesByType. Extrusions-Wände
//   ([B5], 28.10.) tragen zusätzlich eine „Axis"-Darstellung (IfcPolyline entlang der Wandachse)
//   und eine IfcMaterialLayerSetUsage (AXIS2, POSITIVE, Offset = Abstand der Aussenschicht von der
//   Achse), damit Revit/ArchiCAD die Schichten der Achse zuordnen: das Wand-Placement sitzt am
//   Wandanfang, X = Achse, Y = linke Normale (Rust rechnet die Welt-Profile ins Wandsystem). Mesh-
//   Wände (schräge Oberkante, Laibungs-Rücksprung) haben weder Achse noch Usage.
//
//   Basismengen ([B5], 28.10.): Qto_WallBaseQuantities (Length, Width, Height, GrossSideArea, NetSideArea,
//   GrossVolume, NetVolume), Qto_SlabBaseQuantities, Qto_RoofBaseQuantities, Qto_ColumnBaseQuantities,
//   Qto_DoorBaseQuantities/Qto_WindowBaseQuantities (Width, Height, Perimeter, Area), Qto_StairFlightBaseQuantities
//   und Qto_RailingBaseQuantities — aus der Geometrie (`ifcQuantities.ts`), Netto = abzüglich Öffnungen;
//   Rust schreibt je Bauteil einen IfcElementQuantity. Deckenaussparungen sind echte Löcher im Profil.
//
//   Eigenschaften ([B5]): Pset_WallCommon/SlabCommon/RoofCommon/ColumnCommon/DoorCommon/
//   WindowCommon/SpaceCommon nur mit Werten, die das Modell hergibt (Reference = Typname,
//   IsExternal beim Dach und bei SIA-416-AGF-Räumen, Glasanteil der Glastür). Kein U-Wert,
//   keine Tragfunktion: dafür hat das Modell keine Felder.
//
//   Schweizer Praxis ([B5], 28.10.):
//   • Zonen: je vorkommender SIA-416-Kategorie (HNF, NNF, VF, FF, KGF, AGF) eine IfcZone mit
//     IfcRelAssignsToGroup der IfcSpaces, Eigenschaft `CH_Zone.SIA416` und Summe der Nettoflächen
//     (`CH_Qto_SIA416.NetFloorArea`). Immer dabei, sobald Räume da sind.
//   • Geschoss-Kennwerte: je Geschoss mit Räumen `Qto_BuildingStoreyBaseQuantities` (GrossFloorArea = GF,
//     NetFloorArea = NGF nach SIA 416) und `CH_Qto_SIA416` mit allen Blatt-/Summenflächen (HNF … GF).
//   • Klassifikation (Option, `ifcClassification.ts`): eBKP-H-Hauptgruppen je Bauteilart und/oder die
//     Ebene des Modells als System „Dossier-Ebenen" — IfcClassification + IfcClassificationReference +
//     IfcRelAssociatesClassification.
//   • Achsraster: nicht exportiert — das Modell führt keine Raster-Ressource (nur die Regel „grid" der
//     parametrischen Wände mit festem Abstand).
//
//   GUIDs ([B5]/[10]): deterministisch aus `<Projekt-id>/<Art>/<id>[/<Zusatz>]` über einen
//   128-Bit-Hash + Standard-IFC-GUID-Kompression (Zeichensatz 0-9,A-Z,a-z,_,$) — zweimal
//   exportieren gibt dieselben GlobalIds, BIM-Koordination (Solibri, BIMcollab) erkennt die
//   Bauteile wieder. Abgeleitete Entitäten (Rels, Typen, Psets) hängen an Element-/Geschoss-/
//   Typ-ids, nie an STEP-Nummern. Der Hash lebt in Rust (`ifc_guid`).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheit: METER.

import type { Opening, Project, Stair, Vec2, Wall } from "../model/types";
import type { StairParts } from "./ifcStairs";
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
import { ceilingVerticalExtent, columnVerticalExtent, stairVerticalExtent } from "../model/wall";
import { pickGeometry } from "../plan/toWalls3d";
import type { RWall } from "../plan/toWalls3d";
import { isWatertight, wallCutMeshes, type CutMesh } from "../plan/wallMeshCut";
import { evaluateRoom } from "../geometry/roomArea";
import { columnFootprint } from "../geometry/column";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { fileio } from "../engine/fileioWasm";
import { lv95ToWgs84 } from "../io/lv95";
import { fillParams, type FillParams } from "./ifcOpenings";
import { stairParts } from "./ifcStairs";
import {
  columnQuantities,
  holeVolume,
  meshVolume,
  openingQuantities,
  roofQuantities,
  slabQuantities,
  wallQuantities,
  type Qty,
} from "./ifcQuantities";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { SIA_CATEGORIES, balance, siaLabel, type SiaCategory } from "../geometry/roomArea";
import { emitRoofs } from "./model3dParts";
import {
  EBKPH_SYSTEM,
  LAYER_SYSTEM,
  ebkphGroup,
  layerClassification,
  type ClassificationSystem,
  type ClassifiedKind,
  type IfcExportOptions,
  type IfcSchema,
} from "./ifcClassification";

export type { IfcExportOptions, IfcSchema } from "./ifcClassification";

/** WGS84 des LV95-Bezugspunkts (swisstopo-Näherung); `null` ohne Bezug oder bei unbrauchbaren Zahlen. */
function refLatLon(lv95: { e: number; n: number } | undefined): { lat: number; lon: number } | null {
  if (!lv95 || !Number.isFinite(lv95.e) || !Number.isFinite(lv95.n)) return null;
  const { lat, lon } = lv95ToWgs84(lv95.e, lv95.n);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Deterministische 22-stellige IFC-GUID aus einem Namen (Rust, `ifc_export.rs::ifc_guid`). */
export function ifcGuid(name: string): string {
  return fileio().ifc_guid(name);
}

/** STEP-String-Literal mit Apostrophen, Nicht-ASCII als `\X2\`/`\X4\` (Rust, `ifc_export.rs::ifc_string`). */
export function ifcString(s: string): string {
  return fileio().ifc_string(s);
}

// ── Flacher Puffer (Gegenstück zu src-tauri/fileio/src/ifc_export.rs, dort die Kodierung) ─────

const FLAT_VERSION = 4;
const REC_WALL_SOLIDS = 1;
const REC_WALL_MESH = 2;
const REC_CEILING = 3;
const REC_OPENING = 4;
const REC_STAIR = 5;
const REC_EXTRUSION = 6;
const REC_SPACE = 7;
const REC_END_SPACES = 8;
const REC_ROOF = 9;
const REC_COLUMN = 10;
const REC_END_COLUMNS = 11;
const REC_CLASSIFICATION = 12;
const REC_ZONE = 13;
const REC_ATTACH = 14;

/** Typart in der flachen Kodierung (0 Wand, 1 Decke, 2 Dach). */
type TypeKind = 0 | 1 | 2;

interface TypeRefIn {
  kind: TypeKind;
  id: string;
  name: string;
  predefined: string;
  layers: { componentId: string; componentName: string; thickness: number }[];
}

/**
 * Pset-Eigenschaft: Kennung, Art (IfcIdentifier, IfcBoolean, IfcPositiveRatioMeasure) und Wert; in einem Satz
 * `Qto_…` Mengen (Länge, Fläche, Volumen) — Rust schreibt daraus je Bauteil einen IfcElementQuantity.
 */
type PropIn =
  | { name: string; ident: string }
  | { name: string; bool: boolean }
  | { name: string; ratio: number }
  | { name: string; length: number }
  | { name: string; area: number }
  | { name: string; volume: number };
interface PsetIn {
  name: string;
  props: PropIn[];
}

/** Sammelt die Bauteile als Zahlenpuffer + Zeichenkettenliste. */
class FlatIfc {
  private nums: number[] = [FLAT_VERSION];
  private strings: string[] = [];

  private str(s: string): number {
    this.strings.push(s.replace(/\0/g, ""));
    return this.strings.length - 1;
  }
  private optStr(s: string | null): number {
    return s === null ? -1 : this.str(s);
  }
  private pts(pts: readonly Vec2[]): void {
    this.nums.push(pts.length);
    for (const p of pts) this.nums.push(p.x, p.y);
  }
  private mesh(positions: readonly number[], indices: readonly number[], closed: boolean): void {
    this.nums.push(positions.length / 3);
    for (let i = 0; i < positions.length; i++) this.nums.push(positions[i]);
    this.nums.push(indices.length / 3);
    for (let i = 0; i < indices.length; i++) this.nums.push(indices[i]);
    this.nums.push(closed ? 1 : 0);
  }
  private typeRef(t: TypeRefIn | null): void {
    if (!t) {
      this.nums.push(0);
      return;
    }
    this.nums.push(1, t.kind, this.str(t.id), this.str(t.name), this.str(t.predefined), t.layers.length);
    for (const l of t.layers) this.nums.push(this.str(l.componentId), this.str(l.componentName), l.thickness);
  }
  private psets(list: readonly PsetIn[]): void {
    this.nums.push(list.length);
    for (const ps of list) {
      this.nums.push(this.str(ps.name), ps.props.length);
      for (const p of ps.props) {
        if ("ident" in p) this.nums.push(this.str(p.name), 0, this.str(p.ident));
        else if ("bool" in p) this.nums.push(this.str(p.name), 1, p.bool ? 1 : 0);
        else if ("ratio" in p) this.nums.push(this.str(p.name), 2, p.ratio);
        else if ("length" in p) this.nums.push(this.str(p.name), 3, p.length);
        else if ("area" in p) this.nums.push(this.str(p.name), 4, p.area);
        else this.nums.push(this.str(p.name), 5, p.volume);
      }
    }
  }

  meta(m: {
    projectId: string;
    projectName: string;
    now: number;
    iso: string;
    hasGeo: boolean;
    refElevation: number | null;
    /** WGS84-Grad des Bezugspunkts (nur IFC2x3-Site); `null` = keine. */
    refLatLon: { lat: number; lon: number } | null;
    schema: IfcSchema;
    storeys: { id: string; name: string; base: number }[];
  }): void {
    this.nums.push(
      this.str(m.projectId),
      this.str(m.projectName),
      m.now,
      this.str(m.iso),
      m.hasGeo ? 1 : 0,
      m.refElevation ?? Number.NaN,
      m.refLatLon?.lat ?? Number.NaN,
      m.refLatLon?.lon ?? Number.NaN,
      m.schema === "IFC2X3" ? 1 : 0,
      m.storeys.length,
    );
    for (const s of m.storeys) this.nums.push(this.str(s.id), this.str(s.name), s.base);
  }

  /**
   * Extrusions-Wand. `frame`: Wandanfang, Achsrichtung (Einheitsvektor), Länge und — wenn die Schichten
   * des Typs genau den Wandquerschnitt füllen — der Abstand `offset` der ersten Schicht von der
   * Wandachse entlang der linken Normalen (→ IfcMaterialLayerSetUsage).
   */
  wallSolids(
    structure: number,
    id: string,
    name: string,
    ty: TypeRefIn | null,
    psets: PsetIn[],
    frame: { origin: Vec2; u: Vec2; length: number; offset: number | null },
    solids: { pts: Vec2[]; zRel: number; depth: number }[],
  ): void {
    this.nums.push(REC_WALL_SOLIDS, structure, this.str(id), this.str(name));
    this.typeRef(ty);
    this.psets(psets);
    this.nums.push(1, frame.origin.x, frame.origin.y, frame.u.x, frame.u.y, frame.length, frame.offset === null ? 0 : 1, frame.offset ?? 0);
    this.nums.push(solids.length);
    for (const s of solids) {
      this.pts(s.pts);
      this.nums.push(s.zRel, s.depth);
    }
  }

  wallMesh(structure: number, id: string, name: string, ty: TypeRefIn | null, psets: PsetIn[], positions: number[], indices: number[], closed: boolean): void {
    this.nums.push(REC_WALL_MESH, structure, this.str(id), this.str(name));
    this.typeRef(ty);
    this.psets(psets);
    this.mesh(positions, indices, closed);
  }

  ceiling(structure: number, id: string, name: string, ty: TypeRefIn | null, psets: PsetIn[], outline: Vec2[], inner: readonly (readonly Vec2[])[], zRel: number, depth: number): void {
    this.nums.push(REC_CEILING, structure, this.str(id), this.str(name));
    this.typeRef(ty);
    this.psets(psets);
    this.pts(outline);
    this.nums.push(inner.length);
    for (const ring of inner) this.pts(ring);
    this.nums.push(zRel, depth);
  }

  opening(o: {
    wallId: string;
    structure: number;
    openingId: string;
    isDoor: boolean;
    fillName: string;
    voidRect: Vec2[];
    voidZRel: number;
    depth: number;
    width: number;
    fill: FillParams;
    psets: PsetIn[];
  }): void {
    this.nums.push(REC_OPENING, this.str(o.wallId), o.structure, this.str(o.openingId), o.isDoor ? 1 : 0, this.str(o.fillName));
    this.pts(o.voidRect);
    this.nums.push(o.voidZRel, o.depth, o.width);
    // FILL (Kopf von `ifc_export.rs`): Parameter, die Rust zu Körpern und Ausführung rechnet.
    const f = o.fill;
    const opt = (v: number | null | undefined) => this.nums.push(v == null ? 0 : 1, v ?? 0);
    this.nums.push(f.wallStart.x, f.wallStart.y, f.wallEnd.x, f.wallEnd.y, f.from, f.to, f.zBottom, f.zTop, f.nLo, f.nHi);
    opt(f.frameDepth);
    opt(f.inset);
    this.nums.push(f.insetOutside ? 1 : 0);
    opt(f.frameWidth);
    this.nums.push(f.wingCount, f.panes, f.sashes.length);
    for (const s of f.sashes) {
      this.nums.push(s.post ? 1 : 0);
      opt(s.postWidth);
      this.nums.push(s.fixed ? 1 : 0);
      opt(s.width);
    }
    this.nums.push(f.doorKind, f.leafCount, f.swingSign, f.dirSign, f.hingeAtStart ? 1 : 0, f.transomHeight, f.glazed ? 1 : 0);
    opt(f.glazingRatio);
    this.psets(o.psets);
  }

  stair(structure: number, id: string, predefined: string, footprint: Vec2[], zRel: number, depth: number, parts: StairParts): void {
    this.nums.push(REC_STAIR, structure, this.str(id), this.str(predefined));
    this.pts(footprint);
    this.nums.push(zRel, depth);
    this.psets([]);
    this.nums.push(parts.flights.length);
    for (const f of parts.flights) {
      this.nums.push(this.str(f.name), f.risers, f.treads, f.riserHeight, f.treadLength, this.str(f.predefined));
      this.psets(qto("Qto_StairFlightBaseQuantities", f.quantities));
      if (f.mesh) {
        this.nums.push(1);
        this.mesh(f.mesh.positions, f.mesh.indices, false);
      } else {
        const solids = f.solids ?? [];
        this.nums.push(0, solids.length);
        for (const s of solids) {
          this.pts(s.pts);
          this.nums.push(s.zRel, s.depth);
        }
      }
    }
    if (parts.landing) {
      const l = parts.landing;
      this.nums.push(1, this.str(l.name));
      this.pts(l.pts);
      this.nums.push(l.zRel, l.depth);
      this.psets(qto("Qto_SlabBaseQuantities", l.quantities));
    } else {
      this.nums.push(0);
    }
    if (parts.rail) {
      const r = parts.rail;
      this.nums.push(1, this.str(r.name), this.str(r.predefined));
      this.psets(qto("Qto_RailingBaseQuantities", r.quantities));
      this.mesh(r.mesh.positions, r.mesh.indices, false);
    } else {
      this.nums.push(0);
    }
  }

  extrusion(structure: number, id: string, pts: Vec2[], zRel: number, depth: number): void {
    this.nums.push(REC_EXTRUSION, structure, this.str(id));
    this.pts(pts);
    this.nums.push(zRel, depth);
  }

  space(s: {
    structure: number;
    id: string;
    name: string;
    longName: string;
    external: boolean;
    height: number;
    boundary: Vec2[];
    netArea: number;
    grossArea: number;
    siaCategory: string;
    psets: PsetIn[];
  }): void {
    this.nums.push(REC_SPACE, s.structure, this.str(s.id), this.str(s.name), this.str(s.longName), s.external ? 1 : 0, s.height);
    this.pts(s.boundary);
    this.nums.push(s.netArea, s.grossArea, this.str(s.siaCategory));
    this.psets(s.psets);
  }

  endSpaces(): void {
    this.nums.push(REC_END_SPACES);
  }

  roof(structure: number, id: string, name: string, predefined: string, ty: TypeRefIn | null, psets: PsetIn[], positions: number[], indices: number[], closed: boolean): void {
    this.nums.push(REC_ROOF, structure, this.str(id), this.str(name), this.str(predefined));
    this.typeRef(ty);
    this.psets(psets);
    this.mesh(positions, indices, closed);
  }

  column(c: {
    structure: number;
    id: string;
    label: string;
    footprint: Vec2[];
    zRel: number;
    depth: number;
    component: { id: string; name: string } | null;
    psets: PsetIn[];
  }): void {
    this.nums.push(REC_COLUMN, c.structure, this.str(c.id), this.str(c.label));
    this.pts(c.footprint);
    this.nums.push(c.zRel, c.depth, this.optStr(c.component?.id ?? null), this.optStr(c.component?.name ?? null));
    this.psets(c.psets);
  }

  endColumns(): void {
    this.nums.push(REC_END_COLUMNS);
  }

  /** Zone (IfcZone) mit den Räumen `spaceIds`; `key` ergibt die dauerhafte GUID. */
  zone(key: string, name: string, longName: string, spaceIds: readonly string[], psets: PsetIn[]): void {
    this.nums.push(REC_ZONE, this.str(key), this.str(name), this.str(longName), spaceIds.length);
    for (const id of spaceIds) this.nums.push(this.str(id));
    this.psets(psets);
  }

  /** Psets/Mengen an ein geschriebenes Bauteil (Schlüssel wie für seine GUID, z. B. `storey/<id>`). */
  attach(key: string, psets: PsetIn[]): void {
    this.nums.push(REC_ATTACH, this.str(key));
    this.psets(psets);
  }

  /** Ein Klassifikationssystem mit Zuordnungen (Bauteil-Schlüssel → Code, Name der Referenz). */
  classification(system: ClassificationSystem, refs: readonly { key: string; code: string; name: string }[]): void {
    if (refs.length === 0) return;
    this.nums.push(REC_CLASSIFICATION, this.str(system.name), this.str(system.source), this.str(system.edition), refs.length);
    for (const r of refs) this.nums.push(this.str(r.key), this.str(r.code), this.str(r.name));
  }

  /** Argumente für die Rust-Bindung: `[Zahlenpuffer, Zeichenketten durch \0 getrennt]`. */
  args(): [Float64Array, string] {
    return [new Float64Array(this.nums), this.strings.join("\0")];
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

/** Wie weit der Öffnungskörper beidseits über die Wandflächen vorsteht (keine koplanaren Booleans). */
const OPENING_OVERSHOOT = 0.02;

const ROOF_PREDEFINED: Record<string, string> = {
  flach: "FLAT_ROOF",
  pult: "SHED_ROOF",
  sattel: "GABLE_ROOF",
  walm: "HIP_ROOF",
  mansarde: "MANSARD_ROOF",
  zelt: "HIPPED_GABLE_ROOF",
};

const identifier = (name: string, v: string): PropIn => ({ name, ident: v });

/** Basismengen als Pset `Qto_…` (nur wenn Mengen vorliegen). */
function qto(name: string, quantities: readonly Qty[]): PsetIn[] {
  if (quantities.length === 0) return [];
  return [
    {
      name,
      props: quantities.map((x): PropIn => (x.kind === "length" ? { name: x.name, length: x.value } : x.kind === "area" ? { name: x.name, area: x.value } : { name: x.name, volume: x.value })),
    },
  ];
}

/**
 * Baut aus einem Projekt einen vollständigen IFC-SPF-String (IFC4, oder IFC2x3 mit `options.schema`; STEP Physical
 * File). Kein Datei-IO. Leeres Projekt ⇒ valider Minimal-IFC (Project/Site/Building, kein Crash).
 * Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function exportIfcSpf(projectIn: Project, options: IfcExportOptions = {}): string {
  // Georeferenziert exportieren: ist ein Standort-Bezug gesetzt (geoAnchor),
  // wird die gesamte Geometrie auf die ECHTEN LV95-Weltkoordinaten verschoben,
  // damit die IFC-Datei in anderer Software lagerichtig sitzt — auch wenn das
  // Modell lokal nahe (0,0) bearbeitet wurde (s. projectToWorldCoords / der
  // „Neuer Bezugspunkt"-Workflow). Ohne Bezug bleibt alles lokal (Identität).
  const project = projectToWorldCoords(projectIn);
  const flat = new FlatIfc();

  // Je "floor"-Geschoss ein IfcBuildingStorey (Elevation = baseElevation).
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  const storeyIndexByFloorId = new Map<string, number>();
  const storeyBase: number[] = [];
  floors.forEach((floor, i) => {
    storeyIndexByFloorId.set(floor.id, i);
    storeyBase.push(floor.baseElevation ?? 0);
  });
  /** Geschoss → Index der Trägerstruktur, oder −1 = Gebäude (verwaiste floorId). */
  const structureOf = (floorId: string): number => storeyIndexByFloorId.get(floorId) ?? -1;
  const baseOf = (structure: number): number => (structure < 0 ? 0 : storeyBase[structure]);

  // RefElevation (m ü. M.): reale Datumshöhe des Standorts aus dem Georeferenzierungs-Bezug (wie
  // ArchiCADs Vermessungspunkt). Rein informativ — die Geometrie wird NICHT verschoben.
  const refElevation = project.geoAnchor?.height;
  flat.meta({
    projectId: project.id,
    projectName: project.name ?? "",
    now: Math.floor(Date.now() / 1000),
    iso: new Date().toISOString().replace(/\.\d+Z$/, ""),
    hasGeo: !!project.geoAnchor,
    refElevation: typeof refElevation === "number" ? refElevation : null,
    refLatLon: refLatLon(project.geoAnchor?.lv95),
    schema: options.schema === "IFC2X3" ? "IFC2X3" : "IFC4",
    storeys: floors.map((f, i) => ({ id: f.id, name: f.name, base: storeyBase[i] })),
  });

  // Klassifikation: je Bauteil, das geschrieben wird, Schlüssel (wie für die GUID), Art und Ebene sammeln;
  // Rust überspringt Schlüssel ohne geschriebenes Bauteil (degenerierte Wand, Öffnung ohne Körper …).
  const classified: { key: string; kind: ClassifiedKind; categoryCode: string | undefined }[] = [];
  const classify = (key: string, kind: ClassifiedKind, categoryCode: string | undefined): void => {
    classified.push({ key, kind, categoryCode });
  };

  const componentName = (componentId: string): string =>
    project.components.find((c) => c.id === componentId)?.name ?? componentId;
  const typeRef = (
    kind: TypeKind,
    predefined: string,
    t: { id: string; name: string; layers: { componentId: string; thickness: number }[] },
  ): TypeRefIn => ({
    kind,
    id: t.id,
    name: t.name,
    predefined,
    layers: t.layers.map((l) => ({ componentId: l.componentId, componentName: componentName(l.componentId), thickness: l.thickness })),
  });

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
  for (const band of pickGeometry(project).walls) {
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
  /** Name, Typ und Pset einer Wand (verwaister Wandtyp: Roh-ID als Name, kein Typ); `quantities` = Basismengen. */
  const wallIdentity = (wall: Wall, quantities: readonly Qty[]): { name: string; ty: TypeRefIn | null; psets: PsetIn[] } => {
    const qtoSets = qto("Qto_WallBaseQuantities", quantities);
    try {
      const wt = getWallType(project, wall);
      return {
        name: wt.name,
        ty: typeRef(0, "STANDARD", wt),
        psets: [{ name: "Pset_WallCommon", props: [identifier("Reference", wt.name)] }, ...qtoSets],
      };
    } catch {
      return { name: wall.id, ty: null, psets: qtoSets };
    }
  };
  /** Ausdehnung aller Bänder quer zur Wandachse (entlang der linken Normalen ab `wall.start`). */
  const crossExtent = (wall: Wall, bands: readonly RWall[]): { nLo: number; nHi: number } => {
    const n = leftNormal(normalize(sub(wall.end, wall.start)));
    let nLo = Infinity;
    let nHi = -Infinity;
    for (const b of bands) {
      const off = dot({ x: b.start[0] - wall.start.x, y: b.start[1] - wall.start.y }, n);
      nLo = Math.min(nLo, off - b.thickness / 2);
      nHi = Math.max(nHi, off + b.thickness / 2);
    }
    return { nLo, nHi };
  };

  const meshWalls: { wall: Wall; bands: RWall[] }[] = [];
  const hostExtent = new Map<string, { nLo: number; nHi: number }>();
  const cutoutsByWallId = new Map<string, WallCutout[]>();
  for (const wall of project.walls ?? []) {
    const bands = (bandsByWallId.get(wall.id) ?? []).filter(
      (b) => Math.hypot(b.end[0] - b.start[0], b.end[1] - b.start[1]) > 1e-9 && b.height > 1e-9 && b.thickness > 1e-9,
    );
    if (bands.length === 0) continue; // degenerierte Wand / keine Geometrie
    const cutouts = cutoutsOf(wall);
    cutoutsByWallId.set(wall.id, cutouts);
    classify(`wall/${wall.id}`, "wall", wall.categoryCode);
    if (!bandsMatchOpenings(wall, bands, cutouts)) {
      meshWalls.push({ wall, bands: bandsByWallId.get(wall.id)! });
      continue;
    }
    const structure = structureOf(wall.floorId);
    const solids = bands.map((b) => {
      const s: Vec2 = { x: b.start[0], y: b.start[1] };
      const e: Vec2 = { x: b.end[0], y: b.end[1] };
      const n = leftNormal(normalize(sub(e, s)));
      const h = b.thickness / 2;
      const rect = [addScaled(s, n, -h), addScaled(e, n, -h), addScaled(e, n, h), addScaled(s, n, h)];
      return { pts: rect, zRel: b.baseElevation - baseOf(structure), depth: b.height };
    });
    const id = wallIdentity(wall, wallQuantities(wall, bands, cutouts));
    // Wandsystem: Placement am Wandanfang, X = Achse, Y = linke Normale; die Schichten des Typs
    // stehen ab der Aussenfläche (negative Normale) nebeneinander — IfcMaterialLayerSetUsage nur,
    // wenn ihre Summe dem Querschnitt der Bänder entspricht (sonst wäre der Offset gelogen).
    const extent = crossExtent(wall, bands);
    const layerSum = id.ty?.layers.reduce((a, l) => a + l.thickness, 0) ?? 0;
    const usage = id.ty !== null && layerSum > 0 && Math.abs(extent.nHi - extent.nLo - layerSum) < 1e-3;
    flat.wallSolids(
      structure,
      wall.id,
      id.name,
      id.ty,
      id.psets,
      { origin: wall.start, u: normalize(sub(wall.end, wall.start)), length: Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y), offset: usage ? extent.nLo : null },
      solids,
    );
    hostExtent.set(wall.id, extent);
  }
  // Mesh-Weg: Loch-Ausschnitte aller betroffenen Bänder in EINEM Kern-Aufruf.
  const meshBands = meshWalls.flatMap((m) => m.bands);
  const cutOf = new Map<RWall, CutMesh>();
  wallCutMeshes(meshBands).forEach((m, i) => cutOf.set(meshBands[i], m));
  for (const { wall, bands } of meshWalls) {
    const structure = structureOf(wall.floorId);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const band of bands) {
      const cut = cutOf.get(band);
      if (!cut) continue;
      const base = positions.length / 3;
      for (let i = 0; i < cut.positions.length; i += 3) {
        positions.push(cut.positions[i], cut.positions[i + 2], cut.positions[i + 1] - baseOf(structure));
      }
      // Wicklung umkehren (Reflexions-Ausgleich, s. o.): (a,b,c) → (a,c,b).
      for (let i = 0; i < cut.indices.length; i += 3) {
        indices.push(base + cut.indices[i], base + cut.indices[i + 2], base + cut.indices[i + 1]);
      }
    }
    if (indices.length === 0) continue;
    // Closed=.T. NUR wenn das Mesh nachweislich ein dichtes, aussen orientiertes Volumen ist
    // (Wände sind extrudierte Querschnitts-Polygone → geschlossene Körper); der Guard fängt echte
    // Defekte ab (invertierte Wicklung → Volumen < 0 → `$`).
    const closed = isWatertight({ positions, indices });
    // Netto: Volumen des Netzes (Öffnungen samt Laibungen schon ausgestanzt); ohne dichtes Netz Quader minus Löcher.
    const meshBandsOfWall = bandsByWallId.get(wall.id)!;
    const net = closed ? meshVolume(positions, indices) : undefined;
    const quantities = wallQuantities(wall, meshBandsOfWall, cutoutsByWallId.get(wall.id) ?? [], net);
    if (net === undefined) {
      const gross = quantities.find((x) => x.name === "GrossVolume")!.value;
      quantities.find((x) => x.name === "NetVolume")!.value = Math.max(0, gross - holeVolume(meshBandsOfWall));
    }
    const id = wallIdentity(wall, quantities);
    flat.wallMesh(structure, wall.id, id.name, id.ty, id.psets, positions, indices, closed);
    hostExtent.set(wall.id, crossExtent(wall, bandsByWallId.get(wall.id)!));
  }

  // ── Decken ─────────────────────────────────────────────────────────────
  for (const ceiling of project.ceilings ?? []) {
    if (ceiling.outline.length < 3) continue;
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    const structure = structureOf(ceiling.floorId);
    classify(`slab/${ceiling.id}`, "slab", ceiling.categoryCode);
    let name: string = ceiling.id;
    let ty: TypeRefIn | null = null;
    const psets: PsetIn[] = [];
    try {
      const ct = getCeilingType(project, ceiling);
      name = ct.name;
      ty = typeRef(1, "FLOOR", ct);
      psets.push({ name: "Pset_SlabCommon", props: [identifier("Reference", ct.name)] });
    } catch {
      /* verwaister Deckentyp — Roh-ID als Name, kein Typ */
    }
    // Aussparungen (wie im 3D) als innere Ringe des Profils; Mengen: Netto zieht sie ab.
    const inner = (ceiling.openings ?? []).filter((ring) => ring.length >= 3);
    psets.push(...qto("Qto_SlabBaseQuantities", slabQuantities(ceiling.outline, inner, zTop - zBottom)));
    flat.ceiling(structure, ceiling.id, name, ty, psets, ceiling.outline, inner, zBottom - baseOf(structure), zTop - zBottom);
  }

  // ── Öffnungen: IfcOpeningElement in der Wand, IfcDoor/IfcWindow darin ───
  // Der Öffnungskörper ist ein Quader über das Achs-Intervall und die Höhe, wie sie das 3D
  // stanzt (`openingInterval`/`openingVerticalExtent`), quer über alle Bänder der Wand plus
  // OPENING_OVERSHOOT. Die Füllung (Tür/Fenster) hat ein eigenes Placement
  // (Öffnungsmitte, Achse bzw. Aufschlagrichtung) und liegt in der Rahmentiefe (`ifc_openings.rs`).
  for (const wall of project.walls ?? []) {
    const host = hostExtent.get(wall.id);
    if (!host) continue; // Wirtswand übersprungen (degeneriert)
    const structure = structureOf(wall.floorId);
    for (const c of cutoutsByWallId.get(wall.id) ?? []) {
      const { opening } = c;
      const depth = c.zTop - c.zBottom;
      if (!(depth > 1e-6)) continue;
      const isDoor = opening.kind === "door";
      classify(`fill/${opening.id}`, isDoor ? "door" : "window", opening.categoryCode);
      const props: PropIn[] = [];
      let psetName: string;
      if (isDoor) {
        psetName = "Pset_DoorCommon";
        const dt = getDoorType(project, opening);
        if (dt) props.push(identifier("Reference", dt.name));
        const ratio = dt?.glazingRatio;
        if (dt?.leafStyle === "glas" && typeof ratio === "number" && ratio > 0 && ratio <= 1) {
          props.push({ name: "GlazingAreaFraction", ratio });
        }
      } else {
        psetName = "Pset_WindowCommon";
        const wt = getWindowType(project, opening);
        if (wt) props.push(identifier("Reference", wt.name));
      }
      flat.opening({
        wallId: wall.id,
        structure,
        openingId: opening.id,
        isDoor,
        fillName: openingLabel(opening),
        voidRect: axisRect(wall, c.from, c.to, host.nLo - OPENING_OVERSHOOT, host.nHi + OPENING_OVERSHOOT),
        voidZRel: c.zBottom - baseOf(structure),
        depth,
        width: c.to - c.from,
        fill: fillParams(project, wall, opening, c, host),
        psets: [{ name: psetName, props }, ...qto(isDoor ? "Qto_DoorBaseQuantities" : "Qto_WindowBaseQuantities", openingQuantities(c.to - c.from, depth))],
      });
    }
  }

  // ── Treppen: Läufe, Podest, Geländer wie im 3D (`ifcStairs.ts`); ohne Teile der Fussabdruck-Quader ──
  for (const stair of project.stairs ?? []) {
    const footprint = stairFootprint(stair);
    if (footprint.length < 3) continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const structure = structureOf(stair.floorId);
    classify(`stair/${stair.id}`, "stair", stair.categoryCode);
    const predefined = stair.shape === "straight" ? "STRAIGHT_RUN_STAIR" : stair.shape === "spiral" ? "SPIRAL_STAIR" : "QUARTER_TURN_STAIR";
    flat.stair(structure, stair.id, predefined, footprint, zBottom - baseOf(structure), zTop - zBottom, stairParts(project, stair, baseOf(structure)));
  }

  // ── Extrudierte Körper (truck-Integration) → IfcBuildingElementProxy ───
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.points.length < 3) continue;
    const floor = floors.find((f) => f.id === solid.levelId);
    const base = floor?.baseElevation ?? 0;
    const structure = structureOf(solid.levelId);
    flat.extrusion(structure, solid.id, solid.points, base - baseOf(structure), solid.height);
  }

  // ── Räume → IfcSpace ───────────────────────────────────────────────────
  // Je Raum ein IfcSpace (Name = Raumnummer, LongName = Raumname), als Extrusion der lichten
  // Innenkontur über die lichte Geschosshöhe. Räume sind räumliche Elemente: sie werden im
  // Geschoss AGGREGIERT (IfcRelAggregates), nicht enthalten. Dazu Basismengen
  // (Qto_SpaceBaseQuantities), die SIA-416-Kategorie als Eigenschaft und Pset_SpaceCommon
  // (AGF = Aussengeschossfläche ⇒ aussen, alles andere innen).
  const roomAreas: { id: string; floorId: string; category: SiaCategory; area: number }[] = [];
  for (const room of project.rooms ?? []) {
    if (room.boundary.length < 3) continue;
    const structure = structureOf(room.floorId);
    const floor = floors.find((f) => f.id === room.floorId);
    const height = floor?.floorHeight && floor.floorHeight > 0 ? floor.floorHeight : 2.5;
    const external = room.siaCategory === "AGF";
    const area = evaluateRoom(room.boundary, room.siaCategory);
    roomAreas.push({ id: room.id, floorId: room.floorId, category: room.siaCategory, area: area.netArea });
    classify(`space/${room.id}`, "space", room.categoryCode);
    const common: PropIn[] = [];
    if (room.stamp?.number) common.push(identifier("Reference", room.stamp.number));
    common.push({ name: "IsExternal", bool: external });
    flat.space({
      structure,
      id: room.id,
      name: room.stamp?.number || room.id,
      longName: room.name,
      external,
      height,
      boundary: room.boundary,
      netArea: area.netArea,
      grossArea: area.grossArea,
      siaCategory: room.siaCategory,
      psets: [{ name: "Pset_SpaceCommon", props: common }],
    });
  }
  flat.endSpaces();

  // SIA 416 ([70], [B5]): je vorkommender Kategorie eine IfcZone mit den Räumen. Kategorie als Eigenschaft
  // (`CH_Zone.SIA416`, die der Import wieder liest), Summe der Nettoflächen als Menge.
  for (const cat of SIA_CATEGORIES) {
    const members = roomAreas.filter((r) => r.category === cat);
    if (members.length === 0) continue;
    const net = members.reduce((a, r) => a + r.area, 0);
    flat.zone(
      `sia416/${cat}`,
      cat,
      siaLabel(cat),
      members.map((r) => r.id),
      [
        { name: "CH_Zone", props: [identifier("SIA416", cat)] },
        { name: "CH_Qto_SIA416", props: [{ name: "NetFloorArea", area: Math.max(0, net) }] },
      ],
    );
  }
  // Geschoss-Kennwerte: GF/NGF als Basismenge des IfcBuildingStorey, alle SIA-416-Flächen als CH_Qto_SIA416.
  for (const floor of floors) {
    const rooms = roomAreas.filter((r) => r.floorId === floor.id);
    if (rooms.length === 0) continue;
    const bal = balance(rooms.map((r) => ({ category: r.category, area: r.area })));
    const keys = ["HNF", "NNF", "NF", "VF", "FF", "NGF", "KGF", "AGF", "GF"] as const;
    flat.attach(`storey/${floor.id}`, [
      {
        name: "Qto_BuildingStoreyBaseQuantities",
        props: [
          { name: "GrossFloorArea", area: Math.max(0, bal.byKey.GF) },
          { name: "NetFloorArea", area: Math.max(0, bal.byKey.NGF) },
        ],
      },
      { name: "CH_Qto_SIA416", props: keys.map((k): PropIn => ({ name: k, area: Math.max(0, bal.byKey[k]) })) },
    ]);
  }

  // ── Dächer → IfcRoof ───────────────────────────────────────────────────
  // Dieselben geschlossenen Schicht-Meshes wie das 3D (`emitRoofs`: Dachflächen je Schicht,
  // an First/Grat gehrt), zu EINEM Face-Set je Dach vereint. Modell-Koordinaten sind bereits
  // Z-oben (kein Achsentausch wie bei den Wänden); die Wicklung wird so gewählt, dass das Volumen
  // positiv ist — nur dann ist das Face-Set als geschlossen markiert.
  for (const roof of project.roofs ?? []) {
    const structure = structureOf(roof.floorId);
    classify(`roof/${roof.id}`, "roof", roof.categoryCode);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const mesh of emitRoofs({ ...project, roofs: [roof] })) {
      const base = positions.length / 3;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        positions.push(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2] - baseOf(structure));
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
    const predefined = ROOF_PREDEFINED[roof.shape] ?? "NOTDEFINED";
    const roofType = roof.roofTypeId ? (project.roofTypes ?? []).find((t) => t.id === roof.roofTypeId) : undefined;
    // Ein Dach ist Gebäudehülle: IsExternal folgt aus der Bauteilart, nicht aus einer Annahme.
    const props: PropIn[] = [];
    if (roofType) props.push(identifier("Reference", roofType.name));
    props.push({ name: "IsExternal", bool: true });
    // Mengen aus den geneigten Dachflächen (Aussenseite), wie sie auch das Netz erzeugen.
    const planes = roofGeometry(roof, roofBaseElevation(project, roof)).planes.map((pl) => pl.pts);
    flat.roof(
      structure,
      roof.id,
      roofType?.name ?? "Dach",
      predefined,
      roofType ? typeRef(2, predefined, roofType) : null,
      [{ name: "Pset_RoofCommon", props }, ...qto("Qto_RoofBaseQuantities", roofQuantities(planes))],
      positions,
      indices,
      closed,
    );
  }

  // ── Stützen → IfcColumn (Profil-Extrusion, Material = Bauteil) ──────────
  for (const col of project.columns ?? []) {
    const footprint = columnFootprint(col);
    if (footprint.length < 3) continue;
    const { zBottom, zTop } = columnVerticalExtent(project, col);
    if (!(zTop > zBottom)) continue;
    const structure = structureOf(col.floorId);
    classify(`column/${col.id}`, "column", col.categoryCode);
    const label = columnLabel(col);
    flat.column({
      structure,
      id: col.id,
      label,
      footprint,
      zRel: zBottom - baseOf(structure),
      depth: zTop - zBottom,
      component: col.componentId ? { id: col.componentId, name: componentName(col.componentId) } : null,
      psets: [{ name: "Pset_ColumnCommon", props: [identifier("Reference", label)] }, ...qto("Qto_ColumnBaseQuantities", columnQuantities(footprint, zTop - zBottom))],
    });
  }
  flat.endColumns();

  // ── Klassifikation (Optionen), am Ende: alle Bauteile sind geschrieben ──────────────
  if (options.ebkph) {
    flat.classification(
      EBKPH_SYSTEM,
      classified.flatMap((c) => {
        const g = ebkphGroup(c.kind);
        return g ? [{ key: c.key, code: g.code, name: g.name }] : [];
      }),
    );
  }
  if (options.layerCodes) {
    flat.classification(
      LAYER_SYSTEM,
      classified.flatMap((c) => {
        const l = layerClassification(project, c.categoryCode);
        return l ? [{ key: c.key, code: l.code, name: l.name }] : [];
      }),
    );
  }

  const m = fileio();
  const [buf, strings] = flat.args();
  const text = m.export_ifc_flat(buf, strings);
  if (text.length === 0) {
    const why = m.export_ifc_check_flat(buf, strings);
    throw new Error(`IFC-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
  }
  return text;
}
