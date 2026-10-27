// Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D. Übersetzt rohe Pick-/
// Marquee-/Kontextmenü-Events aus PlanView/Viewport3D in Selektions-Mutationen
// (+ ein paar eng verwandte Doppelklick-Trigger: Raum-Stempel-Editor, Text-
// Inhalts-Editor). Reine Verschiebung aus App.tsx, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project, Vec2 } from "../model/types";
import type { CategoryDisplayResolver } from "../plan/generatePlan";
import type { DisplayResolver } from "../viewport/Viewport3D";
import type { PlanSelection, MarqueeSelection } from "../plan/PlanView";
import type { Pick3dHit } from "../viewport/Wasm3DViewport";
import type { RichTextDoc } from "../text/richText";
import { plainText } from "../text/richText";
import { hitTestWall } from "../viewport/planHitTest";
import type { useSelectionState } from "./useSelectionState";
import type { useContextMenuState } from "../menus/useContextMenuState";
import {
  EMPTY_MEMBERSHIP,
  expandToGroups,
  isInsideActiveGroup,
  type GroupMembership,
  type MemberKind,
} from "./groupActions";

/** `PlanSelection`s einzelnes Treffer-Feld als (Art, ID) — oder `null` (Leerraum). */
function selHit(sel: PlanSelection): { kind: MemberKind; id: string } | null {
  if (sel.wallId) return { kind: "wallIds", id: sel.wallId };
  if (sel.drawingId) return { kind: "drawingIds", id: sel.drawingId };
  if (sel.ceilingId) return { kind: "ceilingIds", id: sel.ceilingId };
  if (sel.openingId) return { kind: "openingIds", id: sel.openingId };
  if (sel.stairId) return { kind: "stairIds", id: sel.stairId };
  if (sel.roomId) return { kind: "roomIds", id: sel.roomId };
  if (sel.columnId) return { kind: "columnIds", id: sel.columnId };
  if (sel.roofId) return { kind: "roofIds", id: sel.roofId };
  return null;
}

export function useMouseSelectionHandlers(opts: {
  project: Project;
  /** `coalesceKey`: s. `projectSlice.ts` `setProject` — von `commitTextEdit`
   *  genutzt, damit EIN Tipp-Vorgang EINEN Undo-Schritt erzeugt (wie beim
   *  Griff-Ziehen), statt bei jedem Tastendruck einen neuen zu pushen. */
  setProject: (updater: (p: Project) => Project, coalesceKey?: string) => void;
  activeLevelId: string;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  /** Darstellungsmodus-Resolver je Zeichnungsebene-ID (wie categoryDisplay,
   * nur für Geschoss/Zeichnung) — sperrt Elemente einer nicht-aktiven,
   * überlagerten Ebene analog zum Kategorie-Sperren unten. */
  floorDisplay: CategoryDisplayResolver & DisplayResolver;
  selectionState: Pick<
    ReturnType<typeof useSelectionState>,
    | "selectedWallIds"
    | "setSelectedWallIds"
    | "selectedDrawingIds"
    | "setSelectedDrawingIds"
    | "setSelectedDrawingId"
    | "selectedCeilingIds"
    | "setSelectedCeilingIds"
    | "selectedOpeningIds"
    | "setSelectedOpeningIds"
    | "selectedStairIds"
    | "setSelectedStairIds"
    | "selectedRoomIds"
    | "setSelectedRoomIds"
    | "selectedExtrudedSolidIds"
    | "setSelectedExtrudedSolidIds"
    | "selectedColumnIds"
    | "setSelectedColumnIds"
    | "selectedRoofIds"
    | "setSelectedRoofIds"
    | "selectedContextObjectIds"
    | "setSelectedContextObjectIds"
    | "selectedSectionLineIds"
    | "setSelectedSectionLineIds"
    | "selectedGroupIds"
    | "setSelectedGroupIds"
    | "groupPath"
  >;
  contextMenuState: Pick<
    ReturnType<typeof useContextMenuState>,
    "setMenu" | "setStampEditorRoomId" | "editTextId" | "setEditTextId" | "setEditTextMinHeightM"
  >;
}) {
  const { project, setProject, activeLevelId, visibleCodes, categoryDisplay, floorDisplay, selectionState, contextMenuState } = opts;
  const {
    selectedWallIds,
    setSelectedWallIds,
    selectedDrawingIds,
    setSelectedDrawingIds,
    setSelectedDrawingId,
    selectedCeilingIds,
    setSelectedCeilingIds,
    selectedOpeningIds,
    setSelectedOpeningIds,
    selectedStairIds,
    setSelectedStairIds,
    selectedRoomIds,
    setSelectedRoomIds,
    selectedExtrudedSolidIds,
    setSelectedExtrudedSolidIds,
    selectedColumnIds,
    setSelectedColumnIds,
    selectedRoofIds,
    setSelectedRoofIds,
    selectedContextObjectIds,
    setSelectedContextObjectIds,
    selectedSectionLineIds,
    setSelectedSectionLineIds,
    setSelectedGroupIds,
    groupPath,
  } = selectionState;
  const { setMenu, setStampEditorRoomId, editTextId, setEditTextId, setEditTextMinHeightM } = contextMenuState;

  // ── Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D ─────────────────
  // Links-Klick im Grundriss: genau eine Wand wählen (Menge ersetzen) bzw.
  // Leerraum → Auswahl löschen.
  // Doppelklick auf einen Raum-Stempel: den Raum wählen + den Stempel-Editor
  // öffnen (Rich-Text-Popup).
  const onOpenStampEditor = (roomId: string) => {
    setSelectedRoomIds([roomId]);
    setSelectedWallIds([]);
    setSelectedDrawingId(null);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedContextObjectIds([]);
    setSelectedSectionLineIds([]);
    setStampEditorRoomId(roomId);
  };
  // Doppelklick auf ein Text-2D-Element: selektieren + Inhalts-Editor öffnen.
  const onEditDrawingText = (drawingId: string) => {
    const d = project.drawings2d.find((x) => x.id === drawingId);
    if (!d || d.geom.shape !== "text") return;
    setSelectedDrawingId(drawingId);
    setSelectedWallIds([]);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedContextObjectIds([]);
    setSelectedSectionLineIds([]);
    // Bestehendes Element per Doppelklick: keine Rahmen-Mindesthöhe (nur bei
    // frisch aufgezogener Textspalte relevant, s. textbox.ts focusMinHeightM)
    // — sonst könnte eine vorige Textspalten-Erstellung hier nachwirken.
    setEditTextMinHeightM(null);
    setEditTextId(drawingId);
  };

  // Bearbeitetes Rich-Text-Dokument übernehmen (immutabel; nur bei Text-Geometrie).
  // `text` bleibt als Reintext-Spiegel bestehen (DXF-Export, Suche, Alt-Konsumenten).
  // LIVE bei jedem Tastendruck (Inline-Editor auf der Zeichenfläche, kein Dialog
  // mehr) — schreibt AUCH einen leeren Zustand zurück (kein Guard mehr), damit
  // Löschen bis auf null Zeichen sich sofort im Modell spiegelt; das eigentliche
  // Aufräumen eines leer verlassenen NEUEN Elements übernimmt `closeTextEdit`.
  // `coalesceKey`: OHNE das würde JEDER Tastendruck einen eigenen Undo-Schritt
  // pushen (bei HISTORY_LIMIT=100 wäre nach 100 Zeichen der Stand VOR dem
  // Editieren aus dem Undo-Stack gefallen) — dasselbe Koaleszenz-Muster wie
  // beim Griff-Ziehen (`moveGripOf` & Co., s. `projectSlice.ts`).
  const commitTextEdit = (doc: RichTextDoc) => {
    const id = editTextId;
    if (!id) return;
    setProject(
      (p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) =>
          d.id === id && d.geom.shape === "text"
            ? { ...d, geom: { ...d.geom, doc, text: plainText(doc) } }
            : d,
        ),
      }),
      `commitTextEdit:${id}`,
    );
  };

  // Inline-Editor schliessen (Backdrop-Klick/Escape): bleibt das Element leer
  // (frisch über `text`/`textbox` erzeugt, nie befüllt, oder komplett wieder
  // geleert), wird es entfernt statt als leere Leiche im Modell zu bleiben.
  const closeTextEdit = () => {
    const id = editTextId;
    if (id) {
      setProject((p) => {
        const d = p.drawings2d.find((x) => x.id === id);
        // `text` ist immer der Reintext-Spiegel von `doc` (s. commitTextEdit) —
        // reicht daher allein als Leer-Test, egal ob `doc` je gesetzt wurde.
        if (d && d.geom.shape === "text" && d.geom.text.trim() === "") {
          return { ...p, drawings2d: p.drawings2d.filter((x) => x.id !== id) };
        }
        return p;
      });
    }
    setEditTextId(null);
    setEditTextMinHeightM(null);
  };
  // Kategorie-Code des getroffenen Elements (für die Sperr-Prüfung unten) —
  // nur die Kanäle, deren Modell-Typ eine categoryCode trägt (ExtrudedSolid/
  // Kontext-Objekte bewusst ohne, siehe deren Typdefinitionen).
  const categoryCodeOfSelection = (sel: PlanSelection): string | undefined => {
    if (sel.wallId) return project.walls.find((w) => w.id === sel.wallId)?.categoryCode;
    if (sel.ceilingId)
      return (project.ceilings ?? []).find((c) => c.id === sel.ceilingId)?.categoryCode;
    if (sel.openingId)
      return (project.openings ?? []).find((o) => o.id === sel.openingId)?.categoryCode;
    if (sel.stairId)
      return (project.stairs ?? []).find((s) => s.id === sel.stairId)?.categoryCode;
    if (sel.roomId) return (project.rooms ?? []).find((r) => r.id === sel.roomId)?.categoryCode;
    if (sel.columnId)
      return (project.columns ?? []).find((c) => c.id === sel.columnId)?.categoryCode;
    if (sel.roofId) return (project.roofs ?? []).find((r) => r.id === sel.roofId)?.categoryCode;
    if (sel.drawingId)
      return project.drawings2d.find((d) => d.id === sel.drawingId)?.categoryCode;
    return undefined;
  };

  // Zeichnungsebene (Geschoss/Zeichnung) des getroffenen Elements — für die
  // Sperr-Prüfung bei überlagerten (nicht-aktiven) Ebenen, s. `floorDisplay`
  // und `generateVisibleLevelsPlan`. Öffnungen gehören zur Wand (keine eigene
  // Ebenen-Referenz) — bewusst ausgelassen, wie schon bei categoryCodeOfSelection.
  const floorIdOfSelection = (sel: PlanSelection): string | undefined => {
    if (sel.wallId) return project.walls.find((w) => w.id === sel.wallId)?.floorId;
    if (sel.ceilingId) return (project.ceilings ?? []).find((c) => c.id === sel.ceilingId)?.floorId;
    if (sel.stairId) return (project.stairs ?? []).find((s) => s.id === sel.stairId)?.floorId;
    if (sel.roomId) return (project.rooms ?? []).find((r) => r.id === sel.roomId)?.floorId;
    if (sel.columnId) return (project.columns ?? []).find((c) => c.id === sel.columnId)?.floorId;
    if (sel.roofId) return (project.roofs ?? []).find((r) => r.id === sel.roofId)?.floorId;
    if (sel.drawingId) return project.drawings2d.find((d) => d.id === sel.drawingId)?.levelId;
    return undefined;
  };

  const onPlanSelect = (sel: PlanSelection) => {
    // Darstellungsmodus „Andere grau & gesperrt": ein gesperrtes Element lässt
    // sich nicht anwählen (und damit auch nicht verschieben/bearbeiten) — der
    // Klick wird ignoriert, als läge dort nichts.
    const hitCode = categoryCodeOfSelection(sel);
    if (hitCode !== undefined && categoryDisplay(hitCode).locked) return;
    // Dasselbe für eine überlagerte, nicht-aktive Zeichnungsebene (mehrere
    // Geschosse gleichzeitig sichtbar, Modus „Andere grau & gesperrt"/„Nur
    // aktive gesperrt"): das Element bleibt sichtbar, ist aber nicht anwählbar.
    const hitFloorId = floorIdOfSelection(sel);
    if (hitFloorId !== undefined && hitFloorId !== activeLevelId && floorDisplay(hitFloorId).locked)
      return;
    // Schnitt-/Ansichtslinie: dieselbe Sperr-Prüfung direkt über ihre eigene
    // Zeichnungsebene-ID (sie hat keinen Wirts-Floor wie eine Wand).
    if (sel.sectionLineId && floorDisplay(sel.sectionLineId).locked) return;
    // Gruppen-Isolation (Vectorworks „Gruppe betreten"): ausserhalb der
    // aktiven Gruppe ist alles gesperrt (gedimmt gerendert, s. PlanView) —
    // derselbe Ignorier-Kurzschluss wie beim normalen Sperren oben.
    const hit = selHit(sel);
    if (hit && !isInsideActiveGroup(project, hit.kind, hit.id, groupPath)) return;
    // Objekt-Sperre (`Wall.locked` & Co., s. `state/objectLock.ts`): bewusst
    // NICHT die Auswahl blockieren (sonst kein Weg mehr zurück zum
    // Kontextmenü-„Entsperren", sobald die Selektion einmal woanders hin
    // wechselt — Sackgasse). Ein gesperrtes Element bleibt anwähl-/
    // inspizierbar; blockiert wird die MODIFIKATION direkt an den
    // Mutations-Stellen (`moveGrip`/`moveElementBy` in projectSlice.ts,
    // `deleteSelection` in App.tsx) — dieselbe Semantik wie AutoCADs
    // Layer-„Lock" (weiterhin wählbar, nicht editierbar).
    // Shift+Klick: Mehrfach-Auswahl — getroffenes Element zu-/abschalten, den
    // Rest behalten (Wände und 2D-Zeichnungen unabhängig, gemischte Auswahl
    // erlaubt). Leerraum-Klick mit Shift lässt die Auswahl unverändert.
    if (sel.shift) {
      // Je Art: Auswahl-Liste + Setter. `replaces` (Shift-Durchschalten) entfernt
      // zuerst das vorige Zwischenergebnis, bevor das neue Objekt umgeschaltet wird.
      const channels = {
        section: [selectedSectionLineIds, setSelectedSectionLineIds],
        wall: [selectedWallIds, setSelectedWallIds],
        drawing: [selectedDrawingIds, setSelectedDrawingIds],
        ceiling: [selectedCeilingIds, setSelectedCeilingIds],
        opening: [selectedOpeningIds, setSelectedOpeningIds],
        stair: [selectedStairIds, setSelectedStairIds],
        room: [selectedRoomIds, setSelectedRoomIds],
        solid: [selectedExtrudedSolidIds, setSelectedExtrudedSolidIds],
        column: [selectedColumnIds, setSelectedColumnIds],
        roof: [selectedRoofIds, setSelectedRoofIds],
        context: [selectedContextObjectIds, setSelectedContextObjectIds],
      } as const;
      type Kind = keyof typeof channels;
      const target: { kind: Kind; id: string } | null = sel.sectionLineId
        ? { kind: "section", id: sel.sectionLineId }
        : sel.wallId
          ? { kind: "wall", id: sel.wallId }
          : sel.drawingId
            ? { kind: "drawing", id: sel.drawingId }
            : sel.ceilingId
              ? { kind: "ceiling", id: sel.ceilingId }
              : sel.openingId
                ? { kind: "opening", id: sel.openingId }
                : sel.stairId
                  ? { kind: "stair", id: sel.stairId }
                  : sel.roomId
                    ? { kind: "room", id: sel.roomId }
                    : sel.extrudedSolidId
                      ? { kind: "solid", id: sel.extrudedSolidId }
                      : sel.columnId
                        ? { kind: "column", id: sel.columnId }
                        : sel.roofId
                          ? { kind: "roof", id: sel.roofId }
                          : sel.contextObjectId
                            ? { kind: "context", id: sel.contextObjectId }
                            : null;
      const rep = sel.replaces;
      const base = (kind: Kind): string[] => {
        const list = channels[kind][0] as readonly string[];
        return rep && rep.kind === kind ? list.filter((x) => x !== rep.id) : [...list];
      };
      if (rep && (!target || rep.kind !== target.kind)) channels[rep.kind][1](base(rep.kind));
      if (target) {
        const list = base(target.kind);
        channels[target.kind][1](
          list.includes(target.id) ? list.filter((x) => x !== target.id) : [...list, target.id],
        );
      }
      return;
    }
    // Gruppen-Erweiterung: gehört das getroffene Element zu einer (im
    // aktuellen Isolations-Kontext sichtbaren) Gruppe, wird die GANZE Gruppe
    // gewählt statt nur dieses eine Element (Vectorworks: eine Gruppe
    // verhält sich wie ein einzelnes Objekt, bis man per Doppelklick
    // hineingeht — s. `onEnterGroup`/`groupPath`).
    if (hit) {
      const { expanded, groupIds } = expandToGroups(
        project,
        { ...EMPTY_MEMBERSHIP, [hit.kind]: [hit.id] },
        groupPath,
      );
      if (groupIds.length > 0) {
        setSelectedWallIds(expanded.wallIds);
        setSelectedDrawingIds(expanded.drawingIds);
        setSelectedCeilingIds(expanded.ceilingIds);
        setSelectedOpeningIds(expanded.openingIds);
        setSelectedStairIds(expanded.stairIds);
        setSelectedRoomIds(expanded.roomIds);
        setSelectedColumnIds(expanded.columnIds);
        setSelectedRoofIds(expanded.roofIds);
        setSelectedExtrudedSolidIds([]);
        setSelectedContextObjectIds([]);
        setSelectedSectionLineIds([]);
        setSelectedGroupIds(groupIds);
        return;
      }
    }
    setSelectedGroupIds([]);
    // Ohne Shift: ersetzen. Öffnung hat Vorrang (ihr Symbol liegt in der Lücke),
    // dann Wand, dann 2D-Element, dann Decke; sonst leeren. Die Kanäle schließen
    // sich gegenseitig aus.
    // Alle Kanäle ausser dem gewählten leeren — als Helfer, damit jeder Zweig
    // (inkl. des neuen Dach-Kanals) konsistent bleibt.
    const clearOthers = (keep: string) => {
      if (keep !== "wall") setSelectedWallIds([]);
      if (keep !== "drawing") setSelectedDrawingId(null);
      if (keep !== "ceiling") setSelectedCeilingIds([]);
      if (keep !== "opening") setSelectedOpeningIds([]);
      if (keep !== "stair") setSelectedStairIds([]);
      if (keep !== "room") setSelectedRoomIds([]);
      if (keep !== "extrudedSolid") setSelectedExtrudedSolidIds([]);
      if (keep !== "column") setSelectedColumnIds([]);
      if (keep !== "roof") setSelectedRoofIds([]);
      if (keep !== "contextObject") setSelectedContextObjectIds([]);
      if (keep !== "sectionLine") setSelectedSectionLineIds([]);
    };
    if (sel.sectionLineId) {
      setSelectedSectionLineIds([sel.sectionLineId]);
      clearOthers("sectionLine");
    } else if (sel.openingId) {
      setSelectedOpeningIds([sel.openingId]);
      clearOthers("opening");
    } else if (sel.wallId) {
      setSelectedWallIds([sel.wallId]);
      clearOthers("wall");
    } else if (sel.columnId) {
      setSelectedColumnIds([sel.columnId]);
      clearOthers("column");
    } else if (sel.drawingId) {
      setSelectedDrawingId(sel.drawingId);
      clearOthers("drawing");
    } else if (sel.extrudedSolidId) {
      setSelectedExtrudedSolidIds([sel.extrudedSolidId]);
      clearOthers("extrudedSolid");
    } else if (sel.ceilingId) {
      setSelectedCeilingIds([sel.ceilingId]);
      clearOthers("ceiling");
    } else if (sel.stairId) {
      setSelectedStairIds([sel.stairId]);
      clearOthers("stair");
    } else if (sel.roomId) {
      setSelectedRoomIds([sel.roomId]);
      clearOthers("room");
    } else if (sel.roofId) {
      setSelectedRoofIds([sel.roofId]);
      clearOthers("roof");
    } else if (sel.contextObjectId) {
      setSelectedContextObjectIds([sel.contextObjectId]);
      clearOthers("contextObject");
    } else {
      clearOthers("");
    }
  };
  // Links-Drag (Marquee) im Grundriss: die getroffene Wand-MENGE übernehmen
  // (nach CAD-Konvention von PlanView bestimmt). Ersetzt die bisherige Auswahl.
  const onPlanMarquee = (sel: MarqueeSelection) => {
    // Objekt-Sperre: NICHT hier filtern (s. Kommentar bei `onPlanSelect`) —
    // Auswahl bleibt für gesperrte Elemente uneingeschränkt möglich, die
    // Mutations-Stellen selbst prüfen `isLocked`.
    const raw: GroupMembership = {
      wallIds: sel.wallIds,
      drawingIds: sel.drawingIds ?? [],
      ceilingIds: sel.ceilingIds ?? [],
      roomIds: sel.roomIds ?? [],
      stairIds: sel.stairIds ?? [],
      columnIds: [],
      roofIds: [],
      openingIds: [],
    };
    // Gruppen-Isolation: ausserhalb der aktiven Gruppe getroffene Elemente
    // sind gesperrt (werden ignoriert), wie beim Einzelklick.
    const filtered: GroupMembership =
      groupPath.length === 0
        ? raw
        : {
            wallIds: raw.wallIds.filter((id) => isInsideActiveGroup(project, "wallIds", id, groupPath)),
            drawingIds: raw.drawingIds.filter((id) => isInsideActiveGroup(project, "drawingIds", id, groupPath)),
            ceilingIds: raw.ceilingIds.filter((id) => isInsideActiveGroup(project, "ceilingIds", id, groupPath)),
            roomIds: raw.roomIds.filter((id) => isInsideActiveGroup(project, "roomIds", id, groupPath)),
            stairIds: raw.stairIds.filter((id) => isInsideActiveGroup(project, "stairIds", id, groupPath)),
            columnIds: [],
            roofIds: [],
            openingIds: [],
          };
    // Gruppen-Erweiterung: jedes getroffene Element, das zu einer sichtbaren
    // Gruppe gehört, zieht deren ganze (transitive) Mitgliedschaft nach.
    const { expanded, groupIds } = expandToGroups(project, filtered, groupPath);
    setSelectedWallIds(expanded.wallIds);
    setSelectedDrawingIds(expanded.drawingIds);
    setSelectedCeilingIds(expanded.ceilingIds);
    setSelectedStairIds(expanded.stairIds);
    setSelectedRoomIds(expanded.roomIds);
    setSelectedGroupIds(groupIds);
    // Öffnungen/Extrusionen/Stützen/Dächer/Kontext-Objekte sind (noch) nicht
    // Teil des Marquee (Nutzer-Report betraf nur Decken/Räume/Treppen; Stütze/
    // Dach liessen sich mit derselben `marqueeHitByField`-Mechanik ergänzen,
    // falls gewünscht) → beim Aufziehen abwählen.
    setSelectedOpeningIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedContextObjectIds([]);
    setSelectedSectionLineIds([]);
  };
  // Rechts-Klick im Grundriss: Wand-Kontextmenü. Trifft der Klick eine Wand, die
  // NICHT bereits in der Auswahl ist, wird die Auswahl auf sie gesetzt (damit die
  // Aktionen einen Bezug haben); innerhalb einer bestehenden Mehrfachauswahl
  // bleibt die Menge erhalten.
  const onPlanContextMenu = (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => {
    const wallId = hitTestWall(project, activeLevelId, visibleCodes, info.model);
    if (wallId && !selectedWallIds.includes(wallId)) setSelectedWallIds([wallId]);
    setMenu({ kind: "plan", x: info.clientX, y: info.clientY, wallId, model: info.model });
  };
  // Links-KLICK im Nordstern-3D-Viewport (WASM, TS-Raycast): getroffenes Bauteil
  // wählen, sodass das Attribute-/Objekt-Info-Panel es zeigt (erster Schritt zur
  // 3D-Editierbarkeit). `additive` (Shift/Ctrl) = zur Auswahl DERSELBEN Art
  // hinzufügen, sonst ersetzen; beim Setzen die ANDEREN Arten-Arrays leeren
  // (Einzel-Selektion über Arten hinweg, konsistent mit dem 2D-Verhalten).
  // Leertreffer (kein Bauteil) → alle Selektionen leeren.
  const onViewport3dPick = (hit: Pick3dHit, additive: boolean) => {
    if (!hit) {
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedContextObjectIds([]);
      setSelectedSectionLineIds([]);
      return;
    }
    if (hit.kind === "contextObject") {
      setSelectedContextObjectIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedSectionLineIds([]);
      return;
    }
    // Öffnung (Fenster/Tür) und Treppe sind jetzt auch im WASM-Viewport pickbar
    // (raycast3d/pickGeometry). Jede Art ersetzt die Auswahl exklusiv; nur Wände
    // unterstützen additive Mehrfachauswahl (wie bisher).
    if (hit.kind === "opening") {
      setSelectedOpeningIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedContextObjectIds([]);
      setSelectedSectionLineIds([]);
      return;
    }
    if (hit.kind === "drawing") {
      setSelectedDrawingIds(
        additive ? Array.from(new Set([...selectedDrawingIds, hit.id])) : [hit.id],
      );
      setSelectedDrawingId(hit.id);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedContextObjectIds([]);
      setSelectedSectionLineIds([]);
      return;
    }
    if (hit.kind === "stair") {
      setSelectedStairIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedContextObjectIds([]);
      setSelectedSectionLineIds([]);
      return;
    }
    if (hit.kind === "roof") {
      setSelectedRoofIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedContextObjectIds([]);
      return;
    }
    if (hit.kind === "wall") {
      setSelectedWallIds(
        additive ? Array.from(new Set([...selectedWallIds, hit.id])) : [hit.id],
      );
      setSelectedCeilingIds([]);
    } else {
      setSelectedCeilingIds(
        additive ? Array.from(new Set([...selectedCeilingIds, hit.id])) : [hit.id],
      );
      setSelectedWallIds([]);
    }
    setSelectedDrawingId(null);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedContextObjectIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedSectionLineIds([]);
  };
  return {
    onOpenStampEditor,
    onEditDrawingText,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onPlanContextMenu,
    onViewport3dPick,
  };
}
