// Bündelt Projekt-Mutationen als (referenzstabile) Store-Actions plus die
// Ressourcen-Typ-CRUD (Wand-/Decken-/Dach-/Tür-/Fenster-/Treppentyp), die
// direkt über `setProject` laufen (kein eigener Slice). Löschen ist je Typ
// geschützt, solange ein Element ihn per `typeId`/`wallTypeId`/… referenziert.
// Nur aus App() herausgezogen, um die Funktion zu entlasten — reine
// Zustands-/Aktions-Bündelung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { RefObject } from "react";
import { useStore } from "./appStore";
import { t } from "../i18n";
import type {
  CeilingType,
  ContextObject,
  DoorType,
  OverrideRule,
  Project,
  RoofType,
  StairType,
  Vec2,
  WallType,
  WindowType,
} from "../model/types";
import type { PlanViewHandle } from "../views/plan/PlanView";
import type { NotifyKind } from "./notifySlice";

/**
 * Bounding-Box (Modell-Meter) neu importierter Kontext-Objekte (Konturen/
 * Meshes/Terrain, z. B. aus dem Standort-Import-Dialog), als zwei Eckpunkte
 * für `PlanViewHandle.fitBounds` (Auto-Zoom auf Import). Ignoriert die
 * Z-Achse (reine 2D-Projektion, wie die Plan-Darstellung der Kontext-
 * Konturen in generatePlan.ts). Leere/degenerierte Eingabe → null.
 */
function contextObjectsBounds(objs: ContextObject[]): Vec2[] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const obj of objs) {
    if (obj.type === "contourSet") {
      for (const c of obj.contours) for (const p of c.pts) acc(p.x, p.y);
    } else if (obj.type === "image") {
      acc(obj.min.x, obj.min.y);
      acc(obj.max.x, obj.max.y);
    } else {
      // importedMesh / terrainMesh: flaches (x,y,z…)-Array, Stride 3.
      const pos = obj.positions;
      for (let i = 0; i + 1 < pos.length; i += 3) acc(pos[i], pos[i + 1]);
    }
  }
  return Number.isFinite(minX)
    ? [{ x: minX, y: minY }, { x: maxX, y: maxY }]
    : null;
}

export function useProjectActions(
  // `setProject`/`notify` kommen als Parameter herein statt erneut via
  // useStore geholt zu werden: beide werden schon früher in App() gebraucht
  // (Command-Engine/Grips, vor dieser Sektion) und bleiben dort deklariert —
  // sonst gäbe es die Store-Action zweimal (Duplikat-Deklaration in App()).
  setProject: (next: Project | ((p: Project) => Project)) => void,
  notify: (message: string, kind?: NotifyKind) => void,
  planViewRef: RefObject<PlanViewHandle | null>,
) {
  // ── Projekt-Mutationen (aus dem Store-Slice) ─────────────────────────────
  // Sämtliche immutablen Projekt-Mutationen liegen jetzt in projectSlice. App
  // liest sie als (referenzstabile) Store-Actions und reicht sie unverändert an
  // Panels/Menüs/Editoren weiter.
  const toggleLevelVisible = useStore((s) => s.toggleLevelVisible);
  const toggleCategoryVisible = useStore((s) => s.toggleCategoryVisible);
  const addFloor = useStore((s) => s.addFloor);
  const addDrawing = useStore((s) => s.addDrawing);
  const addSection = useStore((s) => s.addSection);
  const addElevation = useStore((s) => s.addElevation);
  const addDrawingLevel = useStore((s) => s.addDrawingLevel);
  const importDrawings = useStore((s) => s.importDrawings);
  const addCategory = useStore((s) => s.addCategory);
  const patchCategory = useStore((s) => s.patchCategory);
  const addSubCategory = useStore((s) => s.addSubCategory);
  const duplicateCategory = useStore((s) => s.duplicateCategory);
  const deleteCategory = useStore((s) => s.deleteCategory);
  const assignWallCategory = useStore((s) => s.assignWallCategory);
  const snapshotLayerVisibility = useStore((s) => s.snapshotLayerVisibility);
  const applyLayerVisibility = useStore((s) => s.applyLayerVisibility);
  const snapshotDrawingVisibility = useStore((s) => s.snapshotDrawingVisibility);
  const applyDrawingVisibility = useStore((s) => s.applyDrawingVisibility);
  const patchLevel = useStore((s) => s.patchLevel);
  const duplicateLevel = useStore((s) => s.duplicateLevel);
  const deleteLevel = useStore((s) => s.deleteLevel);
  const patchComponent = useStore((s) => s.patchComponent);
  const addComponent = useStore((s) => s.addComponent);
  const deleteComponent = useStore((s) => s.deleteComponent);
  const patchHatch = useStore((s) => s.patchHatch);
  const addHatch = useStore((s) => s.addHatch);
  const deleteHatch = useStore((s) => s.deleteHatch);
  const patchLineStyle = useStore((s) => s.patchLineStyle);
  const addLineStyle = useStore((s) => s.addLineStyle);
  const deleteLineStyle = useStore((s) => s.deleteLineStyle);
  const patchTextStyle = useStore((s) => s.patchTextStyle);
  const addTextStyle = useStore((s) => s.addTextStyle);
  const deleteTextStyle = useStore((s) => s.deleteTextStyle);
  const addPen = useStore((s) => s.addPen);
  const renamePen = useStore((s) => s.renamePen);
  const deletePen = useStore((s) => s.deletePen);
  const addPenSet = useStore((s) => s.addPenSet);
  const renamePenSet = useStore((s) => s.renamePenSet);
  const deletePenSet = useStore((s) => s.deletePenSet);
  const setActivePenSet = useStore((s) => s.setActivePenSet);
  const patchPenSetColor = useStore((s) => s.patchPenSetColor);
  const patchPenSetWeight = useStore((s) => s.patchPenSetWeight);
  const seedStandardPenSet = useStore((s) => s.seedStandardPenSet);
  const addCustomPalette = useStore((s) => s.addCustomPalette);
  const renameCustomPalette = useStore((s) => s.renameCustomPalette);
  const deleteCustomPalette = useStore((s) => s.deleteCustomPalette);
  const addColorToCustomPalette = useStore((s) => s.addColorToCustomPalette);
  const removeColorFromCustomPalette = useStore((s) => s.removeColorFromCustomPalette);
  const setCustomPaletteVisible = useStore((s) => s.setCustomPaletteVisible);
  const setBuiltinPaletteVisible = useStore((s) => s.setBuiltinPaletteVisible);
  const insertDrawingPoint = useStore((s) => s.insertDrawingPoint);
  const deleteDrawingPoint = useStore((s) => s.deleteDrawingPoint);
  const setPolylineVertexType = useStore((s) => s.setPolylineVertexType);
  // Wandstile: immutable Patch eines Wandtyps (z. B. Schichtfugen-Stile). Kein
  // eigener Store-Slice nötig — läuft direkt über setProject wie die übrigen
  // Ressourcen-Mutationen.
  const patchWallType = (id: string, patch: Partial<WallType>) =>
    setProject((p) => ({
      ...p,
      wallTypes: p.wallTypes.map((wt) => (wt.id === id ? { ...wt, ...patch } : wt)),
    }));
  // Grafische Override-Regeln: ersetzt die ganze Regelliste (Reihenfolge =
  // Priorität, oben gewinnt). Läuft wie die übrigen Ressourcen-Mutationen
  // direkt über setProject — persistiert damit automatisch im Projekt-JSON.
  const setOverrideRules = (rules: OverrideRule[]) =>
    setProject((p) => ({ ...p, overrideRules: rules }));
  // Deckenstile: immutable Patch eines Deckentyps — analog `patchWallType`.
  const patchCeilingType = (id: string, patch: Partial<CeilingType>) =>
    setProject((p) => ({
      ...p,
      ceilingTypes: (p.ceilingTypes ?? []).map((ct) =>
        ct.id === id ? { ...ct, ...patch } : ct,
      ),
    }));
  // Neuen Wandtyp anlegen: eine Default-Schicht (erstes Bauteil, 200 mm).
  const addWallType = () =>
    setProject((p) => {
      const componentId = p.components[0]?.id ?? "";
      const wallType: WallType = {
        id: `wt-${Date.now()}`,
        name: t("default.wallTypeName"),
        layers: [{ componentId, thickness: 0.2 }],
      };
      return { ...p, wallTypes: [...p.wallTypes, wallType] };
    });
  // Wandtyp löschen — geschützt, solange ihn eine Wand verwendet.
  const deleteWallType = (id: string) =>
    setProject((p) => {
      const used = p.walls.some((w) => w.wallTypeId === id);
      if (used) {
        const name = p.wallTypes.find((wt) => wt.id === id)?.name ?? id;
        notify(t("alert.wallTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, wallTypes: p.wallTypes.filter((wt) => wt.id !== id) };
    });
  // Neuen Deckentyp anlegen — analog `addWallType` (150 mm Default).
  const addCeilingType = () =>
    setProject((p) => {
      const componentId = p.components[0]?.id ?? "";
      const ceilingType: CeilingType = {
        id: `ct-${Date.now()}`,
        name: t("default.ceilingTypeName"),
        layers: [{ componentId, thickness: 0.15 }],
      };
      return { ...p, ceilingTypes: [...(p.ceilingTypes ?? []), ceilingType] };
    });
  // Deckentyp löschen — geschützt, solange ihn eine Decke verwendet.
  const deleteCeilingType = (id: string) =>
    setProject((p) => {
      const used = (p.ceilings ?? []).some((c) => c.ceilingTypeId === id);
      if (used) {
        const name = (p.ceilingTypes ?? []).find((ct) => ct.id === id)?.name ?? id;
        notify(t("alert.ceilingTypeInUse", { name }), "warning");
        return p;
      }
      return {
        ...p,
        ceilingTypes: (p.ceilingTypes ?? []).filter((ct) => ct.id !== id),
      };
    });
  // ── Dachtypen (Dachaufbauten) — analog Deckentyp ──────────────────────────
  const patchRoofType = (id: string, patch: Partial<RoofType>) =>
    setProject((p) => ({
      ...p,
      roofTypes: (p.roofTypes ?? []).map((rt) => (rt.id === id ? { ...rt, ...patch } : rt)),
    }));
  const addRoofType = () =>
    setProject((p) => {
      const componentId = p.components[0]?.id ?? "";
      const roofType: RoofType = {
        id: `rt-${Date.now()}`,
        name: t("default.roofTypeName"),
        layers: [{ componentId, thickness: 0.2 }],
      };
      return { ...p, roofTypes: [...(p.roofTypes ?? []), roofType] };
    });
  // Dachtyp löschen — geschützt, solange ihn ein Dach verwendet.
  const deleteRoofType = (id: string) =>
    setProject((p) => {
      const used = (p.roofs ?? []).some((r) => r.roofTypeId === id);
      if (used) {
        const name = (p.roofTypes ?? []).find((rt) => rt.id === id)?.name ?? id;
        notify(t("alert.roofTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, roofTypes: (p.roofTypes ?? []).filter((rt) => rt.id !== id) };
    });
  // ── Bauteil-Typen: Tür / Fenster / Treppe (Bibliothek) ────────────────────
  // Anlegen/Patchen/Löschen analog Wand-/Deckentyp — direkt über setProject
  // (kein eigener Slice). Löschen ist geschützt, solange ein Element den Typ
  // per `typeId` referenziert. Defaults orientieren sich an den Element-Inline-
  // Werten (Tür 0.9×2.0, Fenster 1.2×1.4 Brüstung 0.9).
  const addDoorType = () =>
    setProject((p) => {
      const dt: DoorType = {
        id: `dt-${Date.now()}`,
        name: t("default.doorTypeName"),
        kind: "dreh",
        leafCount: 1,
        leafStyle: "glatt",
        frameThickness: 0.05,
        defaultWidth: 0.9,
        defaultHeight: 2.0,
      };
      return { ...p, doorTypes: [...(p.doorTypes ?? []), dt] };
    });
  const patchDoorType = (id: string, patch: Partial<DoorType>) =>
    setProject((p) => ({
      ...p,
      doorTypes: (p.doorTypes ?? []).map((dt) =>
        dt.id === id ? { ...dt, ...patch } : dt,
      ),
    }));
  const deleteDoorType = (id: string) =>
    setProject((p) => {
      const used = (p.openings ?? []).some((o) => o.typeId === id);
      if (used) {
        const name = (p.doorTypes ?? []).find((dt) => dt.id === id)?.name ?? id;
        notify(t("alert.doorTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, doorTypes: (p.doorTypes ?? []).filter((dt) => dt.id !== id) };
    });
  const addWindowType = () =>
    setProject((p) => {
      const wt: WindowType = {
        id: `ft-${Date.now()}`,
        name: t("default.windowTypeName"),
        kind: "drehkipp",
        wingCount: 1,
        glazing: "zweifach",
        frameThickness: 0.06,
        defaultSillHeight: 0.9,
        defaultWidth: 1.2,
        defaultHeight: 1.4,
      };
      return { ...p, windowTypes: [...(p.windowTypes ?? []), wt] };
    });
  const patchWindowType = (id: string, patch: Partial<WindowType>) =>
    setProject((p) => ({
      ...p,
      windowTypes: (p.windowTypes ?? []).map((wt) =>
        wt.id === id ? { ...wt, ...patch } : wt,
      ),
    }));
  const deleteWindowType = (id: string) =>
    setProject((p) => {
      const used = (p.openings ?? []).some((o) => o.typeId === id);
      if (used) {
        const name = (p.windowTypes ?? []).find((wt) => wt.id === id)?.name ?? id;
        notify(t("alert.windowTypeInUse", { name }), "warning");
        return p;
      }
      return {
        ...p,
        windowTypes: (p.windowTypes ?? []).filter((wt) => wt.id !== id),
      };
    });
  // „Als Stil speichern": aktuellen Fenster-/Tür-Typ der Öffnung als NEUEN
  // benannten Stil ablegen und der Öffnung zuweisen (VW „Fenster speichern…").
  // Ohne Bezugstyp wird aus den Default-Feldern ein frischer Stil erzeugt.
  const saveOpeningStyle = (openingId: string, name: string) =>
    setProject((p) => {
      const o = (p.openings ?? []).find((x) => x.id === openingId);
      if (!o) return p;
      if (o.kind === "door") {
        const base = (p.doorTypes ?? []).find((d) => d.id === o.typeId);
        const nt: DoorType = base
          ? { ...base, id: `dt-${Date.now()}`, name }
          : {
              id: `dt-${Date.now()}`,
              name,
              kind: "dreh",
              leafCount: 1,
              leafStyle: "glatt",
              frameThickness: 0.05,
              defaultWidth: 0.9,
              defaultHeight: 2.0,
            };
        return {
          ...p,
          doorTypes: [...(p.doorTypes ?? []), nt],
          openings: (p.openings ?? []).map((x) =>
            x.id === openingId ? { ...x, typeId: nt.id } : x,
          ),
        };
      }
      const base = (p.windowTypes ?? []).find((w) => w.id === o.typeId);
      const nt: WindowType = base
        ? { ...base, id: `ft-${Date.now()}`, name }
        : {
            id: `ft-${Date.now()}`,
            name,
            kind: "drehkipp",
            wingCount: 1,
            glazing: "zweifach",
            frameThickness: 0.06,
            defaultSillHeight: 0.9,
            defaultWidth: 1.2,
            defaultHeight: 1.4,
          };
      return {
        ...p,
        windowTypes: [...(p.windowTypes ?? []), nt],
        openings: (p.openings ?? []).map((x) =>
          x.id === openingId ? { ...x, typeId: nt.id } : x,
        ),
      };
    });
  const addStairType = () =>
    setProject((p) => {
      const st: StairType = {
        id: `st-${Date.now()}`,
        name: t("default.stairTypeName"),
        structure: "massiv",
        closedRisers: true,
        treadThickness: 0.04,
        nosing: 0.03,
        railing: "keine",
        defaultWidth: 1.0,
      };
      return { ...p, stairTypes: [...(p.stairTypes ?? []), st] };
    });
  const patchStairType = (id: string, patch: Partial<StairType>) =>
    setProject((p) => ({
      ...p,
      stairTypes: (p.stairTypes ?? []).map((st) =>
        st.id === id ? { ...st, ...patch } : st,
      ),
    }));
  const deleteStairType = (id: string) =>
    setProject((p) => {
      const used = (p.stairs ?? []).some((s) => s.typeId === id);
      if (used) {
        const name = (p.stairTypes ?? []).find((st) => st.id === id)?.name ?? id;
        notify(t("alert.stairTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, stairTypes: (p.stairTypes ?? []).filter((st) => st.id !== id) };
    });
  const importLineStyles = useStore((s) => s.importLineStyles);
  const importHatches = useStore((s) => s.importHatches);
  // Site-/Kontext-Schicht (siteSlice): Import/Entfernen/Gelände.
  const addContextObjects = useStore((s) => s.addContextObjects);
  // Wie addContextObjects, aber passt die Plan-Ansicht danach auf die Bounding-
  // Box der NEU importierten Objekte ein (Auto-Zoom auf Import, ROADMAP §11) —
  // sonst muss man nach Standort-/Geo-Import manuell zur Geometrie suchen.
  const addContextObjectsAndFit = (objs: ContextObject[]) => {
    addContextObjects(objs);
    const pts = contextObjectsBounds(objs);
    if (pts) planViewRef.current?.fitBounds(pts);
  };
  const removeContextObject = useStore((s) => s.removeContextObject);
  const removeContextObjects = useStore((s) => s.removeContextObjects);
  const generateTerrain = useStore((s) => s.generateTerrain);
  const moveGripOf = useStore((s) => s.moveGripOf);
  const moveElementByOf = useStore((s) => s.moveElementByOf);
  const moveEdgeOf = useStore((s) => s.moveEdgeOf);
  const commitTransformOn = useStore((s) => s.commitTransformOn);
  const setElementColor = useStore((s) => s.setElementColor);
  const setElementWeight = useStore((s) => s.setElementWeight);
  const setElementFill = useStore((s) => s.setElementFill);
  const setElementFillColor = useStore((s) => s.setElementFillColor);
  const setElementForeground = useStore((s) => s.setElementForeground);
  const setElementBackground = useStore((s) => s.setElementBackground);
  const updateDrawing2D = useStore((s) => s.updateDrawing2D);
  const reorderDrawings = useStore((s) => s.reorderDrawings);
  const reorderDrawingLevels = useStore((s) => s.reorderDrawingLevels);
  const resizeElement = useStore((s) => s.resizeElement);
  const updateWall = useStore((s) => s.updateWall);
  const setWallThickness = useStore((s) => s.setWallThickness);
  const updateOpening = useStore((s) => s.updateOpening);
  const moveCeilingGrip = useStore((s) => s.moveCeilingGrip);
  const moveCeilingBy = useStore((s) => s.moveCeilingBy);
  const moveCeilingEdge = useStore((s) => s.moveCeilingEdge);
  const updateCeiling = useStore((s) => s.updateCeiling);
  const setCeilingThickness = useStore((s) => s.setCeilingThickness);
  const updateStair = useStore((s) => s.updateStair);
  const moveStairBy = useStore((s) => s.moveStairBy);
  const updateRoom = useStore((s) => s.updateRoom);
  const moveRoomBy = useStore((s) => s.moveRoomBy);
  const moveRoomGrip = useStore((s) => s.moveRoomGrip);
  const moveRoomEdge = useStore((s) => s.moveRoomEdge);
  const moveRoomStamp = useStore((s) => s.moveRoomStamp);
  const setRoomStampDoc = useStore((s) => s.setRoomStampDoc);
  const setRoomStamp = useStore((s) => s.setRoomStamp);

  return {
    toggleLevelVisible,
    toggleCategoryVisible,
    addFloor,
    addDrawing,
    addSection,
    addElevation,
    addDrawingLevel,
    importDrawings,
    addCategory,
    patchCategory,
    addSubCategory,
    duplicateCategory,
    deleteCategory,
    assignWallCategory,
    snapshotLayerVisibility,
    applyLayerVisibility,
    snapshotDrawingVisibility,
    applyDrawingVisibility,
    patchLevel,
    duplicateLevel,
    deleteLevel,
    patchComponent,
    addComponent,
    deleteComponent,
    patchHatch,
    addHatch,
    deleteHatch,
    patchLineStyle,
    addLineStyle,
    deleteLineStyle,
    patchTextStyle,
    addTextStyle,
    deleteTextStyle,
    addPen,
    renamePen,
    deletePen,
    addPenSet,
    renamePenSet,
    deletePenSet,
    setActivePenSet,
    patchPenSetColor,
    patchPenSetWeight,
    seedStandardPenSet,
    addCustomPalette,
    renameCustomPalette,
    deleteCustomPalette,
    addColorToCustomPalette,
    removeColorFromCustomPalette,
    setCustomPaletteVisible,
    setBuiltinPaletteVisible,
    insertDrawingPoint,
    deleteDrawingPoint,
    setPolylineVertexType,
    patchWallType,
    setOverrideRules,
    patchCeilingType,
    addWallType,
    deleteWallType,
    addCeilingType,
    deleteCeilingType,
    patchRoofType,
    addRoofType,
    deleteRoofType,
    addDoorType,
    patchDoorType,
    deleteDoorType,
    addWindowType,
    patchWindowType,
    deleteWindowType,
    saveOpeningStyle,
    addStairType,
    patchStairType,
    deleteStairType,
    importLineStyles,
    importHatches,
    addContextObjects,
    addContextObjectsAndFit,
    removeContextObject,
    removeContextObjects,
    generateTerrain,
    moveGripOf,
    moveElementByOf,
    moveEdgeOf,
    commitTransformOn,
    setElementColor,
    setElementWeight,
    setElementFill,
    setElementFillColor,
    setElementForeground,
    setElementBackground,
    updateDrawing2D,
    reorderDrawings,
    reorderDrawingLevels,
    resizeElement,
    updateWall,
    setWallThickness,
    updateOpening,
    moveCeilingGrip,
    moveCeilingBy,
    moveCeilingEdge,
    updateCeiling,
    setCeilingThickness,
    updateStair,
    moveStairBy,
    updateRoom,
    moveRoomBy,
    moveRoomGrip,
    moveRoomEdge,
    moveRoomStamp,
    setRoomStampDoc,
    setRoomStamp,
  };
}
