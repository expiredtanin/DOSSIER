// 3D-Editier-Griffe direkt im Viewport3D ([121] aus App.tsx herausgelöst): Quellen der Griffe
// (gewählte Wände/2D-Elemente/Decken/Dächer), Fang beim Ziehen, Cursor-HUD und der Feld-Controller
// (Tab/getippte Werte) eines laufenden 3D-Griff-Drags. Die zurückgegebenen Handler sind
// referenzstabil (`useEvent`), damit der memoisierte Viewport nicht bei jedem App-Render neu zeichnet.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useMemo, useRef, useState, type RefObject } from "react";
import type { Ceiling, Drawing2D, Project, Roof, Vec2, Wall } from "../model/types";
import type { SnapResult, SnapSettings, ToolDraft } from "../tools/types";
import { computeSnap } from "../tools/snapping";
import { roofBaseElevation, roofGeometry } from "../core";
import {
  neighbor3dVertex,
  bodyMoveAnchor,
  hudFromAnchor,
  grip3dTargetKey,
  grip3dEditPoint,
  cycleGrip3dEditState,
  nextGrip3dEditState,
  type Grip3dTarget,
  type Grip3dEditState,
} from "../viewport/grip3dHud";
import type { CommandLineHandle } from "../ui/CommandLine";
import { useEvent } from "./useEvent";
import type { useSelectionState } from "./useSelectionState";
import type { Selection } from "./selection";
import type { useProjectActions } from "./useProjectActions";

type Sel = ReturnType<typeof useSelectionState>;
type Actions = ReturnType<typeof useProjectActions>;

export function useGrip3dEditing(opts: {
  project: Project;
  levelId: string;
  visibleCodes: Set<string>;
  snap: SnapSettings;
  setDraft: (d: ToolDraft | null) => void;
  undo: () => void;
  commandLineRef: RefObject<CommandLineHandle>;
  selection: Selection;
  updateRoof: Sel["updateRoof"];
  moveRoofGrip: Sel["moveRoofGrip"];
  moveRoofBy: Sel["moveRoofBy"];
  moveCeilingGrip: Actions["moveCeilingGrip"];
  moveCeilingBy: Actions["moveCeilingBy"];
  moveCeilingEdge: Actions["moveCeilingEdge"];
  moveGripOf: Actions["moveGripOf"];
  moveElementByOf: Actions["moveElementByOf"];
  updateWall: Actions["updateWall"];
}) {
  const {
    project,
    levelId,
    visibleCodes,
    snap,
    setDraft,
    undo,
    commandLineRef,
    selection,
    updateRoof,
    moveRoofGrip,
    moveRoofBy,
    moveCeilingGrip,
    moveCeilingBy,
    moveCeilingEdge,
    moveGripOf,
    moveElementByOf,
    updateWall,
  } = opts;
  const { walls: selectedWallIds, drawings: selectedDrawingIds, ceilings: selectedCeilingIds, roofs: selectedRoofIds } = selection;
  // ── 3D-Editier-Griffe (direkt im Viewport3D) ──────────────────────────────
  // Genau EINE gewählte Wand (kein 2D-Element) bzw. genau EIN 2D-Element liefert
  // die Quelle der 3D-Griffe. Dieselben Store-Actions wie bei den Plan-Griffen
  // (moveGripOf/moveElementByOf), damit Plan + 3D identisch mutieren. Der Höhen-
  // Griff bindet die OK absolut (top=custom z) — gleicher Pfad wie das Attribut-
  // Panel (updateWall top).
  // Alle gewählten Wände/2D-Elemente als Quelle der 3D-Griffe. Wände UND 2D-
  // Elemente schließen sich gegenseitig aus (entweder-oder), damit der einzelne
  // Element-Editierpfad (moveGripOf je ID) eindeutig bleibt. Bei Mehrfachauswahl
  // erscheinen Griffe für ALLE — Basis für das gemeinsame Ziehen koinzidenter Ecken.
  const edit3dWalls = useMemo(
    () =>
      selectedDrawingIds.length === 0
        ? selectedWallIds
            .map((id) => project.walls.find((w) => w.id === id))
            .filter((w): w is Wall => !!w)
        : [],
    [selectedWallIds, selectedDrawingIds, project.walls],
  );
  const edit3dDrawings = useMemo(
    () =>
      selectedWallIds.length === 0
        ? selectedDrawingIds
            .map((id) => project.drawings2d.find((d) => d.id === id))
            .filter((d): d is Drawing2D => !!d)
        : [],
    [selectedWallIds, selectedDrawingIds, project.drawings2d],
  );
  // Gewählte Decken → 3D-Eckpunkt-/Kanten-/Verschiebe-Griffe. Nur wenn keine
  // Wände/2D-Elemente mitselektiert sind (eindeutiger Editierfokus).
  const edit3dCeilings = useMemo(
    () =>
      selectedWallIds.length === 0 && selectedDrawingIds.length === 0
        ? selectedCeilingIds
            .map((id) => (project.ceilings ?? []).find((c) => c.id === id))
            .filter((c): c is Ceiling => !!c)
        : [],
    [selectedWallIds, selectedDrawingIds, selectedCeilingIds, project.ceilings],
  );
  // Dächer mit 3D-Griffen: nur wenn ausschliesslich Dächer gewählt sind
  // (Eck-Griffe zum Resizen, Move-Griff, First-Griff für die Neigung).
  const edit3dRoofs = useMemo(
    () =>
      selectedWallIds.length === 0 &&
      selectedDrawingIds.length === 0 &&
      selectedCeilingIds.length === 0
        ? selectedRoofIds
            .map((id) => (project.roofs ?? []).find((r) => r.id === id))
            .filter((r): r is Roof => !!r)
        : [],
    [selectedWallIds, selectedDrawingIds, selectedCeilingIds, selectedRoofIds, project.roofs],
  );
  // Snap beim 3D-Vertex-Drag: dieselbe computeSnap-Logik wie die Plan-Griffe.
  // Das/die gerade GEZOGENEN Element(e) werden aus den Snap-Quellen genommen
  // (sonst fängt der Punkt an sich selbst). `excludeWallIds`/`excludeDrawingIds`
  // sind die Mitglieder der Koinzidenz-Gruppe (alle, die mitgeführt werden).
  const snapFor3dVertex = (
    raw: Vec2,
    excludeWallIds: Set<string>,
    excludeDrawingIds: Set<string>,
  ): SnapResult | null => {
    return computeSnap({
      raw,
      project,
      excludeIds: [...excludeWallIds, ...excludeDrawingIds],
      levelId,
      visibleCodes,
      settings: snap,
      draftPoints: [],
      lastPoint: null,
      // 3D hat kein echtes pxPerMeter; ein vernünftiger Fallback hält die
      // Snap-Toleranz (tolerancePx/pxPerMeter) in einem brauchbaren Meter-Bereich.
      pxPerMeter: 90,
      shift: false,
      ctrl: false,
    });
  };
  // Cursor-HUD (Länge/Winkel bzw. Δx/Δy) für einen 3D-Griff-Drag — Nutzer-
  // Report „beim Verschieben von Elementen zeigt es die Werte nicht an": die
  // 3D-Griffe (`onEdit3dVertex`/`onEdit3dBody`) mutierten das Modell bisher
  // OHNE je `setDraft(...)` mit einem `hud` zu füllen (anders als die 2D-
  // Griff-Bearbeitung, `state/useGripEditing.ts::hudFor`/`edgeHudFor`, die das
  // von Anfang an tat) — der Cursor-HUD blieb daher leer, obwohl der Kanal
  // (`hudFields`/`draft.hud`, s. `Wasm3DViewport.tsx`) längst bis in den 3D-
  // Viewport durchgereicht ist. Die reine Geometrie (Nachbar-/Anker-Auflösung)
  // lebt in `viewport/grip3dHud.ts` (eigenständig testbar).
  //
  // Läuft während eines „move"-Griff-Drags (ganzes Element verschieben): sammelt
  // die seit Drag-Beginn angewandten Deltas je Ziel-Element, damit das HUD die
  // GESAMTE Verschiebung zeigt statt des winzigen Pro-Event-Deltas. `rawTotal`
  // = reine Maus-Summe (auch bei aktivem Feld-Controller weitergeführt, damit
  // ein entsperrtes Feld sofort wieder der Maus folgt); `appliedTotal` = was
  // TATSÄCHLICH aufs Modell angewandt wurde (kann bei Locks abweichen). Reset
  // bei Ziel-Wechsel (neuer Drag) UND in `onEdit3dEnd` (Drag-Ende).
  const bodyDragRef = useRef<{ key: string; anchor: Vec2; rawTotal: Vec2; appliedTotal: Vec2 } | null>(
    null,
  );
  // Feld-Controller (Tab-Zyklus, getippte Werte) für einen laufenden 3D-Griff-
  // Drag — Nutzer-Report „man sieht Länge/Winkel, aber man kann nichts
  // eingeben". Eigenständiges 3D-Äquivalent zu `useGripEditing.ts`s `gripEdit`
  // (s. `viewport/grip3dHud.ts`-Dateikommentar für das „warum eigenständig").
  const [grip3dEdit, setGrip3dEdit] = useState<Grip3dEditState | null>(null);
  // Letzter bekannter roh (maus-getriebener, UN-gelockter) Zustand des
  // laufenden 3D-Griff-Drags — Grundlage fürs ÖFFNEN des Feld-Controllers
  // (Tab friert die AKTUELLE Position ein, s. `cycleGrip3dEditState`).
  const last3dDragRef = useRef<
    { target: Grip3dTarget; index: number; kind: "vertex" | "move"; anchor: Vec2; raw: Vec2 } | null
  >(null);
  // Ein 3D-Vertex-Griff wurde gezogen. `target` benennt das konkrete Element
  // (Wand-ID ODER Drawing-ID), `index` den Vertex. Liefert den effektiv
  // angewandten (gesnappten) Punkt zurück — der 3D-Viewport nutzt ihn, um
  // koinzidente Endpunkte anderer gewählter Elemente mitzuführen und den
  // Snap-Marker zu zeigen. `snapped=false` (für mitgeführte Geschwister) wendet
  // den Punkt direkt an, ohne erneut zu snappen.
  // Reine Mutations-Anwender OHNE Lock-/Snap-/HUD-Logik — von `onEdit3dVertex`/
  // `onEdit3dBody` (Maus-Pfad) UND `submitGrip3dEditValue` (Tastatur-Pfad)
  // gemeinsam genutzt, damit Letzterer NICHT `onEdit3dVertex`/`onEdit3dBody`
  // rekursiv aufruft — das würde `grip3dEdit`/`bodyDragRef` über einen VERALTETEN
  // Closure-Wert lesen (React-State ist innerhalb desselben Funktionsaufrufs
  // noch nicht aktualisiert) und den gerade getippten Wert wieder verwerfen.
  const applyVertexPoint = (target: Grip3dTarget, index: number, pt: Vec2) => {
    if (target.roofId) moveRoofGrip(target.roofId, index, pt);
    else if (target.ceilingId) moveCeilingGrip(target.ceilingId, index, pt);
    else moveGripOf(target.drawingId ?? null, target.wallId ?? null, index, pt);
  };
  const applyBodyDelta = (target: Grip3dTarget, delta: Vec2) => {
    if (target.roofId) moveRoofBy(target.roofId, delta);
    else if (target.ceilingId) moveCeilingBy(target.ceilingId, delta);
    else moveElementByOf(target.drawingId ?? null, target.wallId ?? null, delta);
  };
  const onEdit3dVertex = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ): Vec2 => {
    // Nachbarpunkt VOR der Mutation auflösen (Wand/Zeichnung/Decke/Dach ändern
    // sich hier nur am gezogenen `index`, der Nachbar bleibt stabil).
    const neighbor = neighbor3dVertex(project, target, index);
    let pt = model;
    let snapHit: SnapResult | null = null;
    const ge = grip3dEdit;
    if (
      ge &&
      ge.kind === "vertex" &&
      ge.index === index &&
      grip3dTargetKey(ge.target) === grip3dTargetKey(target) &&
      (ge.locks.length != null || ge.locks.angle != null)
    ) {
      // Feld-Controller aktiv: getippte/eingefrorene Werte übersteuern die
      // Maus — kein Snap währenddessen (deckungsgleich mit 2D `onGripMove`).
      pt = grip3dEditPoint(ge.anchor, ge.locks, model);
    } else if (excludeWallIds || excludeDrawingIds) {
      const snapResult = snapFor3dVertex(
        model,
        excludeWallIds ?? new Set(),
        excludeDrawingIds ?? new Set(),
      );
      pt = snapResult?.point ?? model;
      snapHit = snapResult;
    }
    applyVertexPoint(target, index, pt);
    if (neighbor) last3dDragRef.current = { target, index, kind: "vertex", anchor: neighbor, raw: model };
    setDraft({
      preview: [],
      vertices: [],
      snap: snapHit,
      hud: neighbor ? hudFromAnchor(neighbor, pt) : undefined,
    });
    return pt;
  };
  const onEdit3dBody = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
    locked = false,
  ) => {
    const key = grip3dTargetKey(target);
    if (!bodyDragRef.current || bodyDragRef.current.key !== key) {
      bodyDragRef.current = {
        key,
        anchor: bodyMoveAnchor(project, target) ?? { x: 0, y: 0 },
        rawTotal: { x: 0, y: 0 },
        appliedTotal: { x: 0, y: 0 },
      };
    }
    const st = bodyDragRef.current;
    st.rawTotal = { x: st.rawTotal.x + delta.x, y: st.rawTotal.y + delta.y };
    const rawPoint: Vec2 = { x: st.anchor.x + st.rawTotal.x, y: st.anchor.y + st.rawTotal.y };
    const ge = grip3dEdit;
    let bodySnap: SnapResult | null = null;
    let desiredPoint: Vec2;
    if (ge && ge.kind === "move" && grip3dTargetKey(ge.target) === key && (ge.locks.length != null || ge.locks.angle != null)) {
      desiredPoint = grip3dEditPoint(ge.anchor, ge.locks, rawPoint);
    } else if (locked) {
      desiredPoint = rawPoint; // Shift/Achs-Sperre hat Vorrang vor dem Einrasten
    } else {
      // Referenzpunkt des Körpers rastet auf andere Punkte ein
      bodySnap = snapFor3dVertex(
        rawPoint,
        new Set(target.wallId ? [target.wallId] : []),
        new Set(target.drawingId ? [target.drawingId] : []),
      );
      desiredPoint = bodySnap?.point ?? rawPoint;
    }
    const desiredTotal: Vec2 = { x: desiredPoint.x - st.anchor.x, y: desiredPoint.y - st.anchor.y };
    const appliedDelta: Vec2 = {
      x: desiredTotal.x - st.appliedTotal.x,
      y: desiredTotal.y - st.appliedTotal.y,
    };
    applyBodyDelta(target, appliedDelta);
    st.appliedTotal = desiredTotal;
    last3dDragRef.current = { target, index: -1, kind: "move", anchor: st.anchor, raw: rawPoint };
    setDraft({
      preview: [],
      vertices: [],
      snap: bodySnap,
      hud: { at: desiredPoint, dx: desiredTotal.x, dy: desiredTotal.y },
    });
  };
  // Tab während eines laufenden 3D-Griff-Drags (Endpunkt ODER Verschieben):
  // Feld-Controller öffnen/zykeln — analog `useGripEditing.ts::
  // cycleGripEditField`, aber auf `last3dDragRef` als Zustandsquelle statt
  // der 2D-Grips-Liste. `Wasm3DViewport.tsx` ruft dies auf einem eigenen
  // Tastatur-Listener auf (nur solange EIN 3D-Griff-Drag läuft — s. dort).
  const cycleGrip3dEditField = () => {
    const info = last3dDragRef.current;
    if (!info) return;
    setGrip3dEdit((prev) => cycleGrip3dEditState(prev, info));
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };
  // Escape während eines laufenden 3D-Griff-Drags: abbrechen. ALLE fünf
  // Griff-Mutationen coalescen ihre Schritte zu GENAU einem Undo-Eintrag pro
  // Drag (s. `state/projectSlice.ts::moveGripOf`/`updateWall`/… -Doc), ein
  // einzelner `undo()` reicht also, um den GESAMTEN Drag zu verwerfen statt
  // nur den letzten Mikro-Schritt. `Wasm3DViewport.tsx` räumt seinen eigenen
  // (lokalen) Drag-Zustand danach selbst auf (`endGripDrag`); hier nur der
  // Modell-Zustand + der App-seitige Aufräum-Teil (`onEdit3dEnd`).
  const cancelGrip3dEdit = () => {
    undo();
    onEdit3dEnd();
  };
  // Getippter Zahlenwert im 3D-Feld-Controller — analog `submitGripEditValue`.
  // Nutzt `applyVertexPoint`/`applyBodyDelta` (NICHT `onEdit3dVertex`/
  // `onEdit3dBody` selbst, s. deren Dateikommentar oben).
  const submitGrip3dEditValue = (value: number) => {
    const ge = grip3dEdit;
    if (!ge) return;
    const next = nextGrip3dEditState(ge, value);
    setGrip3dEdit(next);
    const raw = last3dDragRef.current?.raw ?? next.anchor;
    const pt = grip3dEditPoint(next.anchor, next.locks, raw);
    if (next.kind === "vertex") {
      applyVertexPoint(next.target, next.index, pt);
      last3dDragRef.current = { target: next.target, index: next.index, kind: "vertex", anchor: next.anchor, raw };
      setDraft({ preview: [], vertices: [], snap: null, hud: hudFromAnchor(next.anchor, pt) });
      return;
    }
    const st = bodyDragRef.current;
    if (!st) return;
    const desiredTotal: Vec2 = { x: pt.x - st.anchor.x, y: pt.y - st.anchor.y };
    const appliedDelta: Vec2 = {
      x: desiredTotal.x - st.appliedTotal.x,
      y: desiredTotal.y - st.appliedTotal.y,
    };
    applyBodyDelta(next.target, appliedDelta);
    st.appliedTotal = desiredTotal;
    last3dDragRef.current = { target: next.target, index: -1, kind: "move", anchor: next.anchor, raw };
    setDraft({ preview: [], vertices: [], snap: null, hud: { at: pt, dx: desiredTotal.x, dy: desiredTotal.y } });
  };
  // First-Griff: neue First-Höhe (world-Y = Modell-Höhe) → Dachneigung. Aus der
  // aktuellen Neigung die halbe Spannweite ableiten und daraus den neuen Winkel
  // rechnen (behält die Firstlage, ändert nur die Steilheit).
  const onEdit3dRoofPitch = (roofId: string, apexHeight: number) => {
    const roof = (project.roofs ?? []).find((r) => r.id === roofId);
    if (!roof) return;
    const baseZ = roofBaseElevation(project, roof);
    const geom = roofGeometry(roof, baseZ);
    const currentRidge = geom.ridgeHeight; // Höhe First über Traufe
    const newRidge = Math.max(0.05, apexHeight - baseZ);
    const curPitch = ((roof.pitchDeg ?? 30) * Math.PI) / 180;
    // Halbe Spannweite aus aktueller Geometrie (First/tan(Neigung)).
    const halfSpan = currentRidge > 1e-4 ? currentRidge / Math.tan(curPitch || 1e-3) : 1;
    const newPitch = (Math.atan(newRidge / Math.max(0.05, halfSpan)) * 180) / Math.PI;
    // coalesceKey: EIN First-Drag (viele Maus-Move-Schritte) soll EINEN Undo-
    // Schritt erzeugen, s. `state/projectSlice.ts::updateRoof`-Doc.
    updateRoof(roofId, { pitchDeg: Math.max(1, Math.min(85, newPitch)) }, `onEdit3dRoofPitch:${roofId}`);
    // Cursor-HUD (First-Höhe) — bislang zeigten Höhen-/Kanten-/First-Griff als
    // einzige 3D-Griffe GAR KEINEN Wert (Nutzer-Wunsch „generell weiter
    // optimieren"). Anker = Dach-Schwerpunkt (`bodyMoveAnchor`, dieselbe
    // Formel wie der Verschiebe-Griff).
    const at = bodyMoveAnchor(project, { roofId });
    if (at) setDraft({ preview: [], vertices: [], snap: null, hud: { at, text: `First: ${apexHeight.toFixed(3)}m` } });
  };
  // Läuft während eines Kanten-Griff-Drags (Decke): sammelt die seit Drag-
  // Beginn angewandte Verschiebung fürs Δ-HUD — analog `bodyDragRef`, aber
  // ohne Lock-Unterstützung (kein Feld-Controller für Kanten, s. PENDENZEN).
  const edgeDragRef = useRef<{ key: string; start: Vec2; raw: Vec2; applied: Vec2; total?: Vec2 } | null>(null);
  const onEdit3dEdge = (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => {
    const key = `${ceilingId}:${aIndex}:${bIndex}`;
    if (!edgeDragRef.current || edgeDragRef.current.key !== key) {
      const c0 = (project.ceilings ?? []).find((x) => x.id === ceilingId);
      const a0 = c0?.outline[aIndex] ?? { x: 0, y: 0 };
      edgeDragRef.current = { key, start: { x: a0.x, y: a0.y }, raw: { x: 0, y: 0 }, applied: { x: 0, y: 0 } };
    }
    const st = edgeDragRef.current;
    st.raw = { x: st.raw.x + delta.x, y: st.raw.y + delta.y };
    // Der Kanten-Startpunkt rastet auf andere Wand-/Zeichnungspunkte ein; die Kante
    // folgt um dasselbe Delta (inkrementell, damit der Store-Aufruf gleich bleibt).
    const rawPoint: Vec2 = { x: st.start.x + st.raw.x, y: st.start.y + st.raw.y };
    const edgeSnap = snapFor3dVertex(rawPoint, new Set(), new Set());
    const snapped = edgeSnap?.point ?? rawPoint;
    const total: Vec2 = { x: snapped.x - st.start.x, y: snapped.y - st.start.y };
    const step: Vec2 = { x: total.x - st.applied.x, y: total.y - st.applied.y };
    if (step.x !== 0 || step.y !== 0) moveCeilingEdge(ceilingId, aIndex, bIndex, step);
    st.applied = total;
    st.total = total;
    const c = (project.ceilings ?? []).find((x) => x.id === ceilingId);
    const a = c?.outline[aIndex];
    const b = c?.outline[bIndex];
    if (a && b) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(st.total.x, st.total.y);
      setDraft({ preview: [], vertices: [], snap: edgeSnap, hud: { at: mid, text: `Δ: ${dist.toFixed(3)}m` } });
    }
  };
  const onEdit3dWallTop = (wallId: string, topZ: number) => {
    // coalesceKey: EIN Höhen-Drag soll EINEN Undo-Schritt erzeugen, s.
    // `state/projectSlice.ts::updateWall`-Doc.
    updateWall(wallId, { top: { mode: "custom", z: topZ } }, `onEdit3dWallTop:${wallId}`);
    const at = bodyMoveAnchor(project, { wallId });
    if (at) setDraft({ preview: [], vertices: [], snap: null, hud: { at, text: `OK: ${topZ.toFixed(3)}m` } });
  };
  const onEdit3dEnd = () => {
    bodyDragRef.current = null;
    edgeDragRef.current = null;
    last3dDragRef.current = null;
    setGrip3dEdit(null);
    setDraft(null);
  };

  return {
    edit3dWalls,
    edit3dDrawings,
    edit3dCeilings,
    edit3dRoofs,
    grip3dEdit,
    setGrip3dEdit,
    last3dDragRef,
    onEdit3dVertex: useEvent(onEdit3dVertex),
    onEdit3dBody: useEvent(onEdit3dBody),
    onEdit3dEdge: useEvent(onEdit3dEdge),
    onEdit3dRoofPitch: useEvent(onEdit3dRoofPitch),
    onEdit3dWallTop: useEvent(onEdit3dWallTop),
    onEdit3dEnd: useEvent(onEdit3dEnd),
    cycleGrip3dEditField: useEvent(cycleGrip3dEditField),
    cancelGrip3dEdit: useEvent(cancelGrip3dEdit),
    submitGrip3dEditValue: useEvent(submitGrip3dEditValue),
  };
}
