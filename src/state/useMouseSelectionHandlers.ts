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
import type { ViewportContextInfo } from "../viewport/Viewport3D";
import type { RichTextDoc } from "../text/richText";
import { plainText } from "../text/richText";
import { hitTestWall } from "../viewport/planHitTest";
import type { useSelectionState } from "./useSelectionState";
import type { useContextMenuState } from "../menus/useContextMenuState";

export function useMouseSelectionHandlers(opts: {
  project: Project;
  setProject: (updater: (p: Project) => Project) => void;
  activeLevelId: string;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
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
    | "selectedSectionLineId"
    | "setSelectedSectionLineId"
  >;
  contextMenuState: Pick<
    ReturnType<typeof useContextMenuState>,
    "setMenu" | "setStampEditorRoomId" | "editTextId" | "setEditTextId" | "setEditTextMinHeightM"
  >;
}) {
  const { project, setProject, activeLevelId, visibleCodes, categoryDisplay, selectionState, contextMenuState } = opts;
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
    selectedSectionLineId,
    setSelectedSectionLineId,
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
    setSelectedSectionLineId(null);
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
    setSelectedSectionLineId(null);
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
  const commitTextEdit = (doc: RichTextDoc) => {
    const id = editTextId;
    if (!id) return;
    setProject((p) => ({
      ...p,
      drawings2d: p.drawings2d.map((d) =>
        d.id === id && d.geom.shape === "text"
          ? { ...d, geom: { ...d.geom, doc, text: plainText(doc) } }
          : d,
      ),
    }));
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

  const onPlanSelect = (sel: PlanSelection) => {
    // Darstellungsmodus „Andere grau & gesperrt": ein gesperrtes Element lässt
    // sich nicht anwählen (und damit auch nicht verschieben/bearbeiten) — der
    // Klick wird ignoriert, als läge dort nichts.
    const hitCode = categoryCodeOfSelection(sel);
    if (hitCode !== undefined && categoryDisplay(hitCode).locked) return;
    // Shift+Klick: Mehrfach-Auswahl — getroffenes Element zu-/abschalten, den
    // Rest behalten (Wände und 2D-Zeichnungen unabhängig, gemischte Auswahl
    // erlaubt). Leerraum-Klick mit Shift lässt die Auswahl unverändert.
    if (sel.shift) {
      // Schnittlinie ist Einzelauswahl — Shift+Klick togglet sie an/aus.
      if (sel.sectionLineId) {
        setSelectedSectionLineId(
          selectedSectionLineId === sel.sectionLineId ? null : sel.sectionLineId,
        );
        return;
      }
      if (sel.wallId) {
        const id = sel.wallId;
        setSelectedWallIds(
          selectedWallIds.includes(id)
            ? selectedWallIds.filter((w) => w !== id)
            : [...selectedWallIds, id],
        );
      } else if (sel.drawingId) {
        const id = sel.drawingId;
        setSelectedDrawingIds(
          selectedDrawingIds.includes(id)
            ? selectedDrawingIds.filter((d) => d !== id)
            : [...selectedDrawingIds, id],
        );
      } else if (sel.ceilingId) {
        const id = sel.ceilingId;
        setSelectedCeilingIds(
          selectedCeilingIds.includes(id)
            ? selectedCeilingIds.filter((c) => c !== id)
            : [...selectedCeilingIds, id],
        );
      } else if (sel.openingId) {
        const id = sel.openingId;
        setSelectedOpeningIds(
          selectedOpeningIds.includes(id)
            ? selectedOpeningIds.filter((o) => o !== id)
            : [...selectedOpeningIds, id],
        );
      } else if (sel.stairId) {
        const id = sel.stairId;
        setSelectedStairIds(
          selectedStairIds.includes(id)
            ? selectedStairIds.filter((s) => s !== id)
            : [...selectedStairIds, id],
        );
      } else if (sel.roomId) {
        const id = sel.roomId;
        setSelectedRoomIds(
          selectedRoomIds.includes(id)
            ? selectedRoomIds.filter((r) => r !== id)
            : [...selectedRoomIds, id],
        );
      } else if (sel.extrudedSolidId) {
        const id = sel.extrudedSolidId;
        setSelectedExtrudedSolidIds(
          selectedExtrudedSolidIds.includes(id)
            ? selectedExtrudedSolidIds.filter((x) => x !== id)
            : [...selectedExtrudedSolidIds, id],
        );
      } else if (sel.columnId) {
        const id = sel.columnId;
        setSelectedColumnIds(
          selectedColumnIds.includes(id)
            ? selectedColumnIds.filter((x) => x !== id)
            : [...selectedColumnIds, id],
        );
      } else if (sel.roofId) {
        const id = sel.roofId;
        setSelectedRoofIds(
          selectedRoofIds.includes(id)
            ? selectedRoofIds.filter((x) => x !== id)
            : [...selectedRoofIds, id],
        );
      } else if (sel.contextObjectId) {
        const id = sel.contextObjectId;
        setSelectedContextObjectIds(
          selectedContextObjectIds.includes(id)
            ? selectedContextObjectIds.filter((x) => x !== id)
            : [...selectedContextObjectIds, id],
        );
      }
      return;
    }
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
      if (keep !== "sectionLine") setSelectedSectionLineId(null);
    };
    if (sel.sectionLineId) {
      setSelectedSectionLineId(sel.sectionLineId);
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
    setSelectedWallIds(sel.wallIds);
    setSelectedDrawingIds(sel.drawingIds ?? []);
    setSelectedCeilingIds(sel.ceilingIds ?? []);
    setSelectedStairIds(sel.stairIds ?? []);
    setSelectedRoomIds(sel.roomIds ?? []);
    // Öffnungen/Extrusionen/Stützen/Dächer/Kontext-Objekte sind (noch) nicht
    // Teil des Marquee (Nutzer-Report betraf nur Decken/Räume/Treppen; Stütze/
    // Dach liessen sich mit derselben `marqueeHitByField`-Mechanik ergänzen,
    // falls gewünscht) → beim Aufziehen abwählen.
    setSelectedOpeningIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedContextObjectIds([]);
    setSelectedSectionLineId(null);
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
    setMenu({ kind: "plan", x: info.clientX, y: info.clientY, wallId });
  };
  // Links-Klick im 3D: per Raycast getroffene Wand wählen (Einzelauswahl).
  const onViewportSelectWall = (wallId: string | null) => {
    setSelectedWallIds(wallId ? [wallId] : []);
    if (wallId) {
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedSectionLineId(null);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Treppe wählen (Einzelauswahl).
  const onViewportSelectStair = (stairId: string | null) => {
    setSelectedStairIds(stairId ? [stairId] : []);
    if (stairId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedSectionLineId(null);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Decke wählen (Einzelauswahl).
  const onViewportSelectCeiling = (ceilingId: string | null) => {
    setSelectedCeilingIds(ceilingId ? [ceilingId] : []);
    if (ceilingId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedStairIds([]);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedSectionLineId(null);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Öffnung wählen (Einzelauswahl).
  const onViewportSelectOpening = (openingId: string | null) => {
    setSelectedOpeningIds(openingId ? [openingId] : []);
    if (openingId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedSectionLineId(null);
    }
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
      setSelectedSectionLineId(null);
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
      setSelectedSectionLineId(null);
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
      setSelectedSectionLineId(null);
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
      setSelectedSectionLineId(null);
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
    setSelectedSectionLineId(null);
  };
  // Rechts-Klick im 3D: Wand-Kontextmenü an der Cursorposition.
  const onViewportContextMenu = (info: ViewportContextInfo) => {
    if (info.wallId && !selectedWallIds.includes(info.wallId)) {
      setSelectedWallIds([info.wallId]);
    }
    setMenu({
      kind: "viewport",
      x: info.clientX,
      y: info.clientY,
      wallId: info.wallId,
    });
  };

  return {
    onOpenStampEditor,
    onEditDrawingText,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onPlanContextMenu,
    onViewportSelectWall,
    onViewportSelectStair,
    onViewportSelectCeiling,
    onViewportSelectOpening,
    onViewport3dPick,
    onViewportContextMenu,
  };
}
