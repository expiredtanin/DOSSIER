// 2D-Griff-Editieren des aktuell einzeln selektierten Elements (Wand/2D-Element/
// Decke/Raum/Öffnung/Treppe): Eckpunkt- + Kanten-Griffe, deren Zieh-Handler
// (inkl. Ortho/Snap/koinzidente Nachbar-Ecken) sowie der Tab-Feld-Controller für
// präzise Länge/Winkel-Eingabe während eines Vertex-Drags.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef, useState, type RefObject } from "react";
import { add, dot, leftNormal, normalize, scale, sub, wallCorners } from "../model/geometry";
import type { Ceiling, Drawing2D, EdgeGrip, Project, Room, Stair, Vec2 } from "../model/types";
import { wallTypeThickness } from "../model/types";
import { drawingVertices, surfaceOpeningGripPatch, surfaceOpeningGrips, surfaceOpeningInfo } from "../core";
import { gripDrawingIdsFor } from "./gripLimits";
import { openEdges, polylineEdgeGrips, ringEdges } from "../core";
import { areaMovePreview, drawingMovePreview } from "../tools/transform";
import type { DraftShape, SnapResult, SnapSettings, ToolDraft, ToolMods } from "../tools/types";
import { applyAngleConstraint, computeSnap } from "../tools/snapping";
import { useCommandTabShortcut } from "./useKeyboardShortcuts";
import { sheetOwnerOutlines } from "../tools/sheetSnapGeometry";
import type { BodyTarget } from "../views/plan/PlanView";
import type { CommandLineHandle } from "../ui/CommandLine";
import type { CommandEngine } from "../commands/engine";

export interface GripEditFieldsState {
  id: string;
  labelKey: string;
  value: number | null;
  locked: boolean;
  active: boolean;
}

export function useGripEditing(opts: {
  project: Project;
  selectedDrawing: Drawing2D | null;
  selectedCeiling: Ceiling | null;
  selectedRoom: Room | null;
  selectedOpeningId: string | null;
  selectedStairId: string | null;
  selectedRoomId: string | null;
  selectedCeilingId: string | null;
  selectedDrawingId: string | null;
  selectedWallId: string | null;
  selectedWallIds: string[];
  selectedDrawingIds: string[];
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
  /** Wand ändern (Höhen-Griff im Schnitt); `coalesceKey` fasst einen Zug zu EINEM Undo-Schritt. */
  updateWall: (id: string, patch: Partial<import("../model/types").Wall>, coalesceKey?: string) => void;
  moveStairBy: (id: string, delta: Vec2) => void;
  moveRoomGrip: (id: string, index: number, pt: Vec2) => void;
  moveCeilingGrip: (id: string, index: number, pt: Vec2) => void;
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
    selectedRoom,
    selectedOpeningId,
    selectedStairId,
    selectedRoomId,
    selectedCeilingId,
    selectedDrawingId,
    selectedWallId,
    selectedWallIds,
    selectedDrawingIds,
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
    updateWall,
    moveStairBy,
    moveRoomGrip,
    moveCeilingGrip,
    moveGripOf,
    moveRoomEdge,
    moveCeilingEdge,
    moveEdgeOf,
    moveRoomBy,
    moveCeilingBy,
    moveElementByOf,
  } = opts;
  const groupChanges = opts.groupChanges ?? ((fn: () => void) => fn());

  // Bewegpunkt (Move-Handle) einer Treppe: liegt auf der Treppe (Mitte des
  // ersten Laufs bei gerade/L, Zentrum bei Wendel) und verschiebt beim Ziehen
  // die GANZE Treppe (moveStairBy mit dem Delta). Ein einzelner, gut sichtbarer
  // Griff — analog zum Öffnungs-Mittelpunkt.
  const stairMoveHandle = (st: Stair): Vec2 => {
    if (st.shape === "spiral") return st.center ?? st.start;
    const d = normalize(st.dir);
    return add(st.start, scale(d, st.runLength / 2));
  };

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

  // Bei Mehrfachauswahl fehlt `selectedDrawingIds` manchmal trotzdem (nur die
  // Einzel-ID `selectedDrawingId` gesetzt, s. useSelectionState-Konvention) —
  // derselbe Fallback wie an anderen Stellen im Projekt.
  const effectiveDrawingIds =
    selectedDrawingIds.length > 0
      ? selectedDrawingIds
      : selectedDrawingId
        ? [selectedDrawingId]
        : [];

  // Griff-Grenzen (s. gripLimits.ts): grosse Mehrfachauswahlen ohne Griffe, ein einzeln gewähltes
  // Element immer mit Griffen (Kataster-Parzellen mit tausenden Stützpunkten).
  const gripDrawingIds = gripDrawingIdsFor(effectiveDrawingIds, (id) => {
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
        const axis = normalize(sub(w.end, w.start));
        const pt = add(w.start, scale(axis, op.position + op.width / 2));
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
      gripOwners.push({ localIndex: 0 });
      gripOwnerRange.push([0, 0]);
      return [stairMoveHandle(st)];
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
        if (w) pushGroup([w.start, w.end], { wallId: id });
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
  const moveCoincidentRef = useRef<
    | { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[]
    | null
  >(null);
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
  // Koinzidente Sibling-Vertices (unter den ÜBRIGEN gewählten Elementen) an JEDER
  // Ecke des verschobenen Elements. Toleranz wie beim 3D-Drag (gemeinsame Ecke).
  const COINCIDENT_TOL_2D = 0.05; // m
  const findMoveCoincident2D = (
    selfDrawingId: string | null,
    selfWallId: string | null,
  ): { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[] => {
    const corners = elementCorners(selfDrawingId, selfWallId);
    if (corners.length === 0) return [];
    const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= COINCIDENT_TOL_2D;
    const seen = new Set<string>();
    const out: { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[] = [];
    const add2 = (drawingId: string | null, wallId: string | null, index: number, pos: Vec2) => {
      const key = `${drawingId ?? ""}|${wallId ?? ""}|${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ drawingId, wallId, index, pos: { ...pos } });
    };
    for (const corner of corners) {
      for (const id of selectedWallIds) {
        if (id === selfWallId) continue;
        const w = project.walls.find((x) => x.id === id);
        if (!w) continue;
        if (near(corner, w.start)) add2(null, id, 0, w.start);
        if (near(corner, w.end)) add2(null, id, 1, w.end);
      }
      for (const id of selectedDrawingIds) {
        if (id === selfDrawingId) continue;
        const d = project.drawings2d.find((x) => x.id === id);
        if (!d) continue;
        drawingVertices(d, scaleDenominator).forEach((v, i) => {
          if (near(corner, v)) add2(id, null, i, v);
        });
      }
    }
    return out;
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
  const pendingAreaGripRef = useRef<{ kind: "room" | "ceiling"; id: string; index: number; flat: number; pt: Vec2 } | null>(null);
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

  // Endpunkt aus Anker + (gelockten/Live-)Länge/Winkel — wie lineEndFromFields,
  // hier für den Vertex-Drag. Ungelockte Größen folgen dem rohen Cursor `raw`.
  const gripEditPoint = (
    anchor: Vec2,
    locks: { length?: number; angle?: number },
    raw: Vec2,
  ): Vec2 => {
    const DEG = Math.PI / 180;
    const dx = raw.x - anchor.x;
    const dy = raw.y - anchor.y;
    const length = locks.length != null ? locks.length : Math.hypot(dx, dy);
    const angleDeg = locks.angle != null ? locks.angle : (Math.atan2(dy, dx) * 180) / Math.PI;
    const a = angleDeg * DEG;
    return { x: anchor.x + Math.cos(a) * length, y: anchor.y + Math.sin(a) * length };
  };

  // Felder fürs Befehlsfeld während des Vertex-Drags (Live ODER gelockt).
  const gripEditFields = (): GripEditFieldsState[] => {
    const ge = gripEdit;
    const info = gripDragInfoRef.current;
    if (!ge || !info) return [];
    const dx = info.raw.x - ge.anchor.x;
    const dy = info.raw.y - ge.anchor.y;
    const liveLen = Math.hypot(dx, dy);
    const liveAng = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    return [
      {
        id: "length",
        labelKey: "cmd.field.length",
        value: ge.locks.length ?? liveLen,
        locked: ge.locks.length != null,
        active: ge.active === "length",
      },
      {
        id: "angle",
        labelKey: "cmd.field.angle",
        value: ge.locks.angle ?? liveAng,
        locked: ge.locks.angle != null,
        active: ge.active === "angle",
      },
    ];
  };

  // Fixer Bezug (Anker) für Länge/Winkel eines gezogenen Punkt-Griffs. Normal
  // die BENACHBARTE Ecke DESSELBEN Elements (Polylinien-Semantik) — bei Kreis/
  // Bogen ist das falsch (deren Griffe liegen auf dem Ring, "Länge" muss der
  // RADIUS sein, also relativ zum ZENTRUM). Ohne diesen Sonderfall blieb der
  // Kreis-Radius-Griff sogar ganz ohne Anker (nur 1 Griff, kein Nachbar).
  // Gemeinsam genutzt vom Tab-Feld-Controller UND dem Shift-Ortho-Bezug UND
  // dem Cursor-HUD (Länge/Winkel-Anzeige neben der Maus).
  const resolveGripAnchor = (index: number): Vec2 | null => {
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

  // Die beiden (fixen) Polygon-Nachbarn eines gezogenen Punkt-Griffs — für die
  // Flucht-Kandidaten unten. Anders als `neighborGripIndex` (EIN Nachbar,
  // reicht für Länge/Winkel-Anker) werden hier BEIDE gebraucht: ein Vielecks-
  // Eckpunkt hängt an ZWEI Kanten, jede liefert eine eigene mögliche Flucht-
  // Richtung. Kennt geschlossene Ringe (rect/geschlossene Polylinie/Raum/
  // Decke — Nachbar 0/n-1 wickelt um) vs. offene Ketten (offene Polylinie/
  // Linie — Enden haben nur einen Nachbarn). Kreis/Bogen/Wand/Öffnung/Treppe
  // haben keine Polygon-Nachbarn (kein Vielecks-Eckpunkt) → {null,null}.
  const ringNeighborPts = (
    pts: Vec2[],
    i: number,
    closed: boolean,
  ): { prev: Vec2 | null; next: Vec2 | null } => {
    const n = pts.length;
    const prevIdx = i > 0 ? i - 1 : closed ? n - 1 : null;
    const nextIdx = i < n - 1 ? i + 1 : closed ? 0 : null;
    return {
      prev: prevIdx != null && prevIdx !== i ? pts[prevIdx] : null,
      next: nextIdx != null && nextIdx !== i && nextIdx !== prevIdx ? pts[nextIdx] : null,
    };
  };
  const resolvePolygonNeighbors = (index: number): { prev: Vec2 | null; next: Vec2 | null } => {
    const owner = gripOwners[index];
    const none = { prev: null, next: null };
    if (!owner?.drawingId && !owner?.wallId) {
      // Raum/Decke (exklusiv) — kein Owner, `localIndex` fehlt dann auch, also
      // ist der flache `index` selbst der Ring-Index.
      const pts = selectedCeiling
        ? selectedCeiling.outline
        : selectedRoom
        ? selectedRoom.boundary
        : null;
      return pts ? ringNeighborPts(pts, owner?.localIndex ?? index, true) : none;
    }
    if (owner.wallId) return none; // Wand: nur 2 Punkte, kein Vielecks-Nachbar
    const d = project.drawings2d.find((x) => x.id === owner.drawingId);
    const g = d?.geom;
    if (!g) return none;
    if (g.shape === "polyline" || g.shape === "spline")
      return ringNeighborPts(g.pts, owner.localIndex, !!g.closed);
    if (g.shape === "rect" || g.shape === "image") {
      const corners = [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }];
      return ringNeighborPts(corners, owner.localIndex, true);
    }
    if (g.shape === "line") return ringNeighborPts([g.a, g.b], owner.localIndex, false);
    return none; // circle/arc: kein Vielecks-Eckpunkt
  };

  // Rohen Cursor `raw` auf die nächstliegende von mehreren Kandidaten-Achsen
  // projizieren (jeweils Stützpunkt + Richtung) — "nächstliegend" = kleinster
  // senkrechter Abstand von `raw` zur (unendlich verlängerten) Achse. Deckt
  // Shift-Ortho (Welt-H/V) UND Flucht-Snap (Richtung anliegender, fixer
  // Kanten) in einem einheitlichen Mechanismus ab.
  const closestAxisPoint = (raw: Vec2, candidates: { point: Vec2; dir: Vec2 }[]): Vec2 | null => {
    let best: Vec2 | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const len = Math.hypot(c.dir.x, c.dir.y);
      if (len < 1e-9) continue; // entartete Richtung (koinzidenter Nachbar) → überspringen
      const u = { x: c.dir.x / len, y: c.dir.y / len };
      const rel = sub(raw, c.point);
      const t = rel.x * u.x + rel.y * u.y;
      const proj = add(c.point, scale(u, t));
      const dist = Math.hypot(raw.x - proj.x, raw.y - proj.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = proj;
      }
    }
    return best;
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
    setGripEdit((prev) => {
      if (!prev) {
        const frozen = grips[info.index];
        const dx = frozen.x - anchor.x;
        const dy = frozen.y - anchor.y;
        const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        return { anchor, active: "length", locks: { length: Math.hypot(dx, dy), angle } };
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
    applyGrip(info.index, pt);
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

  // Zielpunkt aus Anker + (gelockten/Live-)Werten — bei freien Kanten wie ein
  // Punkt-Griff (polar), bei geführten Kanten nur entlang der festen Normale.
  const edgeEditPoint = (
    edge: EdgeGrip,
    anchor: Vec2,
    locks: { length?: number; angle?: number },
    raw: Vec2,
  ): Vec2 => {
    if (edge.free) return gripEditPoint(anchor, locks, raw);
    const live = dot(sub(raw, anchor), edge.normal);
    const len = locks.length != null ? locks.length : live;
    return add(anchor, scale(edge.normal, len));
  };

  // Felder fürs Befehlsfeld während des Kanten-Drags. Geführte Kanten zeigen
  // NUR "Länge" (kein Winkel — der ist durch die feste Normale vorgegeben).
  const edgeEditFields = (): GripEditFieldsState[] => {
    const ee = edgeEdit;
    const info = edgeDragInfoRef.current;
    if (!ee || !info) return [];
    const { edge, raw } = info;
    if (!edge.free) {
      const live = dot(sub(raw, ee.anchor), edge.normal);
      return [
        {
          id: "length",
          labelKey: "cmd.field.length",
          value: ee.locks.length ?? live,
          locked: ee.locks.length != null,
          active: true,
        },
      ];
    }
    const dx = raw.x - ee.anchor.x;
    const dy = raw.y - ee.anchor.y;
    const liveLen = Math.hypot(dx, dy);
    const liveAng = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    return [
      {
        id: "length",
        labelKey: "cmd.field.length",
        value: ee.locks.length ?? liveLen,
        locked: ee.locks.length != null,
        active: ee.active === "length",
      },
      {
        id: "angle",
        labelKey: "cmd.field.angle",
        value: ee.locks.angle ?? liveAng,
        locked: ee.locks.angle != null,
        active: ee.active === "angle",
      },
    ];
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
        const frozen = edgeEditPoint(edge, anchor, {}, raw);
        const dx = frozen.x - anchor.x;
        const dy = frozen.y - anchor.y;
        if (edge.free) {
          const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          return { anchor, active: "length", locks: { length: Math.hypot(dx, dy), angle } };
        }
        const offset = dx * edge.normal.x + dy * edge.normal.y;
        return { anchor, active: "length", locks: { length: offset } };
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
    const pt = edgeEditPoint(edge, ee.anchor, locks, raw);
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
        const patch = info && surfaceOpeningGripPatch(info, index, pt);
        if (patch) updateOpening(op.id, patch);
        return;
      }
      const w = op && project.walls.find((x) => x.id === op.hostWallId);
      if (op && w) {
        const d = sub(w.end, w.start);
        const len = Math.hypot(d.x, d.y);
        if (len > 1e-9) {
          const axis = scale(d, 1 / len);
          const t = dot(sub(pt, w.start), axis);
          const pos = Math.max(0, Math.min(len - op.width, t - op.width / 2));
          updateOpening(op.id, { position: pos });
        }
      }
      return;
    }
    // Treppe: den Bewegpunkt verfolgen → ganze Treppe um das Delta (Ziel −
    // aktueller Handle) verschieben. Handle wird identisch zu grips gebildet,
    // sodass er nach dem Move exakt unter dem Cursor sitzt.
    if (selectedStairId) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      if (st) moveStairBy(st.id, sub(pt, stairMoveHandle(st)));
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
    if (pom) updateOpening(pom.id, { position: pom.position });
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
    if (selectedRoomId) moveRoomEdge(selectedRoomId, edge.aIndex, edge.bIndex, delta);
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
    const dx = pt.x - anchor.x;
    const dy = pt.y - anchor.y;
    const angleDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return { at: pt, length: Math.hypot(dx, dy), angleDeg };
  };
  // Dasselbe für einen gezogenen Kanten-Griff: freie Kanten zeigen Länge+Winkel
  // (wie ein Punkt-Griff), geführte Kanten nur EINEN Wert (Abstand entlang der
  // Normale) — dafür reicht das HUD-Schema nicht (length+angleDeg gehören
  // zusammen), daher als freier Text `Δ: …m`.
  const edgeHudFor = (edge: EdgeGrip, anchor: Vec2, pt: Vec2): NonNullable<ToolDraft["hud"]> => {
    const dx = pt.x - anchor.x;
    const dy = pt.y - anchor.y;
    if (edge.free) {
      const angleDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      return { at: pt, length: Math.hypot(dx, dy), angleDeg };
    }
    const offset = dx * edge.normal.x + dy * edge.normal.y;
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
    const axis = normalize(sub(w.end, w.start));
    const factor = dot(sh.uAxis, axis);
    if (Math.abs(factor) < 0.15) return;
    const prevDu = sheetDuRef.current && sheetDuRef.current.id === openingId ? sheetDuRef.current.du : 0;
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    // Auf die Wand klemmen (Öffnung bleibt drin) — auch die Vorschau.
    const rawPos = op.position + (prevDu + delta.x) * factor;
    const pos = Math.max(0, Math.min(len - op.width, rawPos));
    const du = (pos - op.position) / factor;
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
        const v = mods.ctrl ? raw.y : Math.round(raw.y * 100) / 100; // 1-cm-Raster, Strg = frei
        let newTop = g.top;
        let newBottom = g.bottom;
        if (g.kind === "wallTop") {
          newTop = Math.max(g.base + 0.3, v);
          pendingSheetHeightRef.current = { kind: "wall", id: g.id, patch: { height: Math.round((newTop - g.base) * 1000) / 1000 } };
        } else if (g.kind === "openingTop") {
          newTop = Math.max(g.bottom + 0.2, v);
          pendingSheetHeightRef.current = { kind: "opening", id: g.id, patch: { height: Math.round((newTop - g.bottom) * 1000) / 1000 } };
        } else {
          newBottom = Math.min(g.top - 0.2, Math.max(g.base, v));
          pendingSheetHeightRef.current = {
            kind: "opening",
            id: g.id,
            patch: { sillHeight: Math.round((newBottom - g.base) * 1000) / 1000, height: Math.round((g.top - newBottom) * 1000) / 1000 },
          };
        }
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
      if (gripDragInfoRef.current === null) gripOriginRef.current = grips[index];
      // (c) Vertex-Drag mit aktivem Feld-Controller: `locks` ist ab dem
      // ÖFFNEN (Tab) immer für BEIDE Felder befüllt (s. cycleGripEditField),
      // die Maus wirkt also erst wieder, sobald ein Feld per Tab explizit
      // gelöst wurde — kein separater „eingefroren"-Zustand mehr nötig.
      const ge = gripEditRef.current;
      gripDragInfoRef.current = { index, raw };
      if (ge && (ge.locks.length != null || ge.locks.angle != null)) {
        const pt = gripEditPoint(ge.anchor, ge.locks, raw);
        applyGrip(index, pt);
        setDraft({ preview: gripPreviewShapes(), vertices: [], snap: null, hud: hudFor(index, pt) });
        return;
      }
      // Mehrfachauswahl: das Element, dem DIESER Griff gehört (nicht zwingend
      // das singuläre selectedDrawingId/selectedWallId) — von den eigenen
      // Snap-Kandidaten ausschließen (sonst fängt der Punkt an sich selbst).
      const owner = gripOwners[index];
      const snapProject: Project = selectedRoomId
        ? { ...project, rooms: (project.rooms ?? []).filter((r) => r.id !== selectedRoomId) }
        : selectedCeilingId
        ? { ...project, ceilings: (project.ceilings ?? []).filter((c) => c.id !== selectedCeilingId) }
        : owner?.drawingId
        ? { ...project, drawings2d: project.drawings2d.filter((d) => d.id !== owner.drawingId) }
        : owner?.wallId
        ? { ...project, walls: project.walls.filter((w) => w.id !== owner.wallId) }
        : project;
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
        const candidates: { point: Vec2; dir: Vec2 }[] = [
          { point: anchor, dir: { x: 1, y: 0 } },
          { point: anchor, dir: { x: 0, y: 1 } },
        ];
        const origin = gripOriginRef.current;
        if (origin) {
          const { prev, next } = resolvePolygonNeighbors(index);
          if (prev) candidates.push({ point: prev, dir: sub(origin, prev) });
          if (next) candidates.push({ point: next, dir: sub(next, origin) });
        }
        const pt = closestAxisPoint(raw, candidates) ?? applyAngleConstraint(anchor, raw, 90);
        applyGrip(index, pt);
        setDraft({ preview: gripPreviewShapes(), vertices: [], snap: null, hud: hudFor(index, pt) });
        return;
      }
      // Snap gegen das Projekt OHNE das gerade gezogene Element (sonst fängt der
      // Punkt an sich selbst); Bezug ist der feste Nachbar-Griff, nicht der
      // laufende Werkzeug-Zustand (kein aktives Zeichenwerkzeug während des Drags).
      const snapResult = computeSnap({
        raw,
        project: snapProject,
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
        const pt = edgeEditPoint(edge, anchor, ee.locks, raw);
        applyEdgeToward(edge, anchor, pt);
        setDraft({ preview: edgePreviewShapes(), vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
        return;
      }
      if (edge.free) {
        // Keine Geometrie-Snap-Projektion (keine feste Kanten-Normale, an die
        // sich ein gefangener Punkt anlehnen könnte) — der Cursor bewegt den
        // Zielpunkt direkt, nur Ortho/Raster wirken.
        let pt = raw;
        if (mods.shift) {
          const dx = raw.x - anchor.x;
          const dy = raw.y - anchor.y;
          pt = Math.abs(dx) >= Math.abs(dy) ? { x: raw.x, y: anchor.y } : { x: anchor.x, y: raw.y };
        }
        const gs = snap.gridSize;
        if (!mods.ctrl && snap.enabled && snap.grid && gs > 0) {
          const dx = Math.round((pt.x - anchor.x) / gs) * gs;
          const dy = Math.round((pt.y - anchor.y) / gs) * gs;
          pt = { x: anchor.x + dx, y: anchor.y + dy };
        }
        applyEdgeToward(edge, anchor, pt);
        setDraft({ preview: edgePreviewShapes(), vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
        return;
      }
      // Cursor zuerst durch die Snap-Engine schicken (Ctrl unterdrückt Snap
      // wie überall sonst, siehe computeSnap). Ein GEOMETRIE-Snap (Endpunkt/
      // Mittelpunkt/Schnittpunkt/…, nicht Raster/Ortho) liefert den gefangenen
      // Punkt, der dann auf die Außennormale projiziert wird — so rastet die
      // Kante an reale Geometrie statt nur ans Raster.
      const snapResult = snapFor(raw, pxPerMeter, mods);
      const isGeometrySnap = !!snapResult && snapResult.kind !== "grid" && snapResult.kind !== "ortho";
      const cursor = isGeometrySnap ? snapResult!.point : raw;
      // Senkrechte Projektion von (Cursor − Anker) auf die Außennormale.
      const rel = sub(cursor, anchor);
      let offset = rel.x * edge.normal.x + rel.y * edge.normal.y;
      // Raster-Schritt (Snap) nur, wenn kein Geometrie-Snap gefangen wurde —
      // sonst gewinnt der gefangene Punkt.
      const step = snap.gridSize;
      if (!isGeometrySnap && !mods.ctrl && snap.enabled && snap.grid && step > 0) {
        offset = Math.round(offset / step) * step;
      }
      const pt = add(anchor, scale(edge.normal, offset));
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

  return {
    grips: displayGrips,
    gripHandleLines,
    edgeGrips,
    gripHandlers,
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
