// 2D-Griff-Editieren des aktuell einzeln selektierten Elements (Wand/2D-Element/
// Decke/Raum/Öffnung/Treppe): Eckpunkt- + Kanten-Griffe, deren Zieh-Handler
// (inkl. Ortho/Snap/koinzidente Nachbar-Ecken) sowie der Tab-Feld-Controller für
// präzise Länge/Winkel-Eingabe während eines Vertex-Drags.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef, useState, type RefObject } from "react";
import { add, dot, leftNormal, normalize, scale, sub } from "../model/geometry";
import type { Ceiling, Drawing2D, EdgeGrip, Project, Room, Stair, Vec2 } from "../model/types";
import { drawingVertices } from "./projectSlice";
import type { SnapResult, SnapSettings, ToolDraft, ToolMods } from "../tools/types";
import { applyAngleConstraint, computeSnap } from "../tools/snapping";
import { useCommandTabShortcut } from "./useKeyboardShortcuts";
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
  visibleCodes: Set<string>;
  snap: SnapSettings;
  setDraft: (draft: ToolDraft | null) => void;
  snapFor: (raw: Vec2, pxPerMeter: number, mods: ToolMods) => SnapResult | null;
  engineRef: RefObject<CommandEngine | null>;
  commandLineRef: RefObject<CommandLineHandle | null>;
  updateOpening: (id: string, patch: Record<string, unknown>) => void;
  moveStairBy: (id: string, delta: Vec2) => void;
  moveRoomGrip: (id: string, index: number, pt: Vec2) => void;
  moveCeilingGrip: (id: string, index: number, pt: Vec2) => void;
  moveGripOf: (drawingId: string | null, wallId: string | null, index: number, pt: Vec2) => void;
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
    visibleCodes,
    snap,
    setDraft,
    snapFor,
    engineRef,
    commandLineRef,
    updateOpening,
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

  const grips: Vec2[] = (() => {
    // Öffnung (Fenster/Tür): EIN Mittelpunkt-Griff auf der Wandachse. Ziehen
    // verschiebt die Öffnung entlang der Wirts-Wand (siehe applyGrip →
    // `position`). Nur bei genau einer selektierten Öffnung (Auswahl exklusiv).
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
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
    if (selectedStairId) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      if (!st) return [];
      gripOwners.push({ localIndex: 0 });
      gripOwnerRange.push([0, 0]);
      return [stairMoveHandle(st)];
    }
    // Decke: die Umriss-Vertices als Griffe (nur bei genau einer gewählten Decke,
    // solange kein 2D-Element/Wand mitgewählt ist — kein Multi-Select für Decken).
    if (selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      const pts = [...selectedCeiling.outline];
      pts.forEach((_, i) => { gripOwners.push({ localIndex: i }); gripOwnerRange.push([0, pts.length - 1]); });
      return pts;
    }
    // Raum: die Umriss-Vertices als Griffe (nur bei genau einem gewählten Raum).
    if (
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
    const pushGroup = (pts: Vec2[], owner: { drawingId?: string; wallId?: string }) => {
      if (pts.length === 0) return;
      const start = out.length;
      pts.forEach((p, i) => {
        out.push(p);
        gripOwners.push({ ...owner, localIndex: i });
      });
      const end = out.length - 1;
      for (let i = start; i <= end; i++) gripOwnerRange.push([start, end]);
    };
    for (const id of effectiveDrawingIds) {
      const d = project.drawings2d.find((x) => x.id === id);
      if (d) pushGroup(drawingVertices(d), { drawingId: id });
    }
    if (effectiveDrawingIds.length === 0) {
      for (const id of selectedWallIds) {
        const w = project.walls.find((x) => x.id === id);
        if (w) pushGroup([w.start, w.end], { wallId: id });
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
    // Geschlossener Ring aus Vertices → Kanten-Griffe mit Außennormale.
    const ringEdges = (verts: Vec2[], owner: { drawingId?: string; wallId?: string }): EdgeGrip[] => {
      const n = verts.length;
      if (n < 3) return [];
      // Schwerpunkt (Mittel der Eckpunkte) als Innenbezug.
      let cx = 0, cy = 0;
      for (const v of verts) { cx += v.x; cy += v.y; }
      const centroid: Vec2 = { x: cx / n, y: cy / n };
      const out: EdgeGrip[] = [];
      for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];
        const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const edge = sub(b, a);
        let nrm = normalize(leftNormal(edge));
        // Nach außen orientieren: Normale soll von centroid → mid weisen.
        const outward = sub(mid, centroid);
        if (nrm.x * outward.x + nrm.y * outward.y < 0) nrm = scale(nrm, -1);
        out.push({ mid, normal: nrm, aIndex: i, bIndex: (i + 1) % n, owner });
      }
      return out;
    };
    // Offene Kette (Linie/offene Polylinie) → ein Griff je Segment, OHNE
    // Schlusskante. `normal` dient nur der Griff-Darstellung (leftNormal der
    // Kante); die Bewegung ist frei (volles Delta), nicht auf die Normale
    // beschränkt — daher `free: true`.
    const openEdges = (verts: Vec2[], owner: { drawingId?: string; wallId?: string }): EdgeGrip[] => {
      const n = verts.length;
      if (n < 2) return [];
      const out: EdgeGrip[] = [];
      for (let i = 0; i < n - 1; i++) {
        const a = verts[i];
        const b = verts[i + 1];
        const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nrm = normalize(leftNormal(sub(b, a)));
        out.push({ mid, normal: nrm, aIndex: i, bIndex: i + 1, free: true, owner });
      }
      return out;
    };
    // Decke: geschlossener Ring aus dem Umriss (Auswahl exklusiv, wie bei grips).
    if (selectedCeiling && effectiveDrawingIds.length === 0 && selectedWallIds.length === 0) {
      return ringEdges(selectedCeiling.outline, {});
    }
    // Raum: geschlossener Ring aus dem Umriss.
    if (
      selectedRoom &&
      effectiveDrawingIds.length === 0 &&
      selectedWallIds.length === 0 &&
      !selectedCeiling
    ) {
      return ringEdges(selectedRoom.boundary, {});
    }
    const out: EdgeGrip[] = [];
    for (const id of effectiveDrawingIds) {
      const d = project.drawings2d.find((x) => x.id === id);
      if (!d) continue;
      const verts = drawingVertices(d);
      const g = d.geom;
      const owner = { drawingId: id };
      if (g.shape === "rect" || g.shape === "image") out.push(...ringEdges(verts, owner));
      else if (g.shape === "polyline" && g.closed) out.push(...ringEdges(verts, owner));
      else if (g.shape === "polyline" && !g.closed) out.push(...openEdges(verts, owner));
      else if (g.shape === "line") out.push(...openEdges(verts, owner));
    }
    if (effectiveDrawingIds.length === 0) {
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

  // Zuletzt angewandter Kanten-Offset während eines Edge-Grip-Drags (Anker).
  // null = kein laufender Drag; der erste Move-Event verankert nur (kein Sprung).
  const edgeDragOffsetRef = useRef<number | null>(null);
  // Freies Kanten-Ziehen (offene Polylinie/Linie): letzter roher Cursor, gegen den
  // das inkrementelle 2D-Delta gebildet wird. null = Drag noch nicht verankert.
  const edgeFreeLastRef = useRef<Vec2 | null>(null);
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
      return d ? drawingVertices(d) : [];
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
        drawingVertices(d).forEach((v, i) => {
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
    if (g && (g.shape === "circle" || g.shape === "arc")) return g.center;
    const refIndex = neighborGripIndex(index);
    return refIndex != null ? grips[refIndex] : null;
  };

  // Stabiler Ref auf cycleGripEditField (der globale Tab-Handler hat leere Deps).
  const cycleGripEditFieldRef = useRef<() => void>(() => {});
  // Tab im Vertex-Drag: Feld-Controller öffnen/zyklen (length ↔ angle).
  const cycleGripEditField = () => {
    const info = gripDragInfoRef.current;
    if (!info) return;
    const anchor = resolveGripAnchor(info.index);
    if (!anchor) return; // ohne Anker keine polare Eingabe möglich
    setGripEdit((prev) =>
      prev
        ? { ...prev, active: prev.active === "length" ? "angle" : "length" }
        : { anchor, active: "length", locks: {} },
    );
  };
  cycleGripEditFieldRef.current = cycleGripEditField;

  // Globaler Tab-Handler (Feld-Zyklus/Zahlen-Tippen) — siehe state/useKeyboardShortcuts.ts.
  useCommandTabShortcut(engineRef, commandLineRef, gripDragInfoRef, gripEditRef, cycleGripEditFieldRef);

  // Getippte Zahl im Vertex-Drag: aktives Feld locken, aufs nächste vorrücken und
  // den Zielpunkt sofort mit dem gelockten Wert neu setzen.
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

  // Editier-Dispatch: bei gewählter Decke auf die Decken-Aktionen umleiten, sonst
  // auf die Wand/2D-Aktionen. So teilen Plan- UND 3D-Griffe denselben Pfad.
  const applyGrip = (index: number, pt: Vec2) => {
    // Öffnung: den gezogenen Punkt auf die Wandachse projizieren → neue
    // `position` (Abstand des ersten Pfostens vom Wand-Start), sodass die
    // Öffnung entlang der Wand gleitet. Griff sitzt in der Öffnungsmitte, daher
    // width/2 abziehen; auf [0, Wandlänge − Breite] klemmen (Öffnung bleibt drin).
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
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
    if (selectedRoomId) moveRoomGrip(selectedRoomId, index, pt);
    else if (selectedCeilingId) moveCeilingGrip(selectedCeilingId, index, pt);
    else {
      // Mehrfachauswahl: welchem Element dieser Griff gehört, kommt aus
      // `gripOwners` (nicht mehr aus den singulären selectedDrawingId/-WallId).
      const owner = gripOwners[index];
      moveGripOf(owner?.drawingId ?? selectedDrawingId, owner?.wallId ?? selectedWallId, owner?.localIndex ?? index, pt);
    }
  };
  const applyEdge = (edge: EdgeGrip, delta: Vec2) => {
    if (selectedRoomId) moveRoomEdge(selectedRoomId, edge.aIndex, edge.bIndex, delta);
    else if (selectedCeilingId) moveCeilingEdge(selectedCeilingId, edge.aIndex, edge.bIndex, delta);
    else moveEdgeOf(edge.owner?.drawingId ?? selectedDrawingId, edge.owner?.wallId ?? selectedWallId, edge.aIndex, edge.bIndex, delta);
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

  // Aufräumen nach Abschluss/Verwerfen eines Griff-Drags (geteilt von onGripEnd
  // und onGripCancel).
  const endGripEditing = () => {
    setDraft(null);
    edgeDragOffsetRef.current = null; // Drag beendet → Anker zurücksetzen
    edgeFreeLastRef.current = null; // freien Kanten-Drag-Anker zurücksetzen
    moveCoincidentRef.current = null; // Körper-Koinzidenz-Gruppe verwerfen
    gripDragInfoRef.current = null; // (c) Vertex-Drag-Info verwerfen
    setGripEdit(null); // (c) Feld-Controller schließen
  };

  const gripHandlers = {
    onGripMove: (index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      // (c) Vertex-Drag mit aktivem Feld-Controller + Locks: den Zielpunkt polar
      // aus Anker + gelockter Länge/Winkel bilden (ungelockt folgt dem Cursor).
      const ge = gripEditRef.current;
      gripDragInfoRef.current = { index, raw };
      if (ge && (ge.locks.length != null || ge.locks.angle != null)) {
        const pt = gripEditPoint(ge.anchor, ge.locks, raw);
        applyGrip(index, pt);
        setDraft({ preview: [], vertices: [], snap: null, hud: hudFor(index, pt) });
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
      // Shift = Ortho-Lock: den gezogenen Punkt auf H/V gegenüber dem FIXEN Anker
      // zwingen (Achse = die nähere; applyAngleConstraint mit 90°, wie Ortho beim
      // Zeichnen). Der Lock dominiert (kein Snap), damit die Endkoordinate
      // garantiert eine Achse mit dem Anker teilt — identisch zum 3D-Vertex-Drag.
      if (mods.shift && anchor) {
        const pt = applyAngleConstraint(anchor, raw, 90);
        applyGrip(index, pt);
        setDraft({ preview: [], vertices: [], snap: null, hud: hudFor(index, pt) });
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
      setDraft({ preview: [], vertices: [], snap: snapResult, hud: hudFor(index, pt) });
    },
    onMoveBody: (
      delta: Vec2,
      target?: { wallId?: string; drawingId?: string },
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
      // Decke: ganzen Umriss verschieben (kein Multi-Koinzidenz-Handling nötig).
      if (selectedCeilingId && !target) {
        moveCeilingBy(selectedCeilingId, delta);
        return;
      }
      // Treppe: ganzen Antritt (+ Zentrum) verschieben.
      if (selectedStairId && !target) {
        moveStairBy(selectedStairId, delta);
        return;
      }
      // Raum: ganzen Umriss (+ Stempel-Anker) verschieben.
      if (selectedRoomId && !target) {
        moveRoomBy(selectedRoomId, delta);
        return;
      }
      // Gegriffenes Element: bei Mehrfachauswahl das unter dem Cursor (target),
      // sonst das einzeln selektierte. Wand UND 2D schließen sich aus.
      const moveDrawingId = target ? target.drawingId ?? null : selectedDrawingId;
      const moveWallId = target ? target.wallId ?? null : selectedWallId;
      moveElementByOf(moveDrawingId, moveWallId, delta);
      // Beim ersten Move-Event die Koinzidenz-Gruppe einmalig bestimmen (Snapshot
      // VOR der ersten Mutation der Siblings). Danach inkrementell mitführen.
      if (moveCoincidentRef.current === null) {
        moveCoincidentRef.current = findMoveCoincident2D(moveDrawingId, moveWallId);
      }
      for (const c of moveCoincidentRef.current) {
        c.pos = { x: c.pos.x + delta.x, y: c.pos.y + delta.y };
        moveGripOf(c.drawingId, c.wallId, c.index, c.pos);
      }
    },
    // Kanten-Griff ziehen. Zwei Verhalten:
    //  • free (offene Polylinie/Linie, §Task B): das Segment folgt dem VOLLEN
    //    Cursor-Delta — beide Endpunkte wandern gleich, die geteilten Ecken ziehen
    //    die Nachbar-Segmente nach. Shift = Ortho (H/V) auf das Gesamt-Delta.
    //  • sonst (rect/geschlossene Polylinie/Wand): NUR die Komponente senkrecht
    //    zur Kante (Seite verschiebt sich parallel nach außen/innen). Fängt an
    //    eingeschalteten Geometrie-Snaps (Endpunkt/Mittelpunkt/Schnittpunkt/…);
    //    ohne Geometrie-Snap wird der Offset wie bisher aufs Raster gerundet.
    onEdgeMove: (edge: EdgeGrip, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      if (edge.free) {
        // Freier Fall arbeitet mit einem inkrementellen Cursor-DELTA (nicht
        // einem absoluten Punkt) — eine Geometrie-Snap-Projektion auf die
        // Normale ergibt hier keinen Sinn, da es keine feste Kanten-Normale
        // gibt, an die sich ein gefangener Punkt anlehnen könnte. Bleibt beim
        // bisherigen Raster-Delta-Verhalten.
        //
        // Inkrementelles 2D-Delta gegen den letzten rohen Cursor. Erster Event
        // verankert nur (kein Sprung, da der Griff am Kanten-Mittelpunkt sitzt).
        const last = edgeFreeLastRef.current;
        edgeFreeLastRef.current = raw;
        if (last === null) return;
        let dx = raw.x - last.x;
        let dy = raw.y - last.y;
        // Raster-Schritt auf das Delta (Snap aktiv, nicht per Ctrl unterdrückt).
        const gs = snap.gridSize;
        if (!mods.ctrl && snap.enabled && snap.grid && gs > 0) {
          dx = Math.round(dx / gs) * gs;
          dy = Math.round(dy / gs) * gs;
          if (dx === 0 && dy === 0) {
            edgeFreeLastRef.current = last; // noch kein voller Rasterschritt → warten
            return;
          }
        }
        // Shift = Ortho: das Delta auf die dominante Achse (H/V) zwingen.
        if (mods.shift) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (dx === 0 && dy === 0) return;
        applyEdge(edge, { x: dx, y: dy });
        setDraft({ preview: [], vertices: [], snap: null });
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
      // Senkrechte Projektion von (Cursor − Grab-Mittelpunkt) auf die Außennormale.
      const rel = sub(cursor, edge.mid);
      let offset = rel.x * edge.normal.x + rel.y * edge.normal.y;
      // Raster-Schritt (Snap) nur, wenn kein Geometrie-Snap gefangen wurde —
      // sonst gewinnt der gefangene Punkt.
      const step = snap.gridSize;
      if (!isGeometrySnap && !mods.ctrl && snap.enabled && snap.grid && step > 0) {
        offset = Math.round(offset / step) * step;
      }
      // INKREMENTELL + Grab-Anker: moveEdge verschiebt additiv, daher nur die
      // Änderung seit dem letzten Event anwenden. Erster Event verankert nur
      // (kein Sprung beim Greifen, da das Dreieck am Mittelpunkt sitzt).
      const prev = edgeDragOffsetRef.current;
      edgeDragOffsetRef.current = offset;
      if (prev === null) return;
      const inc = offset - prev;
      if (inc === 0) return;
      applyEdge(edge, scale(edge.normal, inc));
      setDraft({ preview: [], vertices: [], snap: isGeometrySnap ? snapResult : null });
    },
    onGripEnd: () => {
      endGripEditing();
    },
    // Bewaffneten Punkt-Griff verwerfen (Escape): exakt auf `origin`
    // zurücksetzen — ohne Snap/Ortho-Neuauswertung, ein reiner Revert — und
    // danach wie onGripEnd aufräumen.
    onGripCancel: (index: number, origin: Vec2) => {
      applyGrip(index, origin);
      endGripEditing();
    },
  };

  return {
    grips,
    edgeGrips,
    gripHandlers,
    gripEdit,
    setGripEdit,
    gripEditFields,
    cycleGripEditField,
    submitGripEditValue,
  };
}
