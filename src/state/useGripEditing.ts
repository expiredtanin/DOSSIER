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
    if (g && (g.shape === "circle" || g.shape === "arc")) return g.center;
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
    if (g.shape === "polyline") return ringNeighborPts(g.pts, owner.localIndex, !!g.closed);
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
  // Kante auf einen ABSOLUTEN Zielpunkt (relativ zum ORIGINALEN Anker) bewegen —
  // moveEdge* ist additiv, daher nur die Differenz zum zuletzt angewandten Delta
  // anwenden (s. edgeAppliedDeltaRef). Trägt sowohl Maus-geführte Bewegung als
  // auch gelockte Feldwerte UND das Verwerfen (Ziel = Anker selbst → Delta 0,
  // die Differenz zum vorherigen Delta macht die ganze Verschiebung rückgängig).
  const applyEdgeToward = (edge: EdgeGrip, anchor: Vec2, pt: Vec2) => {
    const desired = sub(pt, anchor);
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
    gripOriginRef.current = null; // Flucht-Bezugspunkt verwerfen
    setGripEdit(null); // (c) Feld-Controller schließen
    edgeDragInfoRef.current = null; // Kanten-Drag-Info verwerfen
    setEdgeEdit(null); // Kanten-Feld-Controller schließen
  };

  const gripHandlers = {
    onGripMove: (index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
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
        setDraft({ preview: [], vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
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
        setDraft({ preview: [], vertices: [], snap: null, hud: edgeHudFor(edge, anchor, pt) });
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
        preview: [],
        vertices: [],
        snap: isGeometrySnap ? snapResult : null,
        hud: edgeHudFor(edge, anchor, pt),
      });
    },
    onGripEnd: () => {
      endEditing();
    },
    // Bewaffneten Punkt-Griff verwerfen (Escape): exakt auf `origin`
    // zurücksetzen — ohne Snap/Ortho-Neuauswertung, ein reiner Revert — und
    // danach wie onGripEnd aufräumen.
    onGripCancel: (index: number, origin: Vec2) => {
      applyGrip(index, origin);
      endEditing();
    },
    onEdgeEnd: () => {
      endEditing();
    },
    // Bewaffneten Kanten-Griff verwerfen (Escape): Ziel = Anker selbst (Delta
    // 0) — applyEdgeToward macht dadurch die komplette bisherige Verschiebung
    // in einem Schritt rückgängig (negatives Delta zum zuletzt angewandten).
    onEdgeCancel: (edge: EdgeGrip, anchor: Vec2) => {
      applyEdgeToward(edge, anchor, anchor);
      endEditing();
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
