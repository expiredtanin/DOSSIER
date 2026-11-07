// 2D-Griff-Editieren des aktuell einzeln selektierten Elements (Wand/2D-Element/
// Decke/Raum/Öffnung/Treppe): Eckpunkt- + Kanten-Griffe, deren Zieh-Handler
// (inkl. Ortho/Snap/koinzidente Nachbar-Ecken) sowie der Tab-Feld-Controller für
// präzise Länge/Winkel-Eingabe während eines Vertex-Drags.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef, useState, type RefObject } from "react";
import { useEventBundle, useSameData } from "./useEvent";
import { leftNormal, normalize, scale, sub, wallCorners } from "../model/geometry";
import type { Ceiling, Drawing2D, EdgeGrip, Excavation, Project, Room, Vec2 } from "../model/types";
import { wallTypeThickness } from "../model/types";
import { bulgeArcPoints, drawingVertices, surfaceOpeningGripPatch, surfaceOpeningGrips, surfaceOpeningInfo, wallArcBand } from "../core";
import { gripDrawingIdsFor } from "./gripLimits";
import { openEdges, polylineEdgeGrips, ringEdges } from "../core";
import {
  coincidentGripPoints,
  excavationGripPoints,
  gripAxisLock,
  gripEdgeTarget,
  gripPolar,
  gripPolarPoint,
  openingGripPoint,
  openingSheetSlide,
  openingTypedPosition,
  sheetHeightDrag,
  stairMoveHandle,
  stairParamPoints,
  wallGripPoints,
  type GripLocks,
} from "../core";
import { areaMovePreview, drawingMovePreview } from "../tools/transform";
import type { DraftShape, SnapResult, SnapSettings, ToolDraft, ToolMods } from "../tools/types";
import { computeSnap } from "../tools/snapping";
import { useCommandTabShortcut } from "./useKeyboardShortcuts";
import { sheetOwnerOutlines } from "../tools/sheetSnapGeometry";
import type { BodyTarget } from "../views/plan/PlanView";
import type { CommandLineHandle } from "../ui/CommandLine";
import type { CommandEngine } from "../commands/engine";
import { single } from "./selection";
import { getState as storeState } from "./appStore";
import { patchItem } from "../core";
import { treeGripPatch, treeGripPoints } from "./treeGrips";
import type { Selection } from "./selection";

export interface GripEditFieldsState {
  id: string;
  labelKey: string;
  value: number | null;
  locked: boolean;
  active: boolean;
}

/** Länge/Winkel-Felder des Befehlsfelds (Live-Werte `live`, gelockte aus `ed.locks`). */
function polarFields(
  ed: { active: "length" | "angle"; locks: GripLocks },
  live: { length: number; angleDeg: number },
): GripEditFieldsState[] {
  return [
    { id: "length", labelKey: "cmd.field.length", value: ed.locks.length ?? live.length, locked: ed.locks.length != null, active: ed.active === "length" },
    { id: "angle", labelKey: "cmd.field.angle", value: ed.locks.angle ?? live.angleDeg, locked: ed.locks.angle != null, active: ed.active === "angle" },
  ];
}

export function useGripEditing(opts: {
  project: Project;
  selectedDrawing: Drawing2D | null;
  selectedCeiling: Ceiling | null;
  /** [68] Einzeln gewählte Baugrube (Umriss-Ecken, Kanten, Sohlenhöhe als Griffe). */
  selectedExcavation?: Excavation | null;
  selectedRoom: Room | null;
  /** Die Auswahl ([130]); Einzel-Elemente daraus wie in `useSelectionState`. */
  selection: Selection;
  levelId: string;
  /**
   * Ob Modell-Bauteile (Wand/Decke/Raum/Öffnung/Treppe) Griffe bekommen und per
   * Körper-Zug verschoben werden dürfen. `false` im Schnitt/in der Ansicht: deren
   * Blatt misst Länge×Höhe entlang der Schnittlinie, die Bauteile aber X/Y im
   * Grundriss — Griffe lägen an völlig falschen Stellen und ein Zug würde das
   * Schnitt-Delta als Grundriss-Verschiebung anwenden. 2D-Elemente der Ebene
   * selbst bleiben voll editierbar (sie leben im Blatt-Raum).
   */
  modelEditable?: boolean;
  /**
   * Schnitt-Blatt (nur bei `modelEditable === false`): geschnittene Wände/Decken
   * lassen sich dort WAAGRECHT ziehen — das Blatt-Delta (u) wird entlang der
   * Schnitt-u-Achse `uAxis` (Grundriss, Einheit) aufs Bauteil übertragen, die
   * Vorschau zeigt die verschobenen Schnittflächen im Blatt.
   */
  sheet?: { levelId: string; uAxis: Vec2 } | null;
  visibleCodes: Set<string>;
  /** Papier-Massstab (1:N) — die Bemassungs-Griffe hängen daran (Papier-mm). */
  scaleDenominator: number;
  snap: SnapSettings;
  setDraft: (draft: ToolDraft | null) => void;
  snapFor: (raw: Vec2, pxPerMeter: number, mods: ToolMods) => SnapResult | null;
  engineRef: RefObject<CommandEngine | null>;
  commandLineRef: RefObject<CommandLineHandle | null>;
  updateOpening: (id: string, patch: Record<string, unknown>) => void;
  /** [144] Wandöffnung gleiten lassen (Kern: Wand, Bogenwand, Nachbaröffnungen). */
  slideOpening: (id: string, to: { position: number } | { pt: Vec2 }, coalesceKey?: string) => void;
  /** Wand ändern (Höhen-Griff im Schnitt); `coalesceKey` fasst einen Zug zu EINEM Undo-Schritt. */
  updateWall: (id: string, patch: Partial<import("../model/types").Wall>, coalesceKey?: string) => void;
  moveStairBy: (id: string, delta: Vec2) => void;
  /** [151] Parameter-Griff einer Podesttreppe ziehen (Index ohne den Bewegpunkt). */
  dragStairParam?: (id: string, index: number, pt: Vec2) => void;
  moveRoomGrip: (id: string, index: number, pt: Vec2) => void;
  moveCeilingGrip: (id: string, index: number, pt: Vec2) => void;
  moveExcavationGrip: (id: string, index: number, pt: Vec2) => void;
  moveExcavationEdge: (id: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  moveGripOf: (
    drawingId: string | null,
    wallId: string | null,
    index: number,
    pt: Vec2,
    scaleDenominator?: number,
  ) => void;
  moveRoomEdge: (id: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  moveCeilingEdge: (id: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  moveEdgeOf: (
    drawingId: string | null,
    wallId: string | null,
    aIndex: number,
    bIndex: number,
    delta: Vec2,
  ) => void;
  moveRoomBy: (id: string, delta: Vec2) => void;
  moveCeilingBy: (id: string, delta: Vec2) => void;
  moveElementByOf: (drawingId: string | null, wallId: string | null, delta: Vec2) => void;
  /**
   * Fasst mehrere Änderungen zu EINEM Undo-Schritt zusammen ([K4] S3, Store `groupChanges`); mit
   * Schlüssel schliessen die Mausschritte desselben Zugs an denselben Schritt an.
   */
  groupChanges?: (fn: () => void, coalesceKey?: string) => void;
}) {
  const {
    project,
    selectedDrawing,
    selectedCeiling,
    selectedExcavation = null,
    selectedRoom,
    selection,
    levelId,
    modelEditable = true,
    sheet = null,
    visibleCodes,
    scaleDenominator,
    snap,
    setDraft,
    snapFor,
    engineRef,
    commandLineRef,
    updateOpening,
    slideOpening,
    updateWall,
    moveStairBy,
    moveRoomGrip,
    moveCeilingGrip,
    moveExcavationGrip,
    moveExcavationEdge,
    moveGripOf,
    moveRoomEdge,
    moveCeilingEdge,
    moveEdgeOf,
    moveRoomBy,
    moveCeilingBy,
    moveElementByOf,
  } = opts;
  const selectedOpeningId = single(selection, "openings");
  const selectedStairId = single(selection, "stairs");
  // [149] Baum: Griff in der Stammmitte (verschieben) und am Kronenrand (Kronendurchmesser).
  const selectedTreeId = single(selection, "trees");
  const selectedTree = selectedTreeId ? (project.trees ?? []).find((x) => x.id === selectedTreeId) : undefined;
  // Mit gezeigter Beschriftung dazu ihr Griff (`labelOffset`, s. `treeGrips.ts`).
  const treeGrips = (tr: NonNullable<typeof selectedTree>): Vec2[] => treeGripPoints(tr, scaleDenominator);
  const selectedRoomId = single(selection, "rooms");
  const selectedCeilingId = single(selection, "ceilings");
  const selectedDrawingId = single(selection, "drawings");
  const selectedWallId = selection.walls[0] ?? null;
  const { walls: selectedWallIds, drawings: selectedDrawingIds } = selection;
  const groupChanges = opts.groupChanges ?? ((fn: () => void) => fn());

  // Bewegpunkt einer Treppe (`stairMoveHandle`, Kern `grip_drag.rs`): liegt auf der Treppe und verschiebt
  // beim Ziehen die GANZE Treppe (moveStairBy mit dem Delta) — analog zum Öffnungs-Mittelpunkt.

  // Welchem Element + lokalem Vertex-Index ein Griff im flachen `grips`-Array
  // gehört (Mehrfachauswahl, Nutzer-Report: Griffe verschwanden komplett,
  // sobald 2 Elemente gewählt waren — die alte Logik kannte nur GENAU EIN
  // selektiertes Element). Leer (`{}`) bei den exklusiven Einzel-Fällen
  // (Öffnung/Treppe/Decke/Raum), die weiterhin nur einzeln editierbar sind.
  interface GripOwner {
    drawingId?: string;
    wallId?: string;
    localIndex: number;
  }
  const gripOwners: GripOwner[] = [];
  // [ersterFlachIndex, letzterFlachIndex] DESSELBEN Elements — für die Anker-
  // Auflösung (Shift-Ortho, Tab-Feld-Controller): der "Nachbar-Griff" muss aus
  // demselben Element kommen, nicht irgendeinem anderen der Mehrfachauswahl.
  const gripOwnerRange: [number, number][] = [];

  // Die Einzel-ID leitet sich aus der Menge ab ([130]) — die Menge genügt.
  // [137] Im Schnitt/in der Ansicht nur die 2D-Elemente der Blatt-Ebene: ein dort angewähltes Achsraster
  // (Grundriss-Element, im Blatt projiziert) hat keine Griffe/kein Verschieben in Blatt-Koordinaten.
  const effectiveDrawingIds = modelEditable
    ? selectedDrawingIds
    : selectedDrawingIds.filter((id) => project.drawings2d.find((x) => x.id === id)?.levelId === levelId);

  // Griff-Grenzen (s. gripLimits.ts): grosse Mehrfachauswahlen ohne Griffe, ein einzeln gewähltes
  // Element immer mit Griffen (Kataster-Parzellen mit tausenden Stützpunkten).
  // [137] Gewählte Gruppe: keine Mitglieds-Griffe (Vectorworks: erst die Gruppe betreten) — ein Ziehen am
  // Körper verschiebt die Gruppe als Ganzes, statt einen der dicht liegenden Griffe zu erwischen.
  const gripDrawingIds = gripDrawingIdsFor(selection.groups.length > 0 ? [] : effectiveDrawingIds, (id) => {
    const d = project.drawings2d.find((x) => x.id === id);
    return d ? drawingVertices(d, scaleDenominator).length : 0;
  });

  // ── Höhen-Griffe im Schnitt/in der Ansicht ───────────────────────────────
  // Gewählte Wand: Griff an der Oberkante (ändert `height`). Gewähltes Fenster: Griffe
  // an Ober- und Unterkante (Höhe bzw. Brüstung, Oberkante bleibt stehen); Tür nur oben.
  // Alles in Blatt-Koordinaten (u, Höhe über ±0.00). Projekt erst beim Loslassen.
  type SheetHeightGrip = {
    kind: "wallTop" | "openingTop" | "openingBottom";
    id: string;
    pt: Vec2;
    u0: number;
    u1: number;
    base: number;
    top: number;
    bottom: number;
  };
  const sheetHeightGrips: SheetHeightGrip[] = (() => {
    if (modelEditable || !sheet) return [];
    const bbox = (kind: "wall" | "opening", id: string) => {
      const polys = sheetOwnerOutlines(sheet.levelId, kind, id);
      if (polys.length === 0) return null;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const poly of polys) for (const q of poly) {
        u0 = Math.min(u0, q.x); u1 = Math.max(u1, q.x);
        v0 = Math.min(v0, q.y); v1 = Math.max(v1, q.y);
      }
      return { u0, u1, v0, v1 };
    };
    const floorBase = (floorId: string) => project.drawingLevels.find((l) => l.id === floorId)?.baseElevation ?? 0;
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
      const w = op && project.walls.find((x) => x.id === op.hostWallId);
      const bb = op && bbox("opening", op.id);
      if (!op || !w || !bb || op.locked) return [];
      const base = floorBase(w.floorId);
      const mid = (bb.u0 + bb.u1) / 2;
      const out: SheetHeightGrip[] = [
        { kind: "openingTop", id: op.id, pt: { x: mid, y: bb.v1 }, u0: bb.u0, u1: bb.u1, base, top: bb.v1, bottom: bb.v0 },
      ];
      if (op.kind === "window") {
        out.push({ kind: "openingBottom", id: op.id, pt: { x: mid, y: bb.v0 }, u0: bb.u0, u1: bb.u1, base, top: bb.v1, bottom: bb.v0 });
      }
      return out;
    }
    if (selectedWallId && selectedWallIds.length <= 1) {
      const w = project.walls.find((x) => x.id === selectedWallId);
      const bb = w && bbox("wall", w.id);
      if (!w || !bb || w.locked) return [];
      return [
        { kind: "wallTop", id: w.id, pt: { x: (bb.u0 + bb.u1) / 2, y: bb.v1 }, u0: bb.u0, u1: bb.u1, base: floorBase(w.floorId), top: bb.v1, bottom: bb.v0 },
      ];
    }
    return [];
  })();

  const grips: Vec2[] = (() => {
    // Öffnung (Fenster/Tür): EIN Mittelpunkt-Griff auf der Wandachse. Ziehen
    // verschiebt die Öffnung entlang der Wirts-Wand (siehe applyGrip →
    // `position`). Nur bei genau einer selektierten Öffnung (Auswahl exklusiv).
    if (!modelEditable && effectiveDrawingIds.length === 0) {
      sheetHeightGrips.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, sheetHeightGrips.length - 1]); });
      return sheetHeightGrips.map((g) => g.pt);
    }
    if (selectedOpeningId && modelEditable) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
      // Dach-/Deckenfenster ([103]): Mitte (verschieben), Breite quer, Höhe im Gefälle.
      if (op && (op.hostRoofId || op.hostCeilingId)) {
        const info = surfaceOpeningInfo(project, op.id);
        if (!info) return [];
        const pts = surfaceOpeningGrips(info, op.width, op.height);
        pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
        return pts;
      }
      const w = op && project.walls.find((x) => x.id === op.hostWallId);
      if (op && w) {
        const pt = openingGripPoint(w, op);
        gripOwners.push({ localIndex: 0 });
        gripOwnerRange.push([0, 0]);
        return [pt];
      }
      return [];
    }
    // Treppe: EIN Bewegpunkt (siehe stairMoveHandle); Ziehen verschiebt die
    // ganze Treppe (applyGrip → moveStairBy). Auswahl exklusiv.
    if (selectedStairId && modelEditable) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      if (!st) return [];
      // [151] Podesttreppen: dazu die Parameter-Griffe (Lauf-Enden, Podestrand).
      const pts = [stairMoveHandle(st), ...stairParamPoints(st)];
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    if (selectedTree && modelEditable && !selectedTree.locked) {
      const pts = treeGrips(selectedTree);
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    // [68] Baugrube: Umriss-Ecken + Sohlen-Griff (Lage: Schwerpunkt, y um die Sohlenhöhe versetzt).
    if (modelEditable && selectedExcavation && !selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      const pts = excavationGripPoints(selectedExcavation);
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    // Decke: die Umriss-Vertices als Griffe (nur bei genau einer gewählten Decke,
    // solange kein 2D-Element/Wand mitgewählt ist — kein Multi-Select für Decken).
    if (modelEditable && selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      const pts = [...selectedCeiling.outline];
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    // Raum: die Umriss-Vertices als Griffe (nur bei genau einem gewählten Raum).
    if (
      modelEditable &&
      selectedRoom &&
      effectiveDrawingIds.length === 0 &&
      selectedWallIds.length === 0 &&
      !selectedCeiling
    ) {
      const pts = [...selectedRoom.boundary];
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    // Mehrfachauswahl (Regel- UND Standardfall): je gewähltem 2D-Element bzw.
    // je gewählter Wand ein eigener, in sich zusammenhängender Vertex-Block.
    // Wand UND 2D-Element schliessen sich weiterhin gegenseitig aus (wie schon
    // bei der Auswahl selbst — s. die vielen `!selectedDrawingId`-Wächter, die
    // dieses Modul vorher hatte).
    const out: Vec2[] = [];
    const pushGroup = (
      pts: Vec2[],
      owner: { drawingId?: string; wallId?: string },
      keep?: (localIndex: number) => boolean,
    ) => {
      if (pts.length === 0) return;
      const start = out.length;
      pts.forEach((p, i) => {
        if (keep && !keep(i)) return;
        out.push(p);
        gripOwners.push({ ...owner, localIndex: i });
      });
      if (out.length === start) return;
      const end = out.length - 1;
      for (let i = start; i <= end; i++) gripOwnerRange.push([start, end]);
    };
    for (const id of gripDrawingIds) {
      const d = project.drawings2d.find((x) => x.id === id);
      if (!d) continue;
      // Polylinie (ArchiCAD-artig): Segment-Mitten-Griffe NUR an Bogen-Segmenten —
      // ein gerades Segment soll beim Anfassen nicht versehentlich zum Bogen werden.
      // Bögen entstehen gezielt über den Punkttyp (Kontextmenü: Bogen-/Splinepunkt).
      const g = d.geom;
      const keep =
        g.shape === "polyline"
          ? (i: number) => i < g.pts.length || Math.abs(g.bulge?.[i - g.pts.length] ?? 0) > 1e-9
          : undefined;
      pushGroup(drawingVertices(d, scaleDenominator), { drawingId: id }, keep);
    }
    if (modelEditable && effectiveDrawingIds.length === 0) {
      for (const id of selectedWallIds) {
        const w = project.walls.find((x) => x.id === id);
        // Bogenwand ([T2]): dritter Griff im Bogenscheitel (zieht den Bogen durch den Punkt).
        if (w) pushGroup(wallGripPoints(w), { wallId: id });
      }
    }
    return out;
  })();

  // Bezier-Hilfslinien (Anker → Kontrollpunkt-Griff), gestrichelt gerendert,
  // damit sichtbar/nachvollziehbar ist, welcher Griff welchen Kurvenabschnitt
  // steuert (Nutzer-Wunsch: „Hilfslinien sollten schon sichtbar sein um sie
  // zu steuern" — wie bei Illustrator/Inkscape üblich). `pts` folgt dem Muster
  // Anker·Griff·Griff·Anker·… (s. `Drawing2DGeom["bezier"]`); jeder Anker
  // bekommt eine Linie zu seinem/seinen benachbarten Griff(en).
  const gripHandleLines: { a: Vec2; b: Vec2 }[] = (() => {
    const out: { a: Vec2; b: Vec2 }[] = [];
    for (const id of gripDrawingIds) {
      const d = project.drawings2d.find((x) => x.id === id);
      const g = d?.geom;
      if (!g || g.shape !== "bezier") continue;
      for (let i = 0; i + 3 < g.pts.length; i += 3) {
        out.push({ a: g.pts[i], b: g.pts[i + 1] }); // Anker → Griff 1
        out.push({ a: g.pts[i + 3], b: g.pts[i + 2] }); // nächster Anker → Griff 2
      }
    }
    return out;
  })();

  // Einheitsrichtung der Wirtswand, wenn eine Wandöffnung gewählt ist (sonst null).
  const openingWallDir = (): Vec2 | null => {
    if (!selectedOpeningId) return null;
    const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
    const w = op && !op.hostRoofId && !op.hostCeilingId ? project.walls.find((x) => x.id === op.hostWallId) : undefined;
    if (!w || !op) return null;
    // Sehne über die Öffnung (gerade Wand: Wandrichtung; Bogenwand: ≈ Tangente in der Öffnungsmitte).
    const a = openingGripPoint(w, { position: op.position - op.width / 2, width: op.width });
    const b = openingGripPoint(w, { position: op.position + op.width / 2, width: op.width });
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len } : null;
  };

  // Nachbar-Griff-Index INNERHALB desselben Elements (für Anker-Auflösung).
  // null = kein Nachbar möglich (Einzelgriff-Element wie Kreis/Öffnung/Treppe).
  const neighborGripIndex = (index: number): number | null => {
    const range = gripOwnerRange[index];
    if (!range) return null;
    const [start, end] = range;
    if (index > start) return index - 1;
    if (end > start) return start + 1;
    return null;
  };

  // Pro Seite JEDES gewählten Elements ein Griff: Kanten-Mittelpunkt + nach
  // AUSSEN zeigende Einheitsnormale + die beiden lokalen Vertex-Indizes +
  // `owner` (welchem Element diese Kante gehört — Mehrfachauswahl). Die
  // Außenrichtung wird über das Vorzeichen des Skalarprodukts der Kanten-
  // Normale mit (mid − centroid) gewählt (vom Polygon-Schwerpunkt weg).
  //  • rect: 4 Kanten (geschlossen).
  //  • polyline mit `closed`: Kanten zwischen aufeinanderfolgenden Vertices
  //    inkl. Schlusskante (letzter → erster).
  //  • Wand: eine Kante [0,1]; Außennormale = leftNormal der Achse. Ziehen
  //    verschiebt beide Enden (ganze Wand senkrecht).
  //  • offene Polylinie/Linie: je Segment ein Kanten-Griff. Ziehen verschiebt DAS
  //    Segment (seine beiden Endpunkte) um das volle Drag-Delta — die geteilten
  //    Ecken wandern mit, die Nachbar-Segmente dehnen sich nach (Parallel-
  //    Verschieben EINER Kante einer komplexen Polylinie, §Task B).
  const edgeGrips: EdgeGrip[] = (() => {
    // ringEdges/openEdges/polylineEdgeGrips: Kern (`geometry/grips.ts`, `grips.rs`).
    if (modelEditable && selectedExcavation && !selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      return ringEdges(selectedExcavation.outline, {});
    }
    // Decke: geschlossener Ring aus dem Umriss (Auswahl exklusiv, wie bei grips).
    if (modelEditable && selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      return ringEdges(selectedCeiling.outline, {});
    }
    // Raum: geschlossener Ring aus dem Umriss.
    if (
      modelEditable &&
      selectedRoom &&
      effectiveDrawingIds.length === 0 &&
      selectedWallIds.length === 0 &&
      !selectedCeiling
    ) {
      return ringEdges(selectedRoom.boundary, {});
    }
    const out: EdgeGrip[] = [];
    for (const id of gripDrawingIds) {
      const d = project.drawings2d.find((x) => x.id === id);
      if (!d) continue;
      const verts = drawingVertices(d, scaleDenominator);
      const g = d.geom;
      const owner = { drawingId: id };
      if (g.shape === "rect" || g.shape === "image") out.push(...ringEdges(verts, owner));
      else if (g.shape === "polyline") out.push(...polylineEdgeGrips(g, owner));
      else if (g.shape === "spline" && g.closed) out.push(...ringEdges(verts, owner));
      else if (g.shape === "spline" && !g.closed) out.push(...openEdges(verts, owner));
      else if (g.shape === "line") out.push(...openEdges(verts, owner));
    }
    if (modelEditable && effectiveDrawingIds.length === 0) {
      for (const id of selectedWallIds) {
        const w = project.walls.find((x) => x.id === id);
        if (!w) continue;
        const mid: Vec2 = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
        const nrm = normalize(leftNormal(sub(w.end, w.start)));
        out.push({ mid, normal: nrm, aIndex: 0, bIndex: 1, owner: { wallId: id } });
      }
    }
    return out;
  })();

  // Bereits angewandtes 2D-Delta seit Grab-Beginn eines Kanten-Drags, relativ
  // zum ORIGINALEN Kanten-Mittelpunkt (`edge.mid` — die beim Grab erfasste
  // Momentaufnahme, ändert sich während des Drags nicht). null = noch kein
  // Move-Event verarbeitet (erstes Event verankert nur, kein Sprung). Ein
  // ABSOLUTER Zielpunkt (aus Maus ODER gelocktem Feldwert) wird jeden Frame neu
  // berechnet; angewandt wird nur die Differenz zum zuletzt angewandten Delta
  // (moveEdgeOf/moveRoomEdge/moveCeilingEdge sind additiv). Dieselbe Formel
  // trägt sowohl den geführten (Normalen-)Fall als auch den freien Fall — vorher
  // zwei getrennte, rein inkrementelle Mechanismen ohne Bezug zum Ursprung, was
  // eine getippte Ziel-Distanz (s. edgeEdit unten) unmöglich gemacht hätte.
  const edgeAppliedDeltaRef = useRef<Vec2 | null>(null);
  // Körper-Verschieben (2D): koinzidente Endpunkte ANDERER gewählter Elemente, die
  // an einer Ecke des verschobenen Elements hängen, werden um dasselbe Delta
  // mitgeführt (gemeinsame Ecke bleibt verbunden). Lazy beim ersten Move-Event
  // bestimmt (Snapshot der Selektion), je Drag in onGripEnd zurückgesetzt. null =
  // noch nicht bestimmt.
  const moveCoincidentRef = useRef<{ drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[] | null>(null);
  // Eckpunkte eines selektierten Elements (Wand: start/end; 2D: drawingVertices).
  const elementCorners = (drawingId: string | null, wallId: string | null): Vec2[] => {
    if (drawingId) {
      const d = project.drawings2d.find((x) => x.id === drawingId);
      return d ? drawingVertices(d, scaleDenominator) : [];
    }
    if (wallId) {
      const w = project.walls.find((x) => x.id === wallId);
      return w ? [w.start, w.end] : [];
    }
    return [];
  };
  // Koinzidente Sibling-Vertices (unter den ÜBRIGEN gewählten Elementen) an JEDER Ecke des verschobenen
  // Elements (Kern `coincidentGripPoints`, Toleranz wie beim 3D-Drag): hier nur die Kandidaten sammeln.
  type CoincidentVertex = { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 };
  const findMoveCoincident2D = (selfDrawingId: string | null, selfWallId: string | null): CoincidentVertex[] => {
    const corners = elementCorners(selfDrawingId, selfWallId);
    if (corners.length === 0) return [];
    const owners: { drawingId: string | null; wallId: string | null }[] = [];
    const groups: Vec2[][] = [];
    for (const id of selectedWallIds) {
      const w = id !== selfWallId ? project.walls.find((x) => x.id === id) : undefined;
      if (w) { owners.push({ drawingId: null, wallId: id }); groups.push([w.start, w.end]); }
    }
    for (const id of selectedDrawingIds) {
      const d = id !== selfDrawingId ? project.drawings2d.find((x) => x.id === id) : undefined;
      if (d) { owners.push({ drawingId: id, wallId: null }); groups.push(drawingVertices(d, scaleDenominator)); }
    }
    return coincidentGripPoints(corners, groups).map(({ group, index }) => ({ ...owners[group], index, pos: { ...groups[group][index] } }));
  };

  // Editieren läuft AD-HOC (gripHandlers → moveGripOf), NICHT durch die Engine.
  // Damit „Tab → Länge/Winkel" wie beim Zeichnen funktioniert, ohne die Engine
  // umzubauen, hält App einen kleinen FELD-Controller, der NUR während eines
  // Vertex-Griff-Drags aktiv ist: er belegt das Befehlsfeld (Prompt/Felder/
  // Eingabe) und liefert gelockte Länge/Winkel relativ zum Anker (Nachbarecke).
  // `onGripMove` liest diese Locks und zwingt den Zielpunkt darauf — so setzt ein
  // getippter Wert den exakten Endpunkt. Foundation: heute 2D-Vertex; dieselbe
  // Lock-Auflösung (polar um den Anker) ist auf 3D-Vertex/Körper erweiterbar.
  const [gripEdit, setGripEdit] = useState<{
    /** Fixer Bezug (Nachbarecke), relativ zu dem Länge/Winkel gelten. */
    anchor: Vec2;
    /** Aktives Tab-Feld (zyklt length ↔ angle). */
    active: "length" | "angle";
    /** Gelockte Werte (getippt). length in m, angle in Grad. */
    locks: { length?: number; angle?: number };
  } | null>(null);
  // Live-Spiegel für Handler ohne Re-Render-Abhängigkeit (Drag liest synchron).
  const gripEditRef = useRef<typeof gripEdit>(null);
  gripEditRef.current = gripEdit;
  // Letzter roher Cursor des laufenden Vertex-Drags (für die Lock-Auflösung beim
  // Tippen, wenn gerade kein Move-Event kommt). Plus der gezogene Griff-Index.
  const gripDragInfoRef = useRef<{ index: number; raw: Vec2 } | null>(null);
  // AUSSTEHENDER Vertex-Zug eines Polylinien-Elements: Während des Ziehens wird das
  // PROJEKT NICHT verändert (sonst rechnet jede Mausbewegung den ganzen Plan neu —
  // bei Katasterdaten Sekunden); nur eine Vorschau (`gripPreviewShapes`) wird
  // gezeichnet. Erst beim Setzen des Punkts (onGripEnd) geht EINE Mutation ins Projekt.
  const pendingGripRef = useRef<{ drawingId: string; localIndex: number; flat: number; pt: Vec2 } | null>(null);
  // Dasselbe für das Verschieben eines ganzen 2D-Elements (Gesamt-Delta) und für
  // Kanten-Griffe von Polylinien (Ziel-Delta): bis zum Loslassen nur Vorschau.
  const pendingWallGripRef = useRef<{ wallId: string; localIndex: number; flat: number; pt: Vec2 } | null>(null);
  const pendingAreaGripRef = useRef<{ kind: "room" | "ceiling" | "excavation"; id: string; index: number; flat: number; pt: Vec2 } | null>(null);
  const pendingAreaMoveRef = useRef<{ kind: "ceiling" | "room" | "stair"; id: string; total: Vec2 } | null>(null);
  const pendingWallMoveRef = useRef<{ wallId: string; total: Vec2 } | null>(null);
  /** Aufgeschobene Öffnungs-Verschiebung im Schnitt/in der Ansicht (neue `position`). */
  const pendingOpeningMoveRef = useRef<{ id: string; position: number } | null>(null);
  /** Aufgeschobene Höhen-Änderung im Schnitt (Wand `height` bzw. Öffnung `height`/`sillHeight`). */
  const pendingSheetHeightRef = useRef<{ kind: "wall" | "opening"; id: string; patch: Record<string, number> } | null>(null);
  /** Laufendes Blatt-Delta (u, Meter) eines Zugs im Schnitt (s. moveInSheet). */
  const sheetDuRef = useRef<{ id: string; du: number } | null>(null);
  const pendingBodyRef = useRef<{ drawingId: string; total: Vec2 } | null>(null);
  const pendingEdgeRef = useRef<{ edge: EdgeGrip; delta: Vec2 } | null>(null);
  // Position des gezogenen Griffs VOR dem Drag (beim ersten Move-Event nach dem
  // Grab verankert) — Bezugspunkt für die Flucht-Kandidaten unten (die
  // Nachbarkanten müssen an ihrer URSPRÜNGLICHEN, nicht der schon verschobenen
  // Position gemessen werden, sonst würde die Richtung während des Ziehens
  // mitdriften).
  const gripOriginRef = useRef<Vec2 | null>(null);
  // [144] Lage (`position`) der gewählten Wandöffnung beim Greifen: Bezug der getippten Bogenlänge.
  const gripOpeningPos0Ref = useRef<{ position: number; dir: Vec2 } | null>(null);

  // Endpunkt aus Anker + (gelockten/Live-)Länge/Winkel (Kern `gripPolarPoint`) — wie lineEndFromFields.
  const gripEditPoint = gripPolarPoint;

  // Felder fürs Befehlsfeld während des Vertex-Drags (Live ODER gelockt).
  const gripEditFields = (): GripEditFieldsState[] => {
    const ge = gripEdit;
    const info = gripDragInfoRef.current;
    if (!ge || !info) return [];
    return polarFields(ge, gripPolar(ge.anchor, info.raw));
  };

  // Fixer Bezug (Anker) für Länge/Winkel eines gezogenen Punkt-Griffs. Normal
  // die BENACHBARTE Ecke DESSELBEN Elements (Polylinien-Semantik) — bei Kreis/
  // Bogen ist das falsch (deren Griffe liegen auf dem Ring, "Länge" muss der
  // RADIUS sein, also relativ zum ZENTRUM). Ohne diesen Sonderfall blieb der
  // Kreis-Radius-Griff sogar ganz ohne Anker (nur 1 Griff, kein Nachbar).
  // Gemeinsam genutzt vom Tab-Feld-Controller UND dem Shift-Ortho-Bezug UND
  // dem Cursor-HUD (Länge/Winkel-Anzeige neben der Maus).
  const resolveGripAnchor = (index: number): Vec2 | null => {
    // Wandöffnung ([144]): einziger Griff (Mitte) — Bezug ist seine Lage beim Greifen, die getippte
    // Länge ist also die Verschiebung entlang der Wand.
    const wallOpening = openingWallDir();
    if (wallOpening) return gripOriginRef.current ?? grips[index] ?? null;
    // Bei Mehrfachauswahl gehört der gezogene Griff evtl. NICHT dem einzeln
    // selektierten `selectedDrawing`, sondern einem anderen Element der
    // Auswahl — das eigentliche Element über `gripOwners` auflösen.
    const owner = gripOwners[index];
    const ownerDrawing = owner?.drawingId
      ? project.drawings2d.find((d) => d.id === owner.drawingId)
      : selectedDrawing;
    const g = ownerDrawing?.geom;
    if (g && (g.shape === "circle" || g.shape === "arc" || g.shape === "ellipse")) return g.center;
    const refIndex = neighborGripIndex(index);
    return refIndex != null ? grips[refIndex] : null;
  };

  // Punkte + Ring-Art des Elements eines gezogenen Punkt-Griffs — für die Flucht-Kandidaten des Shift-
  // Achsen-Locks (Kern `gripAxisLock`: Welt-H/V plus die Flucht der beiden fixen Nachbarkanten). Geschlossen:
  // rect/geschlossene Polylinie/Raum/Decke (Nachbar 0/n-1 wickelt um); offen: Polylinie/Linie. Kreis/Bogen/
  // Wand/Öffnung/Treppe haben keine Polygon-Nachbarn → null.
  const resolvePolygonRing = (index: number): { pts: Vec2[]; index: number; closed: boolean } | null => {
    const owner = gripOwners[index];
    if (!owner?.drawingId && !owner?.wallId) {
      // Raum/Decke (exklusiv) — kein Owner, `localIndex` fehlt dann auch, also
      // ist der flache `index` selbst der Ring-Index.
      const pts = selectedExcavation && !selectedCeiling
        ? selectedExcavation.outline
        : selectedCeiling
        ? selectedCeiling.outline
        : selectedRoom
        ? selectedRoom.boundary
        : null;
      return pts ? { pts, index: owner?.localIndex ?? index, closed: true } : null;
    }
    if (owner.wallId) return null; // Wand: nur 2 Punkte, kein Vielecks-Nachbar
    const g = project.drawings2d.find((x) => x.id === owner.drawingId)?.geom;
    if (!g) return null;
    const i = owner.localIndex;
    if (g.shape === "polyline" || g.shape === "spline") return { pts: g.pts, index: i, closed: !!g.closed };
    if (g.shape === "rect" || g.shape === "image") {
      return { pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }], index: i, closed: true };
    }
    if (g.shape === "line") return { pts: [g.a, g.b], index: i, closed: false };
    return null; // circle/arc: kein Vielecks-Eckpunkt
  };

  // Stabiler Ref auf cycleGripEditField (der globale Tab-Handler hat leere Deps).
  const cycleGripEditFieldRef = useRef<() => void>(() => {});
  // Tab im Vertex-Drag: Feld-Controller öffnen/zyklen (length ↔ angle).
  //  • ÖFFNEN (noch kein gripEdit): friert BEIDE Werte an der aktuellen
  //    Position ein (`locks` sofort vollständig befüllt statt leer) — die
  //    Maus hat ab jetzt keinen Einfluss mehr, bis man explizit wieder in ein
  //    Feld tabbt (verhindert, dass ein Zittern der Hand beim Greifen zur
  //    Tastatur den Punkt noch verschiebt).
  //  • ZYKELN (gripEdit schon offen): wechselt zum anderen Feld und LÖST
  //    dessen Lock (frei für die Maus) — das Feld, das man verlässt, bleibt
  //    exakt auf seinem letzten Wert fixiert (getippt oder eingefroren).
  //    Nutzer-Wunsch: nach dem ersten getippten Wert soll das ANDERE Feld
  //    nicht sofort wieder der Maus folgen, sondern erst nach explizitem Tab
  //    dorthin — sonst „wird der Winkel nie richtig fix".
  const cycleGripEditField = () => {
    const info = gripDragInfoRef.current;
    if (!info) return;
    const anchor = resolveGripAnchor(info.index);
    if (!anchor) return; // ohne Anker keine polare Eingabe möglich
    const wallDir = openingWallDir();
    setGripEdit((prev) => {
      if (!prev && wallDir) {
        // Öffnung ([144]): Richtung = Wandrichtung (bzw. Gegenrichtung, je nach bisherigem Zug), damit
        // die getippte Länge genau die Strecke entlang der Wand ist.
        // Bogenwand: Länge = bisher gezogene Bogenlänge, Richtung = Wandrichtung beim Greifen.
        const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
        const arc = !!project.walls.find((x) => x.id === op?.hostWallId)?.bulge;
        const at0 = gripOpeningPos0Ref.current;
        const dir = arc && at0 ? at0.dir : wallDir;
        const g = grips[info.index];
        const along = arc && at0 && op ? op.position - at0.position : (g.x - anchor.x) * wallDir.x + (g.y - anchor.y) * wallDir.y;
        const deg = (Math.atan2(dir.y, dir.x) * 180) / Math.PI + (along < 0 ? 180 : 0);
        return { anchor, active: "length", locks: { length: Math.abs(along), angle: ((deg % 360) + 360) % 360 } };
      }
      if (!prev) {
        const { length, angleDeg: angle } = gripPolar(anchor, grips[info.index]);
        return { anchor, active: "length", locks: { length, angle } };
      }
      const active = prev.active === "length" ? "angle" : "length";
      const locks = { ...prev.locks };
      delete locks[active];
      return { ...prev, active, locks };
    });
  };
  cycleGripEditFieldRef.current = cycleGripEditField;

  // Getippte Zahl im Vertex-Drag: aktives Feld locken, aufs nächste vorrücken
  // (das andere Feld bleibt unverändert fixiert, s. o.).
  const submitGripEditValue = (value: number) => {
    const ge = gripEditRef.current;
    const info = gripDragInfoRef.current;
    if (!ge || !info) return;
    const locks = { ...ge.locks, [ge.active]: value };
    const next = ge.active === "length" ? "angle" : "length";
    setGripEdit({ ...ge, locks, active: next });
    // Zielpunkt mit dem frischen Lock anwenden (live, ohne Maus-Bewegung).
    const pt = gripEditPoint(ge.anchor, locks, info.raw);
    applyGripEdit(info.index, pt, ge.anchor, locks.length);
  };

  // Zielpunkt des Feld-Controllers anwenden. [144] Öffnung in einer Bogenwand: die getippte Länge ist
  // die Bogenlänge ab der Lage beim Greifen (nicht die Strecke entlang der Sehne).
  const applyGripEdit = (index: number, pt: Vec2, anchor: Vec2, length: number | undefined) => {
    const op = selectedOpeningId ? (project.openings ?? []).find((o) => o.id === selectedOpeningId) : undefined;
    const host = op && !op.hostRoofId && !op.hostCeilingId ? project.walls.find((x) => x.id === op.hostWallId) : undefined;
    const at0 = gripOpeningPos0Ref.current;
    if (op && !op.locked && host?.bulge && at0 && length != null) {
      slideOpening(op.id, { position: openingTypedPosition(at0.position, length, anchor, pt, at0.dir) }, `slideOpening:${op.id}`);
    } else applyGrip(index, pt);
  };

  // Feld-Controller schließen (Escape MIT Fokus in der Befehlszeile, s.
  // App.tsx) — beendet NICHT den ganzen Griff-Drag (der bleibt bewaffnet,
  // Maus steuert wieder normal wie vor dem ersten Tab).
  const closeGripEditField = () => {
    setGripEdit(null);
  };

  // Dasselbe Feld-Controller-Muster wie oben (gripEdit), jetzt für einen Kanten-
  // Griff (Dreieck-Anfasser, „Seite parallel verschieben"). Ein Feld genügt für
  // geführte Kanten (rect/geschlossene Polylinie/Wand — Bewegung ist auf die
  // Normale beschränkt, "Länge" ist der vorzeichenbehaftete Abstand); freie
  // Kanten (offene Polylinie/Linie) bekommen wie ein Punkt-Griff Länge+Winkel.
  const [edgeEdit, setEdgeEdit] = useState<{
    /** Kanten-Mittelpunkt bei Grab-Beginn (fix für die ganze Dauer des Drags). */
    anchor: Vec2;
    active: "length" | "angle";
    locks: { length?: number; angle?: number };
  } | null>(null);
  const edgeEditRef = useRef<typeof edgeEdit>(null);
  edgeEditRef.current = edgeEdit;
  // Letzter roher Cursor + der gezogene Kanten-Griff (Momentaufnahme vom Grab).
  const edgeDragInfoRef = useRef<{ edge: EdgeGrip; raw: Vec2 } | null>(null);

  // Zielpunkt aus Anker (= `edge.mid`) + (gelockten/Live-)Werten — bei freien Kanten wie ein Punkt-Griff
  // (polar), bei geführten Kanten nur entlang der festen Normale (Kern `gripEdgeTarget`).
  const edgeEditPoint = (edge: EdgeGrip, locks: GripLocks, raw: Vec2): Vec2 => gripEdgeTarget(edge, raw, { locks });

  // Felder fürs Befehlsfeld während des Kanten-Drags. Geführte Kanten zeigen
  // NUR "Länge" (kein Winkel — der ist durch die feste Normale vorgegeben).
  const edgeEditFields = (): GripEditFieldsState[] => {
    const ee = edgeEdit;
    const info = edgeDragInfoRef.current;
    if (!ee || !info) return [];
    const { edge, raw } = info;
    const live = gripPolar(ee.anchor, raw, edge.normal);
    if (!edge.free) {
      return [{ id: "length", labelKey: "cmd.field.length", value: ee.locks.length ?? live.offset, locked: ee.locks.length != null, active: true }];
    }
    return polarFields(ee, live);
  };

  const cycleEdgeEditFieldRef = useRef<() => void>(() => {});
  // Tab im Kanten-Drag: Feld-Controller öffnen/zyklen — dasselbe Muster wie
  // cycleGripEditField oben (Öffnen friert BEIDE Werte ein, Zykeln löst NUR
  // das neu aktive Feld). Geführte Kanten haben nur ein Feld ("Länge" =
  // Abstand entlang der Normale) → Zykeln tut dort nichts, das eine Feld
  // bleibt beim Öffnen ohnehin schon eingefroren/fixiert.
  const cycleEdgeEditField = () => {
    const info = edgeDragInfoRef.current;
    if (!info) return;
    const { edge, raw } = info;
    setEdgeEdit((prev) => {
      if (!prev) {
        const anchor = edge.mid;
        const frozen = gripPolar(anchor, edgeEditPoint(edge, {}, raw), edge.normal);
        if (edge.free) return { anchor, active: "length", locks: { length: frozen.length, angle: frozen.angleDeg } };
        return { anchor, active: "length", locks: { length: frozen.offset } };
      }
      if (!edge.free) return prev; // geführte Kante: nur ein Feld, nichts zu zykeln
      const active = prev.active === "length" ? "angle" : "length";
      const locks = { ...prev.locks };
      delete locks[active];
      return { ...prev, active, locks };
    });
  };
  cycleEdgeEditFieldRef.current = cycleEdgeEditField;

  // Globaler Tab-Handler (Feld-Zyklus/Zahlen-Tippen, Punkt- UND Kanten-Griff) —
  // siehe state/useKeyboardShortcuts.ts.
  useCommandTabShortcut(
    engineRef,
    commandLineRef,
    gripDragInfoRef,
    gripEditRef,
    cycleGripEditFieldRef,
    edgeDragInfoRef,
    edgeEditRef,
    cycleEdgeEditFieldRef,
  );

  // Getippte Zahl im Kanten-Drag: Feld locken, bei freien Kanten aufs nächste
  // Feld vorrücken, Zielpunkt sofort mit dem gelockten Wert neu anwenden.
  const submitEdgeEditValue = (value: number) => {
    const ee = edgeEditRef.current;
    const info = edgeDragInfoRef.current;
    if (!ee || !info) return;
    const { edge, raw } = info;
    const locks = { ...ee.locks, [ee.active]: value };
    const next = edge.free ? (ee.active === "length" ? "angle" : "length") : ee.active;
    setEdgeEdit({ ...ee, locks, active: next });
    const pt = edgeEditPoint(edge, locks, raw);
    applyEdgeToward(edge, ee.anchor, pt);
  };

  // Feld-Controller schließen (Escape MIT Fokus in der Befehlszeile) — beendet
  // NICHT den Kanten-Drag (der bleibt bewaffnet, Maus steuert wieder normal).
  const closeEdgeEditField = () => {
    setEdgeEdit(null);
  };

  // Editier-Dispatch: bei gewählter Decke auf die Decken-Aktionen umleiten, sonst
  // auf die Wand/2D-Aktionen. So teilen Plan- UND 3D-Griffe denselben Pfad.
  const applyGrip = (index: number, pt: Vec2) => {
    // Öffnung: den gezogenen Punkt auf die Wandachse projizieren → neue
    // `position` (Abstand des ersten Pfostens vom Wand-Start), sodass die
    // Öffnung entlang der Wand gleitet. Griff sitzt in der Öffnungsmitte, daher
    // width/2 abziehen; auf [0, Wandlänge − Breite] klemmen (Öffnung bleibt drin).
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
      if (op && (op.hostRoofId || op.hostCeilingId)) {
        const info = op.locked ? null : surfaceOpeningInfo(project, op.id);
        const outline = op.hostRoofId
          ? (project.roofs ?? []).find((r) => r.id === op.hostRoofId)?.outline
          : (project.ceilings ?? []).find((c) => c.id === op.hostCeilingId)?.outline;
        const patch = info && surfaceOpeningGripPatch(info, index, pt, outline);
        if (patch) updateOpening(op.id, patch);
        return;
      }
      // Wandöffnung ([144]): der Kern projiziert auf die Achse (Bogenwand: auf den Bogen), klemmt auf
      // die Wand und hält vor der Nachbaröffnung an.
      if (op && !op.locked) slideOpening(op.id, { pt }, `slideOpening:${op.id}`);
      return;
    }
    // Treppe: den Bewegpunkt verfolgen → ganze Treppe um das Delta (Ziel −
    // aktueller Handle) verschieben. Handle wird identisch zu grips gebildet,
    // sodass er nach dem Move exakt unter dem Cursor sitzt.
    if (selectedStairId) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      if (st && index > 0) opts.dragStairParam?.(st.id, index - 1, pt);
      else if (st) moveStairBy(st.id, sub(pt, stairMoveHandle(st)));
      return;
    }
    // [149] Baum: Stammmitte, Kronenrand bzw. Beschriftung live, ein Undo-Schritt je Zug (gleicher coalesceKey).
    if (selectedTree) {
      const tr = selectedTree;
      if (tr.locked) return;
      const patch = treeGripPatch(tr, index, pt);
      storeState().applyChange((p) => patchItem(p, "trees", tr.id, patch), `treeGrip:${tr.id}:${index}`);
      return;
    }
    // [68] Baugrube: Sohlen-Griff sofort (Höhe), Ecken als Vorschau bis zum Setzen.
    if (selectedExcavation && !selectedCeilingId && !selectedRoomId) {
      if (index >= selectedExcavation.outline.length) moveExcavationGrip(selectedExcavation.id, index, pt);
      else pendingAreaGripRef.current = { kind: "excavation", id: selectedExcavation.id, index, flat: index, pt };
      return;
    }
    // Raum/Decke: Eckpunkt-Zug nur als Vorschau, Projekt erst beim Setzen.
    if (selectedRoomId || selectedCeilingId) {
      pendingAreaGripRef.current = selectedRoomId
        ? { kind: "room", id: selectedRoomId, index, flat: index, pt }
        : { kind: "ceiling", id: selectedCeilingId!, index, flat: index, pt };
      return;
    }
    if (selectedRoomId) moveRoomGrip(selectedRoomId, index, pt);
    else if (selectedCeilingId) moveCeilingGrip(selectedCeilingId, index, pt);
    else {
      // Mehrfachauswahl: welchem Element dieser Griff gehört, kommt aus
      // `gripOwners` (nicht mehr aus den singulären selectedDrawingId/-WallId).
      const owner = gripOwners[index];
      const dId = owner?.drawingId ?? selectedDrawingId;
      const wId = owner?.wallId ?? selectedWallId;
      const local = owner?.localIndex ?? index;
      // Polylinien-Eckpunkt: nur merken + Vorschau, Projekt erst beim Setzen ändern.
      if (dId && !wId) {
        const d = project.drawings2d.find((x) => x.id === dId);
        if (d && !d.locked && d.geom.shape === "polyline" && local < d.geom.pts.length) {
          pendingGripRef.current = { drawingId: dId, localIndex: local, flat: index, pt };
          return;
        }
      }
      // Wand-Endpunkt: ebenso nur Vorschau, Projekt erst beim Setzen.
      if (wId && !dId && local <= 1) {
        const w = project.walls.find((x) => x.id === wId);
        if (w && !w.locked) {
          pendingWallGripRef.current = { wallId: wId, localIndex: local, flat: index, pt };
          return;
        }
      }
      moveGripOf(dId, wId, local, pt, scaleDenominator);
    }
  };

  /** Vorschau-Form des ausstehenden Eckpunkt-Zugs (leer, wenn keiner läuft). */
  const gripPreviewShapes = (): DraftShape[] => {
    const pa = pendingAreaGripRef.current;
    if (pa) {
      const ring =
        pa.kind === "room"
          ? (project.rooms ?? []).find((r) => r.id === pa.id)?.boundary
          : pa.kind === "excavation"
          ? selectedExcavation?.outline
          : (project.ceilings ?? []).find((c) => c.id === pa.id)?.outline;
      if (!ring) return [];
      return [{ kind: "poly", pts: ring.map((q, i) => (i === pa.index ? pa.pt : q)), closed: true }];
    }
    const pw = pendingWallGripRef.current;
    if (pw) {
      const w = project.walls.find((x) => x.id === pw.wallId);
      if (!w) return [];
      const wt = project.wallTypes.find((t) => t.id === w.wallTypeId);
      const th = wt ? wallTypeThickness(wt) : 0.2;
      const a = pw.localIndex === 0 ? pw.pt : w.start;
      const b = pw.localIndex === 0 ? w.end : pw.pt;
      // Bogenwand: der Bogen behält seinen Öffnungswinkel (Bulge), Vorschau als Band samt Achse.
      if (w.bulge) {
        const arc = wallArcBand(a, b, w.bulge, th);
        if (arc) return [{ kind: "poly", pts: arc.band, closed: true }, { kind: "poly", pts: arc.axis, closed: false }];
        return [{ kind: "poly", pts: bulgeArcPoints(a, b, w.bulge), closed: false }];
      }
      return [
        { kind: "poly", pts: wallCorners(a, b, th), closed: true },
        { kind: "line", a, b },
      ];
    }
    const pend = pendingGripRef.current;
    if (!pend) return [];
    const d = project.drawings2d.find((x) => x.id === pend.drawingId);
    if (!d || d.geom.shape !== "polyline") return [];
    const pts = d.geom.pts.map((q, i) => (i === pend.localIndex ? pend.pt : q));
    return [{ kind: "poly", pts, closed: !!d.geom.closed }];
  };

  /** Ausstehenden Zug jetzt in das Projekt schreiben (EINE Mutation). */
  const commitPendingGrip = () => groupChanges(commitPendingGripChanges);
  const commitPendingGripChanges = () => {
    const ph = pendingSheetHeightRef.current;
    pendingSheetHeightRef.current = null;
    if (ph) {
      if (ph.kind === "wall") updateWall(ph.id, ph.patch as Partial<import("../model/types").Wall>);
      else updateOpening(ph.id, ph.patch);
    }
    const pa = pendingAreaGripRef.current;
    pendingAreaGripRef.current = null;
    if (pa) {
      if (pa.kind === "room") moveRoomGrip(pa.id, pa.index, pa.pt);
      else if (pa.kind === "excavation") moveExcavationGrip(pa.id, pa.index, pa.pt);
      else moveCeilingGrip(pa.id, pa.index, pa.pt);
    }
    const pw = pendingWallGripRef.current;
    pendingWallGripRef.current = null;
    if (pw) moveGripOf(null, pw.wallId, pw.localIndex, pw.pt, scaleDenominator);
    const pend = pendingGripRef.current;
    pendingGripRef.current = null;
    if (pend) moveGripOf(pend.drawingId, null, pend.localIndex, pend.pt, scaleDenominator);
  };

  /** Polylinien-Element (nicht gesperrt), dessen Änderung aufgeschoben werden darf. */
  const deferrableDrawing = (id: string | null | undefined) => {
    if (!id) return null;
    const d = project.drawings2d.find((x) => x.id === id);
    return d && !d.locked ? d : null;
  };

  /** Vorschau eines aufgeschobenen Körper-Verschiebens (Element um das Gesamt-Delta versetzt). */
  const bodyPreviewShapes = (): DraftShape[] => {
    const pend = pendingBodyRef.current;
    if (!pend) return [];
    const d = deferrableDrawing(pend.drawingId);
    if (!d) return [];
    const { x: tx, y: ty } = pend.total;
    return drawingMovePreview(project, d.id, { x: tx, y: ty }, scaleDenominator);
  };

  /** Vorschau eines aufgeschobenen Kanten-Zugs (beide Kanten-Ecken um das Delta versetzt). */
  const edgePreviewShapes = (): DraftShape[] => {
    const pend = pendingEdgeRef.current;
    if (!pend) return [];
    const d = deferrableDrawing(pend.edge.owner?.drawingId ?? selectedDrawingId);
    if (!d || d.geom.shape !== "polyline") return [];
    const { aIndex, bIndex } = pend.edge;
    const pts = d.geom.pts.map((q, i) =>
      i === aIndex || i === bIndex ? { x: q.x + pend.delta.x, y: q.y + pend.delta.y } : q,
    );
    return [{ kind: "poly", pts, closed: !!d.geom.closed }];
  };

  /** Aufgeschobenes Körper-Verschieben jetzt ins Projekt schreiben. */
  const commitPendingBody = () => groupChanges(commitPendingBodyChanges);
  const commitPendingBodyChanges = () => {
    const pwm = pendingWallMoveRef.current;
    pendingWallMoveRef.current = null;
    sheetDuRef.current = null;
    if (pwm && (pwm.total.x !== 0 || pwm.total.y !== 0)) {
      moveElementByOf(null, pwm.wallId, pwm.total);
      for (const c of moveCoincidentRef.current ?? []) {
        moveGripOf(c.drawingId, c.wallId, c.index, { x: c.pos.x + pwm.total.x, y: c.pos.y + pwm.total.y }, scaleDenominator);
      }
    }
    const pom = pendingOpeningMoveRef.current;
    pendingOpeningMoveRef.current = null;
    if (pom) slideOpening(pom.id, { position: pom.position });
    const pa = pendingAreaMoveRef.current;
    pendingAreaMoveRef.current = null;
    if (pa && (pa.total.x !== 0 || pa.total.y !== 0)) {
      if (pa.kind === "ceiling") moveCeilingBy(pa.id, pa.total);
      else if (pa.kind === "stair") moveStairBy(pa.id, pa.total);
      else moveRoomBy(pa.id, pa.total);
    }
    const pend = pendingBodyRef.current;
    pendingBodyRef.current = null;
    if (!pend || (pend.total.x === 0 && pend.total.y === 0)) return;
    moveElementByOf(pend.drawingId, null, pend.total);
    for (const c of moveCoincidentRef.current ?? []) {
      moveGripOf(c.drawingId, c.wallId, c.index, { x: c.pos.x + pend.total.x, y: c.pos.y + pend.total.y }, scaleDenominator);
    }
  };

  /** Aufgeschobenen Kanten-Zug jetzt ins Projekt schreiben (EIN additives Delta). */
  const commitPendingEdge = () => {
    const pend = pendingEdgeRef.current;
    pendingEdgeRef.current = null;
    if (!pend || (pend.delta.x === 0 && pend.delta.y === 0)) return;
    applyEdge(pend.edge, pend.delta);
  };
  const applyEdge = (edge: EdgeGrip, delta: Vec2) => {
    if (selectedExcavation && !selectedRoomId && !selectedCeilingId) moveExcavationEdge(selectedExcavation.id, edge.aIndex, edge.bIndex, delta);
    else if (selectedRoomId) moveRoomEdge(selectedRoomId, edge.aIndex, edge.bIndex, delta);
    else if (selectedCeilingId) moveCeilingEdge(selectedCeilingId, edge.aIndex, edge.bIndex, delta);
    else moveEdgeOf(edge.owner?.drawingId ?? selectedDrawingId, edge.owner?.wallId ?? selectedWallId, edge.aIndex, edge.bIndex, delta);
  };
  // Kante auf einen ABSOLUTEN Zielpunkt (relativ zum ORIGINALEN Anker) bewegen —
  // moveEdge* ist additiv, daher nur die Differenz zum zuletzt angewandten Delta
  // anwenden (s. edgeAppliedDeltaRef). Trägt sowohl Maus-geführte Bewegung als
  // auch gelockte Feldwerte UND das Verwerfen (Ziel = Anker selbst → Delta 0,
  // die Differenz zum vorherigen Delta macht die ganze Verschiebung rückgängig).
  const applyEdgeToward = (edge: EdgeGrip, anchor: Vec2, pt: Vec2) => {
    const desired = sub(pt, anchor);
    // Polylinien-Kante: nur Vorschau, das Projekt ändert sich erst beim Setzen.
    if (!selectedRoomId && !selectedCeilingId && !edge.owner?.wallId) {
      const d = deferrableDrawing(edge.owner?.drawingId ?? selectedDrawingId);
      if (d && d.geom.shape === "polyline") {
        pendingEdgeRef.current = { edge, delta: desired };
        return;
      }
    }
    const prev = edgeAppliedDeltaRef.current;
    edgeAppliedDeltaRef.current = desired;
    if (prev === null) return; // erster Event verankert nur (kein Sprung beim Greifen)
    const inc = sub(desired, prev);
    if (inc.x === 0 && inc.y === 0) return;
    applyEdge(edge, inc);
  };

  // Maß-/Winkel-HUD am Cursor für einen gezogenen Punkt-Griff — dieselbe
  // Darstellung wie beim Zeichnen (DraftHud, VW-Stil). Ohne Anker (Einzelgriff-
  // Elemente wie Öffnung/Treppe) gibt es keine sinnvolle Länge/Winkel-Anzeige.
  const hudFor = (index: number, pt: Vec2): NonNullable<ToolDraft["hud"]> | undefined => {
    const anchor = resolveGripAnchor(index);
    if (!anchor) return undefined;
    const { length, angleDeg } = gripPolar(anchor, pt);
    return { at: pt, length, angleDeg };
  };
  // Dasselbe für einen gezogenen Kanten-Griff: freie Kanten zeigen Länge+Winkel
  // (wie ein Punkt-Griff), geführte Kanten nur EINEN Wert (Abstand entlang der
  // Normale) — dafür reicht das HUD-Schema nicht (length+angleDeg gehören
  // zusammen), daher als freier Text `Δ: …m`.
  const edgeHudFor = (edge: EdgeGrip, anchor: Vec2, pt: Vec2): NonNullable<ToolDraft["hud"]> => {
    const { length, angleDeg, offset } = gripPolar(anchor, pt, edge.normal);
    if (edge.free) return { at: pt, length, angleDeg };
    return { at: pt, text: `Δ: ${offset.toFixed(3)}m` };
  };

  // Aufräumen nach Abschluss/Verwerfen eines Griff- ODER Kanten-Drags (geteilt
  // von onGripEnd/onGripCancel/onEdgeEnd/onEdgeCancel — nie beide gleichzeitig
  // aktiv, ein gemeinsames Aufräumen ist daher unschädlich und einfacher).
  const endEditing = () => {
    setDraft(null);
    edgeAppliedDeltaRef.current = null; // Kanten-Drag beendet → Anker zurücksetzen
    moveCoincidentRef.current = null; // Körper-Koinzidenz-Gruppe verwerfen
    gripDragInfoRef.current = null; // (c) Vertex-Drag-Info verwerfen
    pendingGripRef.current = null; // (commitPendingGrip hat sie vorher schon geschrieben)
    pendingWallGripRef.current = null;
    pendingAreaGripRef.current = null;
    pendingAreaMoveRef.current = null;
    pendingWallMoveRef.current = null;
    pendingOpeningMoveRef.current = null;
    sheetDuRef.current = null;
    pendingBodyRef.current = null;
    pendingEdgeRef.current = null;
    gripOriginRef.current = null; // Flucht-Bezugspunkt verwerfen
    gripOpeningPos0Ref.current = null;
    setGripEdit(null); // (c) Feld-Controller schließen
    edgeDragInfoRef.current = null; // Kanten-Drag-Info verwerfen
    setEdgeEdit(null); // Kanten-Feld-Controller schließen
  };

  // Ziehen einer geschnittenen Wand/Decke im Schnitt-Blatt (s. Option `sheet`):
  // nur die waagrechte Komponente zählt (Höhe ist kein Grundriss-Delta). Das
  // Projekt ändert sich — wie im Grundriss — erst beim Loslassen
  // (commitPendingBody: pendingWallMoveRef/pendingAreaMoveRef, Grundriss-Delta).
  const moveInSheet = (
    sh: { levelId: string; uAxis: Vec2 },
    delta: Vec2,
    target?: BodyTarget,
  ) => {
    if (target?.drawingId) {
      // 2D-Element der Ebene selbst: normales Körper-Verschieben im Blatt-Raum.
      const prev = pendingBodyRef.current;
      const total = prev && prev.drawingId === target.drawingId
        ? { x: prev.total.x + delta.x, y: prev.total.y + delta.y }
        : delta;
      if (!deferrableDrawing(target.drawingId)) return;
      if (project.drawings2d.find((x) => x.id === target.drawingId)?.levelId !== sh.levelId) return; // [137] Achsraster
      pendingBodyRef.current = { drawingId: target.drawingId, total };
      setDraft({ preview: bodyPreviewShapes(), vertices: [], snap: null });
      return;
    }
    if (target?.openingId) {
      moveOpeningInSheet(sh, delta, target.openingId);
      return;
    }
    const wallId = target ? target.wallId ?? null : selectedWallId;
    const ceilingId = target ? target.ceilingId ?? null : !wallId ? selectedCeilingId : null;
    const stairId = target ? target.stairId ?? null : !wallId && !ceilingId ? selectedStairId : null;
    const kind = wallId ? "wall" : ceilingId ? "ceiling" : stairId ? "stair" : null;
    const id = wallId ?? ceilingId ?? stairId;
    if (!kind || !id) return;
    if (kind === "wall" && project.walls.find((w) => w.id === id)?.locked) return;
    const prevDu = sheetDuRef.current && sheetDuRef.current.id === id ? sheetDuRef.current.du : 0;
    const du = prevDu + delta.x;
    sheetDuRef.current = { id, du };
    const total = scale(sh.uAxis, du);
    if (kind === "wall") {
      if (moveCoincidentRef.current === null) moveCoincidentRef.current = findMoveCoincident2D(null, id);
      pendingWallMoveRef.current = { wallId: id, total };
    } else {
      pendingAreaMoveRef.current = { kind, id, total };
    }
    const preview: DraftShape[] = sheetOwnerOutlines(sh.levelId, kind, id).map((pts) => ({
      kind: "poly",
      pts: pts.map((q) => ({ x: q.x + du, y: q.y })),
      closed: true,
    }));
    setDraft({ preview, vertices: [], snap: null });
  };

  // Öffnung im Blatt waagrecht ziehen: Blatt-Delta (u) → Verschiebung entlang
  // der Wirtswand (Δposition = du · (u-Achse · Wandrichtung)); bei einer quer
  // geschnittenen Wand (Achse ⟂ Schnittlinie) bewegt sie sich darum kaum —
  // richtig so, sie läuft ja in die Tiefe. Projekt erst beim Loslassen.
  const moveOpeningInSheet = (sh: { levelId: string; uAxis: Vec2 }, delta: Vec2, openingId: string) => {
    const op = (project.openings ?? []).find((o) => o.id === openingId);
    const w = op && project.walls.find((x) => x.id === op.hostWallId);
    if (!op || !w || op.locked) return;
    const prevDu = sheetDuRef.current && sheetDuRef.current.id === openingId ? sheetDuRef.current.du : 0;
    // Auf die Wand geklemmt (Öffnung bleibt drin) — auch die Vorschau.
    const slide = openingSheetSlide(w, op, sh.uAxis, prevDu + delta.x);
    if (!slide) return;
    const { position: pos, du } = slide;
    sheetDuRef.current = { id: openingId, du };
    pendingOpeningMoveRef.current = { id: openingId, position: pos };
    const preview: DraftShape[] = sheetOwnerOutlines(sh.levelId, "opening", openingId).map((pts) => ({
      kind: "poly",
      pts: pts.map((q) => ({ x: q.x + du, y: q.y })),
      closed: true,
    }));
    setDraft({ preview, vertices: [], snap: null });
  };

  const gripHandlers = {
    onGripMove: (index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      // Schnitt/Ansicht: Höhen-Griff (Wand-Oberkante, Fenster Ober-/Unterkante).
      if (!modelEditable && sheet) {
        const g = sheetHeightGrips[index];
        if (!g) return;
        // 1-cm-Raster, Strg = frei; Mindestmasse und mm-Rundung im Kern (`sheetHeightDrag`).
        const { top: newTop, bottom: newBottom, patch } = sheetHeightDrag(g.kind, g, raw.y, !!mods.ctrl);
        pendingSheetHeightRef.current = { kind: g.kind === "wallTop" ? "wall" : "opening", id: g.id, patch };
        const bottom = g.kind === "wallTop" ? g.bottom : newBottom;
        setDraft({
          preview: [{
            kind: "poly",
            pts: [{ x: g.u0, y: bottom }, { x: g.u1, y: bottom }, { x: g.u1, y: newTop }, { x: g.u0, y: newTop }],
            closed: true,
          }],
          vertices: [],
          snap: null,
          hud: { at: { x: (g.u0 + g.u1) / 2, y: g.kind === "openingBottom" ? newBottom : newTop }, text: `${(newTop - bottom).toFixed(2)} m` },
        });
        return;
      }
      // Erster Move-Event nach dem Grab (gripDragInfoRef noch leer): die
      // AKTUELLE — hier noch unveränderte — Position als Flucht-Bezugspunkt
      // verankern (s. Kommentar an gripOriginRef).
      if (gripDragInfoRef.current === null) {
        gripOriginRef.current = grips[index];
        const op0 = selectedOpeningId ? (project.openings ?? []).find((o) => o.id === selectedOpeningId) : undefined;
        const dir0 = op0 ? openingWallDir() : null;
        gripOpeningPos0Ref.current = op0 && dir0 ? { position: op0.position, dir: dir0 } : null;
      }
      // (c) Vertex-Drag mit aktivem Feld-Controller: `locks` ist ab dem
      // ÖFFNEN (Tab) immer für BEIDE Felder befüllt (s. cycleGripEditField),
      // die Maus wirkt also erst wieder, sobald ein Feld per Tab explizit
      // gelöst wurde — kein separater „eingefroren"-Zustand mehr nötig.
      const ge = gripEditRef.current;
      gripDragInfoRef.current = { index, raw };
      if (ge && (ge.locks.length != null || ge.locks.angle != null)) {
        const pt = gripEditPoint(ge.anchor, ge.locks, raw);
        applyGripEdit(index, pt, ge.anchor, ge.locks.length);
        setDraft({ preview: gripPreviewShapes(), vertices: [], snap: null, hud: hudFor(index, pt) });
        return;
      }
      // Mehrfachauswahl: das Element, dem DIESER Griff gehört (nicht zwingend
      // das singuläre selectedDrawingId/selectedWallId) — von den eigenen
      // Snap-Kandidaten ausschließen (sonst fängt der Punkt an sich selbst).
      const owner = gripOwners[index];
      const snapSkip = selectedRoomId || selectedCeilingId || owner?.drawingId || owner?.wallId;
      const excludeIds = snapSkip ? [snapSkip] : [];
      // Bezugspunkt für Shift-Ortho: ein Nachbar-Griff DESSELBEN Elements
      // (festes Ende), relativ zu dem die Bewegung auf H/V eingerastet wird.
      const refIndex = neighborGripIndex(index);
      const anchor = refIndex != null ? grips[refIndex] : null;
      // Shift = Achsen-Lock: den gezogenen Punkt auf eine von mehreren
      // Kandidaten-Achsen zwingen (welche gewinnt, s. closestAxisPoint) — Welt-
      // H/V UND, bei einem Vielecks-Eckpunkt (zwei anliegende Kanten), zusätzlich
      // die FLUCHT der beiden fixen Nachbarkanten in ihrer ursprünglichen
      // Richtung. Nutzer-Wunsch: „wenn ein Punkt aus zwei Linien besteht, die
      // nicht in 0/90° liegen, sollte Shift auch in DIESE Richtung snappen" —
      // vorher war Shift stur auf Welt-H/V beschränkt, bei schrägen Anschlüssen
      // also nutzlos für „entlang der bestehenden Kante weiterziehen". Der Lock
      // dominiert (kein Snap), damit die Endkoordinate garantiert eine Achse
      // trifft — identisch zum bisherigen Ortho-Verhalten.
      if (mods.shift && anchor) {
        const origin = gripOriginRef.current;
        const ring = origin ? resolvePolygonRing(index) : null;
        const pt = gripAxisLock(raw, anchor, origin, ring?.pts ?? null, ring?.index ?? -1, ring?.closed ?? false);
        applyGrip(index, pt);
        setDraft({ preview: gripPreviewShapes(), vertices: [], snap: null, hud: hudFor(index, pt) });
        return;
      }
      // Snap gegen das Projekt OHNE das gerade gezogene Element (sonst fängt der
      // Punkt an sich selbst); Bezug ist der feste Nachbar-Griff, nicht der
      // laufende Werkzeug-Zustand (kein aktives Zeichenwerkzeug während des Drags).
      const snapResult = computeSnap({
        raw,
        project,
        excludeIds,
        scale: scaleDenominator,
        levelId,
        visibleCodes,
        settings: snap,
        draftPoints: [],
        lastPoint: anchor,
        pxPerMeter,
        shift: mods.shift,
        ctrl: mods.ctrl,
      });
      const pt = snapResult?.point ?? raw;
      applyGrip(index, pt);
      setDraft({ preview: gripPreviewShapes(), vertices: [], snap: snapResult, hud: hudFor(index, pt) });
    },
    onMoveBody: (
      delta: Vec2,
      target?: BodyTarget,
      mods?: ToolMods,
    ) => {
      // Shift = Ortho: das Delta auf die dominante Achse (H/V) zwingen —
      // dieselbe Regel wie beim freien Kanten-Zug (onEdgeMove) und beim
      // Vertex-Griff (onGripMove). Bisher wirkte Shift beim Körper-Verschieben
      // (Wand/2D-Element/Decke/Treppe/Raum als Ganzes) gar nicht (Nutzer-Report
      // 2026-07-06) — `mods` kam von PlanView schlicht nicht bis hierher.
      if (mods?.shift) {
        if (Math.abs(delta.x) >= Math.abs(delta.y)) delta = { x: delta.x, y: 0 };
        else delta = { x: 0, y: delta.y };
      }
      // Schnitt-Blatt: geschnittene Wand/Decke waagrecht entlang der Schnittlinie.
      if (!modelEditable) {
        if (sheet) moveInSheet(sheet, delta, target);
        return;
      }
      // Decke: ganzen Umriss verschieben (kein Multi-Koinzidenz-Handling nötig).
      // Decke/Treppe/Raum: nur Gesamt-Delta + Vorschau, Projekt erst beim Loslassen.
      const areaTarget: { kind: "ceiling" | "room" | "stair"; id: string } | null = target
        ? null
        : selectedCeilingId
          ? { kind: "ceiling", id: selectedCeilingId }
          : selectedStairId
            ? { kind: "stair", id: selectedStairId }
            : selectedRoomId
              ? { kind: "room", id: selectedRoomId }
              : null;
      if (areaTarget) {
        const prev = pendingAreaMoveRef.current;
        const same = prev && prev.kind === areaTarget.kind && prev.id === areaTarget.id;
        const total = same ? { x: prev!.total.x + delta.x, y: prev!.total.y + delta.y } : delta;
        pendingAreaMoveRef.current = { ...areaTarget, total };
        setDraft({
          preview: areaMovePreview(project, areaTarget.kind, areaTarget.id, total),
          vertices: [],
          snap: null,
        });
        return;
      }
      // Gegriffenes Element: bei Mehrfachauswahl das unter dem Cursor (target),
      // sonst das einzeln selektierte. Wand UND 2D schließen sich aus.
      const moveDrawingId = target ? target.drawingId ?? null : selectedDrawingId;
      const moveWallId = target ? target.wallId ?? null : selectedWallId;
      // 2D-Element: nur Gesamt-Delta merken + Vorschau; Projekt erst beim Loslassen.
      // Wand: Gesamt-Delta + Vorschau; beim Loslassen folgen verbundene Eckpunkte.
      if (moveWallId && !moveDrawingId) {
        const w = project.walls.find((x) => x.id === moveWallId);
        if (w && !w.locked) {
          if (moveCoincidentRef.current === null) {
            moveCoincidentRef.current = findMoveCoincident2D(null, moveWallId);
          }
          const prev = pendingWallMoveRef.current;
          const total = prev && prev.wallId === moveWallId
            ? { x: prev.total.x + delta.x, y: prev.total.y + delta.y }
            : delta;
          pendingWallMoveRef.current = { wallId: moveWallId, total };
          setDraft({ preview: areaMovePreview(project, "wall", moveWallId, total), vertices: [], snap: null });
          return;
        }
      }
      const bodyDrawing = moveDrawingId && !moveWallId ? deferrableDrawing(moveDrawingId) : null;
      // Nur Formen mit sichtbarer Umriss-Vorschau aufschieben (Text/Kreis/Bemassung
      // bleiben beim Live-Verschieben, sonst sähe man während des Ziehens nichts).
      // Alle 2D-Formen haben eine Vorschau (s. tools/drawingPreview.ts).
      const previewable = !!bodyDrawing;
      if (moveDrawingId && previewable) {
        if (moveCoincidentRef.current === null) {
          moveCoincidentRef.current = findMoveCoincident2D(moveDrawingId, null);
        }
        const prev = pendingBodyRef.current;
        const total = prev && prev.drawingId === moveDrawingId
          ? { x: prev.total.x + delta.x, y: prev.total.y + delta.y }
          : delta;
        pendingBodyRef.current = { drawingId: moveDrawingId, total };
        setDraft({ preview: bodyPreviewShapes(), vertices: [], snap: null });
        return;
      }
      // Beim ersten Move-Event die Koinzidenz-Gruppe einmalig bestimmen (Snapshot
      // VOR der ersten Mutation der Siblings). Danach inkrementell mitführen.
      if (moveCoincidentRef.current === null) {
        moveCoincidentRef.current = findMoveCoincident2D(moveDrawingId, moveWallId);
      }
      const coincident = moveCoincidentRef.current;
      // Element + mitgeführte Ecken: je Mausschritt eine Gruppe, die Schritte desselben Zugs
      // schliessen an denselben Undo-Schritt an.
      groupChanges(() => {
        moveElementByOf(moveDrawingId, moveWallId, delta);
        for (const c of coincident) {
          c.pos = { x: c.pos.x + delta.x, y: c.pos.y + delta.y };
          moveGripOf(c.drawingId, c.wallId, c.index, c.pos, scaleDenominator);
        }
      }, `bodyDrag:${moveDrawingId ?? ""}:${moveWallId ?? ""}`);
    },
    // Kanten-Griff ziehen. Zwei Verhalten (Zielpunkt jeweils ABSOLUT relativ
    // zum ORIGINALEN Anker `edge.mid`, angewandt über applyEdgeToward — s. dort):
    //  • free (offene Polylinie/Linie, §Task B): das Segment folgt dem VOLLEN
    //    Cursor-Delta — beide Endpunkte wandern gleich, die geteilten Ecken ziehen
    //    die Nachbar-Segmente nach. Shift = Ortho (H/V) auf den Gesamt-Vektor.
    //  • sonst (rect/geschlossene Polylinie/Wand): NUR die Komponente senkrecht
    //    zur Kante (Seite verschiebt sich parallel nach außen/innen). Fängt an
    //    eingeschalteten Geometrie-Snaps (Endpunkt/Mittelpunkt/Schnittpunkt/…);
    //    ohne Geometrie-Snap wird der Offset wie bisher aufs Raster gerundet.
    onEdgeMove: (edge: EdgeGrip, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      edgeDragInfoRef.current = { edge, raw };
      const anchor = edge.mid; // Momentaufnahme vom Grab, ändert sich während des Drags nicht
      const ee = edgeEditRef.current;
      // Feld-Controller mit Lock aktiv: Zielpunkt aus Anker + gelocktem Wert.
      // `locks` ist ab dem Öffnen (Tab) immer befüllt (s. cycleEdgeEditField),
      // die Maus wirkt also erst wieder, sobald ein Feld per Tab gelöst wurde.
      if (ee && (ee.locks.length != null || ee.locks.angle != null)) {
        const pt = edgeEditPoint(edge, ee.locks, raw);
        applyEdgeToward(edge, anchor, pt);
        setDraft({ preview: edgePreviewShapes(), vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
        return;
      }
      // Raster nur ohne Strg und bei eingeschaltetem Raster-Snap.
      const grid = !mods.ctrl && snap.enabled && snap.grid && snap.gridSize > 0 ? snap.gridSize : 0;
      if (edge.free) {
        // Keine Geometrie-Snap-Projektion (keine feste Kanten-Normale, an die sich ein gefangener Punkt
        // anlehnen könnte) — der Cursor bewegt den Zielpunkt direkt, nur Ortho/Raster wirken (Kern).
        const pt = gripEdgeTarget(edge, raw, { shift: mods.shift, grid });
        applyEdgeToward(edge, anchor, pt);
        setDraft({ preview: edgePreviewShapes(), vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
        return;
      }
      // Cursor zuerst durch die Snap-Engine schicken (Ctrl unterdrückt Snap wie überall sonst, siehe
      // computeSnap). Ein GEOMETRIE-Snap (Endpunkt/Mittelpunkt/Schnittpunkt/…, nicht Raster/Ortho) liefert den
      // gefangenen Punkt, den der Kern auf die Aussennormale projiziert (vor dem Raster).
      const snapResult = snapFor(raw, pxPerMeter, mods);
      const isGeometrySnap = !!snapResult && snapResult.kind !== "grid" && snapResult.kind !== "ortho";
      const pt = gripEdgeTarget(edge, raw, { grid, snapped: isGeometrySnap ? snapResult!.point : null });
      applyEdgeToward(edge, anchor, pt);
      setDraft({
        preview: edgePreviewShapes(),
        vertices: [],
        snap: isGeometrySnap ? snapResult : null,
        hud: edgeHudFor(edge, anchor, pt),
      });
    },
    onGripEnd: () => {
      commitPendingGrip();
      commitPendingBody();
      endEditing();
    },
    // Bewaffneten Punkt-Griff verwerfen (Escape): exakt auf `origin`
    // zurücksetzen — ohne Snap/Ortho-Neuauswertung, ein reiner Revert — und
    // danach wie onGripEnd aufräumen.
    onGripCancel: (index: number, origin: Vec2) => {
      // Ausstehender Zug: einfach verwerfen (das Projekt wurde nie verändert).
      if (pendingSheetHeightRef.current) {
        pendingSheetHeightRef.current = null;
      } else if (pendingGripRef.current || pendingWallGripRef.current || pendingAreaGripRef.current) {
        pendingGripRef.current = null;
        pendingWallGripRef.current = null;
        pendingAreaGripRef.current = null;
      } else applyGrip(index, origin);
      endEditing();
    },
    onEdgeEnd: () => {
      commitPendingEdge();
      endEditing();
    },
    // Bewaffneten Kanten-Griff verwerfen (Escape): Ziel = Anker selbst (Delta
    // 0) — applyEdgeToward macht dadurch die komplette bisherige Verschiebung
    // in einem Schritt rückgängig (negatives Delta zum zuletzt angewandten).
    onEdgeCancel: (edge: EdgeGrip, anchor: Vec2) => {
      // Aufgeschobener Zug: verwerfen genügt (Projekt nie verändert).
      if (pendingEdgeRef.current) pendingEdgeRef.current = null;
      else applyEdgeToward(edge, anchor, anchor);
      endEditing();
    },
  };

  // Der gezogene Griff folgt der Vorschau (das Projekt bleibt bis zum Setzen unverändert).
  const pendingNow = pendingGripRef.current ?? pendingWallGripRef.current ?? pendingAreaGripRef.current;
  const displayGrips = pendingNow ? grips.map((g, i) => (i === pendingNow.flat ? pendingNow.pt : g)) : grips;

  // Referenzstabil für die memoisierte Hauptansicht ([121]): gleiche Griffe → gleiche Referenz,
  // Handler mit fester Identität (rufen die Fassung des letzten Renders).
  const stableGrips = useSameData(displayGrips);
  const stableHandleLines = useSameData(gripHandleLines);
  const stableEdgeGrips = useSameData(edgeGrips);
  const stableGripHandlers = useEventBundle(gripHandlers);
  return {
    grips: stableGrips,
    gripHandleLines: stableHandleLines,
    edgeGrips: stableEdgeGrips,
    gripHandlers: stableGripHandlers,
    gripEdit,
    setGripEdit,
    gripEditFields,
    cycleGripEditField,
    submitGripEditValue,
    closeGripEditField,
    edgeEdit,
    setEdgeEdit,
    edgeEditFields,
    cycleEdgeEditField,
    submitEdgeEditValue,
    closeEdgeEditField,
    // Für useToolNumberShortcuts: solange ein Punkt- ODER Kanten-Griff
    // bewaffnet ist, dürfen Zifferntasten NICHT als Werkzeug-Wechsel
    // interpretiert werden (auch nicht, wenn das Befehlsfeld fokussiert und
    // leer ist — die Zeichen-Engine selbst läuft ja nicht, daher greift
    // dieser Wächter sonst nicht).
    gripDragInfoRef,
    edgeDragInfoRef,
  };
}
