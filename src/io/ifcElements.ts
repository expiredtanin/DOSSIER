// IFC-Import zu echten Bauteilen ([B4], zweite Stufe von [25]): baut aus dem, was das Format-Modul
// erkannt hat (`src-tauri/fileio/src/ifc_semantic.rs`: Achse, Dicke, Höhe, Umriss … in Metern),
// Dossier-Objekte — Geschosse, Wände (Wandtyp aus den Materialschichten, wiederverwendet oder neu),
// Türen/Fenster/Wanddurchbrüche, Decken (Deckentyp), Stützen, Räume. Was Rust nicht sicher abbilden
// konnte, kommt wie beim Mesh-Import als Kontext-Mesh (`ifcImport.ts`).
//
// Keine Geometrie-Rechnung hier: TS ordnet nur zu (Geschoss nach Höhe, Typ nach Schichten) und setzt
// die Objekte zusammen. Das Projekt wird nicht verändert — der Aufrufer übernimmt das Ergebnis über
// `setProject` (App) bzw. `diffToOps`/`applyOps` (CLI), also über Ops.

import { ensureContextCategories } from "../model/contextCategories";
import type {
  Ceiling,
  CeilingType,
  Column,
  Component,
  DrawingLevel,
  ImportedMesh,
  LayerCategory,
  Opening,
  Project,
  Room,
  SiaCategory,
  Vec2,
  Wall,
  WallType,
} from "../model/types";
import {
  decodeIfc,
  geoShift,
  ifcColorHex,
  ifcToImportedMeshes,
  readIfcFlat,
  type IfcFlat,
  type IfcImportReport,
  type IfcProduct,
} from "./ifcImport";

// ── Rohdaten aus Rust ────────────────────────────────────────────────────────────────────────

export interface IfcMatLayer {
  material: string;
  /** 0 = einziges Material ohne Schichtdicke (gilt für die ganze Dicke). */
  thickness: number;
  color: [number, number, number, number] | null;
}

interface IfcInfo {
  globalId: string;
  ifcClass: string;
  name: string | null;
  /** Index in `storeys`. */
  storey: number | null;
  color: [number, number, number, number] | null;
  typeName: string | null;
  layers: IfcMatLayer[];
}

export interface IfcStoreyData {
  globalId: string;
  name: string;
  elevation: number;
}
export interface IfcWallData extends IfcInfo {
  /** Achse; erste Schicht rechts der Richtung start → end (wie Dossier). */
  start: Vec2;
  end: Vec2;
  z0: number;
  z1: number;
  thickness: number;
}
export interface IfcOpeningData extends IfcInfo {
  /** Index in `walls`. */
  host: number;
  kind: "door" | "window" | "hole";
  position: number;
  width: number;
  sill: number;
  height: number;
  /** Ausführung: IfcDoorTypeOperationEnum bzw. IfcWindowTypePartitioningEnum (Bauteil, sonst Typ). */
  operation: string | null;
  /** Tür: Aufschlag links (+1) / rechts (−1) der Wandachse, 0 = unbekannt (Rust `ifc_semantic`). */
  swing: number;
  /** Tür: Scharnier am Wandanfang (+1) / -ende (−1), 0 = unbekannt. */
  hinge: number;
}
export interface IfcSlabData extends IfcInfo {
  outline: Vec2[];
  holes: Vec2[][];
  z0: number;
  z1: number;
}
export interface IfcColumnData extends IfcInfo {
  center: Vec2;
  rotation: number;
  profile: { kind: "rect"; width: number; depth: number } | { kind: "round"; radius: number };
  z0: number;
  z1: number;
}
export interface IfcSpaceData extends IfcInfo {
  longName: string | null;
  sia: string | null;
  boundary: Vec2[];
  z0: number;
  z1: number;
}

/** Erkannte Bauteile einer Datei. */
export interface IfcElementsData {
  storeys: IfcStoreyData[];
  walls: IfcWallData[];
  openings: IfcOpeningData[];
  slabs: IfcSlabData[];
  columns: IfcColumnData[];
  spaces: IfcSpaceData[];
  /** Nicht sicher abbildbare Kandidaten je Klasse (bleiben Mesh). */
  kept: Record<string, number>;
}

interface RawElement extends IfcInfo {
  kind: "wall" | "opening" | "slab" | "column" | "space";
  at: number;
  n: number;
  host?: number;
  openingKind?: "door" | "window" | "hole";
  operation?: string | null;
  profile?: "rect" | "round";
  longName?: string | null;
  sia?: string | null;
}

/** Erkannte Bauteile aus dem Rohergebnis; `null`, wenn ohne Bauteil-Erkennung gelesen. */
export function decodeIfcElements(flat: IfcFlat): IfcElementsData | null {
  const meta = JSON.parse(flat.meta) as { elements?: { storeys: IfcStoreyData[]; elements: RawElement[]; kept: Record<string, number> } };
  const raw = meta.elements;
  const data = flat.elementData;
  if (!raw || !data) return null;
  const out: IfcElementsData = { storeys: raw.storeys, walls: [], openings: [], slabs: [], columns: [], spaces: [], kept: raw.kept ?? {} };
  // Wand-Index in Rust → Index in `out.walls` (verworfene Wände fallen heraus).
  const wallIndex = new Map<number, number>();
  let rustWall = 0;
  for (const e of raw.elements) {
    const v = data.subarray(e.at, e.at + e.n);
    if (v.length !== e.n || !v.every(Number.isFinite)) {
      if (e.kind === "wall") rustWall++;
      continue;
    }
    const info: IfcInfo = {
      globalId: e.globalId,
      ifcClass: e.ifcClass,
      name: e.name,
      storey: e.storey,
      color: e.color,
      typeName: e.typeName,
      layers: e.layers ?? [],
    };
    const rings = (start: number, count: number): { rings: Vec2[][]; ok: boolean } => {
      const res: Vec2[][] = [];
      let i = start;
      for (let r = 0; r < count; r++) {
        const n = v[i++];
        if (!(n >= 3) || i + 2 * n > v.length) return { rings: res, ok: false };
        const ring: Vec2[] = [];
        for (let k = 0; k < n; k++) ring.push({ x: v[i + 2 * k], y: v[i + 2 * k + 1] });
        i += 2 * n;
        res.push(ring);
      }
      return { rings: res, ok: true };
    };
    switch (e.kind) {
      case "wall":
        if (v.length === 7) {
          wallIndex.set(rustWall, out.walls.length);
          out.walls.push({ ...info, start: { x: v[0], y: v[1] }, end: { x: v[2], y: v[3] }, z0: v[4], z1: v[5], thickness: v[6] });
        }
        rustWall++;
        break;
      case "opening": {
        const host = wallIndex.get(e.host ?? -1);
        if (host !== undefined && v.length === 6) {
          out.openings.push({
            ...info,
            host,
            kind: e.openingKind ?? "hole",
            position: v[0],
            width: v[1],
            sill: v[2],
            height: v[3],
            operation: e.operation ?? null,
            swing: Math.sign(v[4]),
            hinge: Math.sign(v[5]),
          });
        }
        break;
      }
      case "slab": {
        const r = rings(3, v[2]);
        if (r.ok && r.rings.length >= 1) out.slabs.push({ ...info, z0: v[0], z1: v[1], outline: r.rings[0], holes: r.rings.slice(1) });
        break;
      }
      case "column":
        if (v.length === 7) {
          const profile =
            e.profile === "round" ? { kind: "round" as const, radius: v[5] } : { kind: "rect" as const, width: v[5], depth: v[6] };
          out.columns.push({ ...info, center: { x: v[0], y: v[1] }, rotation: v[2], z0: v[3], z1: v[4], profile });
        }
        break;
      case "space": {
        const r = rings(2, 1);
        if (r.ok) out.spaces.push({ ...info, longName: e.longName ?? null, sia: e.sia ?? null, z0: v[0], z1: v[1], boundary: r.rings[0] });
        break;
      }
    }
  }
  return out;
}

/** Liest IFC-Bytes mit Bauteil-Erkennung (im Worker, sonst direkt). */
export async function readIfcElements(
  bytes: Uint8Array,
): Promise<{ products: IfcProduct[]; report: IfcImportReport; elements: IfcElementsData }> {
  const flat = await readIfcFlat(bytes, true);
  const { products, report } = decodeIfc(flat);
  const elements = decodeIfcElements(flat) ?? { storeys: [], walls: [], openings: [], slabs: [], columns: [], spaces: [], kept: {} };
  return { products, report, elements };
}

// ── Aufbau der Dossier-Objekte ───────────────────────────────────────────────────────────────

export interface IfcElementsOptions {
  /** Dateiname (für die Namen der Kontext-Meshes). */
  fileName: string;
  /** LV95-Ursprung des Projekts (`projectGeoOrigin`), sonst null. */
  geoOrigin?: { e: number; n: number } | null;
  group?: "product" | "class" | "auto";
}

/** Was übernommen wurde (für Meldung und Tests). */
export interface IfcElementsSummary {
  walls: number;
  openings: number;
  ceilings: number;
  columns: number;
  rooms: number;
  /** Neu angelegte Geschosse. */
  floors: number;
  wallTypes: number;
  ceilingTypes: number;
  components: number;
  /** Bauteile als Kontext-Mesh. */
  meshes: number;
  /** Davon Kandidaten, die nicht sicher abbildbar waren. */
  kept: number;
}

const WALL_CATEGORY = "20";
const OPENING_CATEGORY = "21";
const CEILING_CATEGORY = "30";
const COLUMN_CATEGORY = "50";
const ROOM_CATEGORY = "60";
const ROOM_COLOR = "#6b7280";
const SIA: readonly SiaCategory[] = ["HNF", "NNF", "VF", "FF", "KGF", "AGF"];
/** Toleranzen (m): gleiche Höhe eines Geschosses, gleiche Schichtdicke. */
const LEVEL_TOL = 0.005;
const LAYER_TOL = 0.0005;

let counter = 0;

const round = (x: number, step = 1e-9) => Math.round(x / step) * step;

function flatCategories(list: LayerCategory[], out: LayerCategory[] = []): LayerCategory[] {
  for (const c of list) {
    out.push(c);
    if (c.children) flatCategories(c.children, out);
  }
  return out;
}

/**
 * Setzt die erkannten Bauteile und die übrigen Kontext-Meshes ins Projekt (neues Objekt, das alte
 * bleibt unverändert). Geschosse werden nach Höhe wiederverwendet (±5 mm) oder angelegt, Wand- und
 * Deckentypen nach Schichten (Material + Dicke) wiederverwendet oder angelegt, Materialien nach Namen.
 */
export function ifcElementsToProject(
  project: Project,
  products: IfcProduct[],
  elements: IfcElementsData,
  opts: IfcElementsOptions,
): { project: Project; summary: IfcElementsSummary } {
  const stamp = Date.now().toString(36);
  const newId = (kind: string) => `ifc-${kind}-${stamp}-${counter++}`;
  const summary: IfcElementsSummary = {
    walls: 0, openings: 0, ceilings: 0, columns: 0, rooms: 0, floors: 0, wallTypes: 0, ceilingTypes: 0, components: 0, meshes: 0,
    kept: Object.values(elements.kept).reduce((s, n) => s + n, 0),
  };

  // Verschiebung bei Landeskoordinaten: gemeinsam für Bauteile und Meshes.
  const extra: number[] = [];
  for (const w of elements.walls) extra.push(w.start.x, w.start.y, w.end.x, w.end.y);
  for (const s of elements.slabs) for (const p of s.outline) extra.push(p.x, p.y);
  for (const c of elements.columns) extra.push(c.center.x, c.center.y);
  for (const s of elements.spaces) for (const p of s.boundary) extra.push(p.x, p.y);
  const [dx, dy] = geoShift(products, opts.geoOrigin, extra);
  const mv = (p: Vec2): Vec2 => ({ x: round(p.x + dx), y: round(p.y + dy) });

  // ── Geschosse ──
  const levels: DrawingLevel[] = [...project.drawingLevels];
  const floorsSorted = () => levels.filter((l) => l.kind === "floor").sort((a, b) => (a.baseElevation ?? 0) - (b.baseElevation ?? 0));
  const topOf = new Map<number, number>();
  const noteTop = (storey: number | null, z: number) => {
    if (storey !== null) topOf.set(storey, Math.max(topOf.get(storey) ?? -Infinity, z));
  };
  for (const w of elements.walls) noteTop(w.storey, w.z1);
  for (const c of elements.columns) noteTop(c.storey, c.z1);
  const storeyFloor = elements.storeys.map((s, i) => {
    const existing = levels.find((l) => l.kind === "floor" && Math.abs((l.baseElevation ?? 0) - s.elevation) <= LEVEL_TOL);
    if (existing) return existing.id;
    const next = elements.storeys[i + 1];
    const top = topOf.get(i);
    const height = next ? next.elevation - s.elevation : top !== undefined && top > s.elevation + 0.5 ? top - s.elevation : 2.6;
    const level: DrawingLevel = {
      id: newId("floor"),
      name: s.name || `IFC ${round(s.elevation, 0.001)}`,
      kind: "floor",
      visible: true,
      locked: false,
      floorHeight: round(height, 1e-6),
      cutHeight: 1,
      baseElevation: round(s.elevation, 1e-6),
    };
    // Einfügen vor dem ersten höheren Geschoss, sonst nach dem letzten.
    const floors = floorsSorted();
    const higher = floors.find((l) => (l.baseElevation ?? 0) > s.elevation);
    const at = higher ? levels.indexOf(higher) : floors.length ? levels.indexOf(floors[floors.length - 1]) + 1 : 0;
    levels.splice(at, 0, level);
    summary.floors++;
    return level.id;
  });
  /** Geschoss eines Bauteils: aus der Datei, sonst das höchste mit OK FB ≤ Unterkante. */
  const floorOf = (storey: number | null, z0: number): DrawingLevel => {
    const id = storey !== null ? storeyFloor[storey] : undefined;
    const byId = id ? levels.find((l) => l.id === id) : undefined;
    if (byId) return byId;
    const floors = floorsSorted();
    const below = floors.filter((l) => (l.baseElevation ?? 0) <= z0 + LEVEL_TOL);
    const f = below[below.length - 1] ?? floors[0];
    if (f) return f;
    const level: DrawingLevel = { id: newId("floor"), name: "IFC", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1, baseElevation: 0 };
    levels.push(level);
    summary.floors++;
    return level;
  };
  const anchorOffset = (z: number, f: DrawingLevel) => round(z - (f.baseElevation ?? 0), 1e-6);

  // ── Materialien und Typen ──
  const components: Component[] = [...project.components];
  const hatchId = project.hatches.find((h) => h.id === "none")?.id ?? project.hatches[0]?.id ?? "none";
  const componentFor = (name: string, color: string | undefined): string => {
    const key = name.trim().toLowerCase();
    const found = components.find((c) => c.name.trim().toLowerCase() === key);
    if (found) return found.id;
    const c: Component = { id: newId("component"), name: name.trim() || "IFC", color: color ?? "#b0b0b0", hatchId, joinPriority: 50 };
    components.push(c);
    summary.components++;
    return c.id;
  };
  /** Schichten eines Bauteils der Dicke `t`: die der Datei, wenn sie aufgehen, sonst eine Schicht. */
  const layerSpec = (e: IfcInfo, t: number): { material: string; thickness: number; color?: string }[] => {
    const ls = e.layers;
    const sum = ls.reduce((s, l) => s + l.thickness, 0);
    if (ls.length > 0 && ls.every((l) => l.thickness > 0) && Math.abs(sum - t) <= 0.005) {
      return ls.map((l) => ({ material: l.material, thickness: round(l.thickness, 1e-6), color: ifcColorHex(l.color) }));
    }
    const first = ls.length === 1 ? ls[0] : undefined;
    return [{ material: first?.material ?? "", thickness: round(t, 1e-6), color: ifcColorHex(first?.color ?? e.color) }];
  };
  const sameLayers = (
    have: { componentId: string; thickness: number }[],
    want: { material: string; thickness: number }[],
  ): boolean =>
    have.length === want.length &&
    have.every((l, i) => {
      if (Math.abs(l.thickness - want[i].thickness) > LAYER_TOL) return false;
      const name = components.find((c) => c.id === l.componentId)?.name.trim().toLowerCase() ?? "";
      return want[i].material ? name === want[i].material.trim().toLowerCase() : true;
    });
  const typeName = (e: IfcInfo, t: number) => e.typeName?.trim() || `IFC ${round(t * 100, 0.1)} cm`;
  const wallTypes: WallType[] = [...project.wallTypes];
  const wallTypeFor = (e: IfcInfo, t: number): string => {
    const spec = layerSpec(e, t);
    const name = typeName(e, t);
    // Ohne Material: nur ein gleich benannter, gleich dicker Typ passt.
    const found = wallTypes.find((wt) => sameLayers(wt.layers, spec) && (spec.some((l) => l.material) || wt.name === name));
    if (found) return found.id;
    const wt: WallType = {
      id: newId("walltype"),
      name,
      layers: spec.map((l) => ({ componentId: componentFor(l.material, l.color), thickness: l.thickness })),
    };
    wallTypes.push(wt);
    summary.wallTypes++;
    return wt.id;
  };
  const ceilingTypes: CeilingType[] = [...(project.ceilingTypes ?? [])];
  const ceilingTypeFor = (e: IfcInfo, t: number): string => {
    const spec = layerSpec(e, t);
    const name = typeName(e, t);
    const found = ceilingTypes.find((ct) => sameLayers(ct.layers, spec) && (spec.some((l) => l.material) || ct.name === name));
    if (found) return found.id;
    const ct: CeilingType = {
      id: newId("ceilingtype"),
      name,
      layers: spec.map((l) => ({ componentId: componentFor(l.material, l.color), thickness: l.thickness })),
    };
    ceilingTypes.push(ct);
    summary.ceilingTypes++;
    return ct.id;
  };

  // ── Wände und Öffnungen ──
  const walls: Wall[] = [];
  for (const w of elements.walls) {
    const f = floorOf(w.storey, w.z0);
    const height = round(w.z1 - w.z0, 1e-6);
    const bottom = anchorOffset(w.z0, f);
    walls.push({
      id: newId("wall"),
      type: "wall",
      floorId: f.id,
      categoryCode: WALL_CATEGORY,
      start: mv(w.start),
      end: mv(w.end),
      wallTypeId: wallTypeFor(w, w.thickness),
      height,
      ...(Math.abs(bottom) > LEVEL_TOL ? { bottom: { mode: "floor" as const, floorId: f.id, offset: bottom } } : {}),
    });
  }
  const openings: Opening[] = [];
  for (const o of elements.openings) {
    const host = walls[o.host];
    if (!host) continue;
    const kind = o.kind === "window" ? "window" : "door";
    const op = o.operation ?? "";
    // Tür: Typ nach Art (Dreh/Schiebe) und Blattzahl aus der Ausführung, sonst der erste Typ.
    const sliding = op.includes("SLIDING");
    const leaves = op.startsWith("DOUBLE_DOOR") ? 2 : 1;
    const doorType =
      (op ? project.doorTypes?.find((t) => t.kind === (sliding ? "schiebe" : "dreh") && t.leafCount === leaves) : undefined) ??
      project.doorTypes?.[0];
    // Fenster: Flügelzahl aus der Teilung (nur senkrechte Standardfälle); Typ mit dieser Flügelzahl, sonst
    // der erste Typ mit eigener Flügelzahl an der Öffnung.
    const wings = ({ SINGLE_PANEL: 1, DOUBLE_PANEL_VERTICAL: 2, TRIPLE_PANEL_VERTICAL: 3 } as Record<string, number>)[op];
    const windowType = (wings ? project.windowTypes?.find((t) => t.wingCount === wings) : undefined) ?? project.windowTypes?.[0];
    const typeId = o.kind === "door" ? doorType?.id : o.kind === "window" ? windowType?.id : undefined;
    const doorExtra =
      o.kind === "door"
        ? {
            ...(o.hinge !== 0 ? { hinge: o.hinge > 0 ? ("start" as const) : ("end" as const) } : {}),
            ...(o.swing !== 0 ? { swing: o.swing > 0 ? ("left" as const) : ("right" as const) } : {}),
          }
        : {};
    const windowExtra = o.kind === "window" && wings && (windowType?.wingCount ?? 1) !== wings ? { wingCount: wings } : {};
    openings.push({
      id: newId("opening"),
      type: "opening",
      hostWallId: host.id,
      categoryCode: OPENING_CATEGORY,
      kind,
      position: round(o.position, 1e-6),
      width: round(o.width, 1e-6),
      height: round(o.height, 1e-6),
      sillHeight: round(o.sill, 1e-6),
      ...(o.kind === "hole" ? { doorType: "wandoeffnung" as const } : {}),
      ...(typeId ? { typeId } : {}),
      ...doorExtra,
      ...windowExtra,
    });
  }

  // ── Decken, Stützen, Räume ──
  const ceilings: Ceiling[] = [];
  for (const s of elements.slabs) {
    const f = floorOf(s.storey, s.z0);
    const t = s.z1 - s.z0;
    const floorTop = (f.baseElevation ?? 0) + (f.floorHeight ?? 0);
    ceilings.push({
      id: newId("ceiling"),
      type: "ceiling",
      floorId: f.id,
      categoryCode: CEILING_CATEGORY,
      outline: s.outline.map(mv),
      ...(s.holes.length ? { openings: s.holes.map((h) => h.map(mv)) } : {}),
      wallTypeId: project.wallTypes[0]?.id ?? wallTypes[0]?.id ?? "",
      ceilingTypeId: ceilingTypeFor(s, t),
      ...(Math.abs(s.z1 - floorTop) > LEVEL_TOL ? { top: { mode: "floor" as const, floorId: f.id, offset: anchorOffset(s.z1, f) } } : {}),
    });
  }
  const columns: Column[] = [];
  for (const c of elements.columns) {
    const f = floorOf(c.storey, c.z0);
    const bottom = anchorOffset(c.z0, f);
    const material = c.layers[0]?.material;
    columns.push({
      id: newId("column"),
      type: "column",
      floorId: f.id,
      categoryCode: COLUMN_CATEGORY,
      position: mv(c.center),
      profile:
        c.profile.kind === "round"
          ? { kind: "round", radius: round(c.profile.radius, 1e-6) }
          : { kind: "rect", width: round(c.profile.width, 1e-6), depth: round(c.profile.depth, 1e-6) },
      rotation: c.rotation,
      height: round(c.z1 - c.z0, 1e-6),
      ...(material ? { componentId: componentFor(material, ifcColorHex(c.layers[0].color ?? c.color)) } : {}),
      ...(Math.abs(bottom) > LEVEL_TOL ? { bottom: { mode: "floor" as const, floorId: f.id, offset: bottom } } : {}),
    });
  }
  const roomColor = flatCategories(project.layers).find((c) => c.code === ROOM_CATEGORY)?.color ?? ROOM_COLOR;
  const rooms: Room[] = [];
  for (const s of elements.spaces) {
    const f = floorOf(s.storey, s.z0);
    const boundary = s.boundary.map(mv);
    const sia = SIA.find((c) => c === s.sia?.trim().toUpperCase());
    const n = boundary.length;
    rooms.push({
      id: newId("room"),
      type: "room",
      floorId: f.id,
      categoryCode: ROOM_CATEGORY,
      siaCategory: sia ?? "HNF",
      name: s.longName || s.name || `Raum ${(project.rooms?.length ?? 0) + rooms.length + 1}`,
      boundary,
      color: roomColor,
      stampAnchor: { x: boundary.reduce((a, p) => a + p.x, 0) / n, y: boundary.reduce((a, p) => a + p.y, 0) / n },
    });
  }

  // ── Übrige Bauteile als Kontext-Mesh ──
  const meshes: ImportedMesh[] = ifcToImportedMeshes(products, opts.fileName, { geoOrigin: opts.geoOrigin, group: opts.group, shift: [dx, dy] });
  summary.walls = walls.length;
  summary.openings = openings.length;
  summary.ceilings = ceilings.length;
  summary.columns = columns.length;
  summary.rooms = rooms.length;
  summary.meshes = meshes.length;

  const next: Project = {
    ...project,
    drawingLevels: levels,
    components,
    wallTypes,
    ...(ceilingTypes.length || project.ceilingTypes ? { ceilingTypes } : {}),
    walls: [...project.walls, ...walls],
    openings: [...(project.openings ?? []), ...openings],
    ceilings: [...(project.ceilings ?? []), ...ceilings],
    columns: [...(project.columns ?? []), ...columns],
    rooms: [...(project.rooms ?? []), ...rooms],
    ...(meshes.length
      ? {
          context: [...(project.context ?? []), ...meshes],
          layers: ensureContextCategories(project.layers, meshes.flatMap((m) => (m.categoryCode ? [m.categoryCode] : []))),
        }
      : {}),
  };
  return { project: next, summary };
}

/** Meldung zum Bauteil-Import; `tr` übersetzt (Kern kennt kein i18n). */
export function formatIfcElementsSummary(
  s: IfcElementsSummary,
  r: IfcImportReport,
  tr: (key: "ifc.import.elements" | "ifc.import.kept", vars?: Record<string, string | number>) => string,
): string {
  const parts = [
    tr("ifc.import.elements", {
      schema: r.schema || "IFC",
      walls: s.walls,
      openings: s.openings,
      ceilings: s.ceilings,
      columns: s.columns,
      rooms: s.rooms,
      floors: s.floors,
      meshes: s.meshes,
    }),
  ];
  if (s.kept) parts.push(tr("ifc.import.kept", { n: s.kept }));
  return parts.join(" · ");
}
