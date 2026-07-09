// Projekt-Slice: das semantische Modell (`project`) plus ALLE Mutationen, die
// heute in App.tsx als Closures über setProject existieren. Reiner Umzug — die
// Logik ist 1:1 übernommen (inkl. recomputeFloorElevations, refs-aware delete,
// Tree-Helfern). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).
//
// Cross-Slice-Zugriffe: einige Aktionen lesen/schreiben View-Felder
// (activeLevelId) — das geht, weil `get()`/`set` über den Gesamt-RootState
// laufen. Die Slice tippt daher nur ihre eigenen Felder; `get()` liefert
// RootState (siehe appStore.ts), wir greifen punktuell auf View-Felder zu.

import { sampleProject } from "../model/sampleProject";
import {
  flattenCategories,
  recomputeFloorElevations,
} from "../model/types";
import type {
  Component,
  Drawing2D,
  DrawingLevel,
  HatchStyle,
  LayerCategory,
  LineStyle,
  Project,
  Vec2,
} from "../model/types";
import { commitTransform } from "../tools/transform";
import type { CopyMode, TransformOp, TransformSelection } from "../tools/transform";
import { centroid as roomCentroid } from "../geometry/roomArea";
import { t } from "../i18n";
import type { StoreApi } from "./store";
import { createHistorySlice, pushHistoryPatch } from "./historySlice";
import type { HistorySlice } from "./historySlice";
import type { NotifyKind } from "./notifySlice";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface ProjectSlice {
  project: Project;

  // ── Projekt direkt setzen (für Werkzeuge/Transformationen aus App) ────────
  /** Ersetzt das Projekt (Teil-/Updater wie React-setState). */
  setProject: (next: Project | ((p: Project) => Project)) => void;

  // ── Zeichnungsebenen (Levels/Geschosse) ──────────────────────────────────
  toggleLevelVisible: (id: string) => void;
  patchActiveFloor: (patch: Partial<DrawingLevel>) => void;
  addFloor: () => void;
  addDrawing: () => void;
  /** Legt eine neue Schnitt-Zeichnungsebene (kind:"section") als Platzhalter an. */
  addSection: () => void;
  /** Legt eine neue Ansichts-Zeichnungsebene (kind:"elevation") als Platzhalter an. */
  addElevation: () => void;
  /**
   * Legt eine neue freie Zeichnungsebene (kind:"drawing") mit dem gegebenen
   * Namen an und liefert ihre ID zurück (z. B. als Ziel eines DXF-Imports).
   */
  addDrawingLevel: (name: string) => string;
  /** Hängt fertige Drawing2D-Elemente an (z. B. aus einem DXF-Import). */
  importDrawings: (drawings: import("../model/types").Drawing2D[]) => void;
  patchLevel: (id: string, patch: Partial<DrawingLevel>) => void;
  duplicateLevel: (id: string) => void;
  deleteLevel: (id: string) => void;

  // ── Ebenen (Kategorien) ───────────────────────────────────────────────────
  toggleCategoryVisible: (code: string) => void;
  addCategory: () => void;
  patchCategory: (code: string, patch: Partial<LayerCategory>) => void;
  addSubCategory: (parentCode: string) => void;
  duplicateCategory: (code: string) => void;
  deleteCategory: (code: string) => void;
  assignWallCategory: (wallId: string, code: string) => void;

  // ── Sichtbarkeits-Kombinationen (Ebenen-/Zeichnungs-Komb.) ────────────────
  /** Liest je Kategorie-`code` → `visible` aus dem Layer-Baum (rekursiv). */
  snapshotLayerVisibility: () => Record<string, boolean>;
  /**
   * Setzt im Layer-Baum jede Kategorie, deren `code` in `codes` vorkommt, auf
   * den gespeicherten Wert (rekursiv, immutabel). Unbekannte Codes werden
   * ignoriert; nicht enthaltene Kategorien bleiben unverändert.
   */
  applyLayerVisibility: (codes: Record<string, boolean>) => void;
  /** Liest je DrawingLevel-`id` → `visible`. */
  snapshotDrawingVisibility: () => Record<string, boolean>;
  /** Setzt `drawingLevels[].visible` gemäß `ids` (unbekannte Ids ignorieren). */
  applyDrawingVisibility: (ids: Record<string, boolean>) => void;

  // ── Ressourcen (Components / Hatches / LineStyles) ────────────────────────
  patchComponent: (id: string, patch: Partial<Component>) => void;
  addComponent: () => void;
  deleteComponent: (id: string) => void;
  patchHatch: (id: string, patch: Partial<HatchStyle>) => void;
  addHatch: () => void;
  deleteHatch: (id: string) => void;
  patchLineStyle: (id: string, patch: Partial<LineStyle>) => void;
  addLineStyle: () => void;
  deleteLineStyle: (id: string) => void;
  importLineStyles: (styles: Omit<LineStyle, "id">[]) => void;
  importHatches: (hatches: Omit<HatchStyle, "id">[]) => void;

  // ── Editier-Griffe + Body-Move des selektierten Elements ──────────────────
  moveGripOf: (
    drawingId: string | null,
    wallId: string | null,
    index: number,
    pt: Vec2,
  ) => void;
  moveElementByOf: (
    drawingId: string | null,
    wallId: string | null,
    delta: Vec2,
  ) => void;
  /**
   * Verschiebt eine SEITE (Kante) des selektierten Elements: BEIDE Vertices der
   * Kante (`aIndex`/`bIndex`) um denselben `delta` (immutabel). Beim Rechteck
   * werden min/max anschließend neu normalisiert; bei der Wand bewegt sich
   * `start`+`end` gemeinsam (ganze Wand senkrecht).
   */
  moveEdgeOf: (
    drawingId: string | null,
    wallId: string | null,
    aIndex: number,
    bIndex: number,
    delta: Vec2,
  ) => void;

  // ── Selektions-Attribute (für Attributes-/Object-Info-Paletten) ───────────
  /** Setzt die (Strich-)Farbe eines Drawing2D bzw. einer Wand (Override). */
  setElementColor: (
    kind: "wall" | "drawing2d",
    id: string,
    color: string,
  ) => void;
  /** Setzt die direkte Strichstärke (mm) — NUR Drawing2D (Wände haben keine). */
  setElementWeight: (id: string, weightMm: number) => void;
  /** Setzt/entfernt die Füllschraffur — NUR Drawing2D (geschlossene Formen). */
  setElementFill: (id: string, hatchId: string | null) => void;
  /**
   * Setzt/entfernt die Vollton-Füllfarbe — NUR Drawing2D (geschlossene Formen).
   * `null` entfernt das Feld (Fläche wieder transparent).
   */
  setElementFillColor: (id: string, fillColor: string | null) => void;
  /**
   * Setzt/entfernt den Vordergrund-Override (Muster-/Schraffurfarbe) — Wand,
   * Decke oder Drawing2D. `null` = „Nach System" (Feld entfernen → erben).
   */
  setElementForeground: (
    kind: "wall" | "ceiling" | "drawing2d",
    id: string,
    value: string | null,
  ) => void;
  /**
   * Setzt/entfernt den Hintergrund-Override (Füllfarbe/Poché) — Wand, Decke
   * oder Drawing2D. `null` = „Nach System" (Feld entfernen → erben).
   */
  setElementBackground: (
    kind: "wall" | "ceiling" | "drawing2d",
    id: string,
    value: string | null,
  ) => void;
  /**
   * Generischer immutabler Patch auf ein Drawing2D (per ID) — analog zu
   * `updateWall`/`updateCeiling`. Trägt u. a. die By-Layer/By-Object-
   * Quellenfelder (`foregroundSource`/`backgroundSource`/`strokeWeightSource`/
   * `hatchSource`), die kein eigenes Setter-Paar haben.
   */
  updateDrawing2D: (id: string, patch: Partial<Drawing2D>) => void;
  /**
   * Sortiert die gewählten 2D-Zeichnungselemente in `drawings2d` um (z-Anordnen
   * im Grundriss). Die Array-Reihenfolge IST die Zeichenreihenfolge — spätere
   * Position = weiter oben/vorn (siehe `generatePlan.ts`). Unbekannte IDs
   * werden ignoriert; die relative Reihenfolge der Auswahl bleibt erhalten.
   * - "front"/"back": Auswahl ans Ende/an den Anfang des Arrays.
   * - "forward"/"backward": Auswahl je einen Schritt Richtung Ende/Anfang.
   */
  reorderDrawings: (
    ids: string[],
    op: "front" | "back" | "forward" | "backward",
  ) => void;
  /**
   * Skaliert die Geometrie eines Elements auf Zielbreite×-höhe (Meter) um einen
   * Ankerpunkt (fx/fy ∈ [0,1] relativ zur bbox; 0,0 = oben-links).
   */
  resizeElement: (
    kind: "wall" | "drawing2d",
    id: string,
    w: number,
    h: number,
    anchor: { fx: number; fy: number },
  ) => void;

  // ── Transformation (Bewegen/Spiegeln/Drehen) committen ────────────────────
  commitTransformOn: (
    sel: TransformSelection,
    op: TransformOp,
    points: Vec2[],
    copyMode: CopyMode,
    count: number,
  ) => void;

  // ── Wand-Attribute (Object-Info-Panel) ────────────────────────────────────
  /** Generischer immutabler Patch auf eine Wand (per ID). */
  updateWall: (id: string, patch: Partial<import("../model/types").Wall>) => void;
  /**
   * Setzt die Gesamtdicke einer EINSCHICHTIGEN Wand. Ansatz: editiert die
   * Schichtdicke des Wandtyps. Ist der Wandtyp mehrschichtig oder von mehr als
   * dieser einen Wand genutzt, wird ein dedizierter einschichtiger Wandtyp
   * (Klon der ersten Schicht) erzeugt und der Wand zugewiesen — so wirkt die
   * Dicke nur auf diese Wand und teilt keine Presets versehentlich.
   */
  setWallThickness: (wallId: string, thickness: number) => void;

  // ── Decken-Editieren ──────────────────────────────────────────────────────
  /** Verschiebt EINEN Umriss-Vertex (per Index) einer Decke. */
  moveCeilingGrip: (ceilingId: string, index: number, pt: Vec2) => void;
  /** Verschiebt eine Decke (ganzer Umriss) um `delta`. */
  moveCeilingBy: (ceilingId: string, delta: Vec2) => void;
  /** Verschiebt eine Umriss-KANTE (beide Vertices) einer Decke um `delta`. */
  moveCeilingEdge: (
    ceilingId: string,
    aIndex: number,
    bIndex: number,
    delta: Vec2,
  ) => void;
  /** Generischer immutabler Patch auf eine Decke (per ID). */
  updateCeiling: (
    id: string,
    patch: Partial<import("../model/types").Ceiling>,
  ) => void;
  /** Setzt die Gesamtdicke einer Decke (thickness-Übersteuerung, Meter). */
  setCeilingThickness: (ceilingId: string, thickness: number) => void;

  // ── Öffnungs-Editieren (Object-Info-Panel) ────────────────────────────────
  /** Generischer immutabler Patch auf eine Öffnung (per ID). */
  updateOpening: (
    id: string,
    patch: Partial<import("../model/types").Opening>,
  ) => void;

  /** Immutable Änderung eines Dachs (Form/Neigung/Überstand/Firstrichtung/Dicke). */
  updateRoof: (
    id: string,
    patch: Partial<import("../model/types").Roof>,
  ) => void;

  // ── Treppen-Editieren ──────────────────────────────────────────────────────
  /** Verschiebt eine Treppe (Antritt) um `delta`. */
  moveStairBy: (stairId: string, delta: Vec2) => void;
  /** Generischer immutabler Patch auf eine Treppe (per ID). */
  updateStair: (
    id: string,
    patch: Partial<import("../model/types").Stair>,
  ) => void;

  // ── Raum-Editieren ──────────────────────────────────────────────────────────
  /** Verschiebt einen Raum (ganzer Umriss + optionaler Stempel-Anker) um `delta`. */
  moveRoomBy: (roomId: string, delta: Vec2) => void;
  /** Verschiebt EINEN Umriss-Vertex (per Index) eines Raums. */
  moveRoomGrip: (roomId: string, index: number, pt: Vec2) => void;
  /** Verschiebt eine Umriss-KANTE (beide Vertices) eines Raums um `delta`. */
  moveRoomEdge: (
    roomId: string,
    aIndex: number,
    bIndex: number,
    delta: Vec2,
  ) => void;
  /** Generischer immutabler Patch auf einen Raum (per ID). */
  updateRoom: (
    id: string,
    patch: Partial<import("../model/types").Room>,
  ) => void;
  /** Verschiebt NUR den Stempel-Anker eines Raums um `delta` (Kontur bleibt). */
  moveRoomStamp: (roomId: string, delta: Vec2) => void;
  /** Setzt den Stempel-Anker eines Raums absolut. */
  setRoomStampAnchor: (roomId: string, anchor: Vec2) => void;
  /** Setzt den Rich-Text des Raum-Stempels. */
  setRoomStampDoc: (
    roomId: string,
    doc: import("../model/types").RichTextDoc,
  ) => void;
  /** Setzt den strukturierten Raum-Stempel (Feldmodell). */
  setRoomStamp: (
    roomId: string,
    stamp: import("../model/types").RoomStamp,
  ) => void;
}

/**
 * Minimaler View-Ausschnitt, den Projekt-Aktionen lesen/schreiben dürfen
 * (Cross-Slice). Der Store komponiert ProjectSlice mit dieser Sicht, sodass
 * `get()`/`set` typsicher auf `activeLevelId` zugreifen können. Die
 * History-Felder gehören ebenfalls dazu: `setProject` (unten) ist der EINZIGE
 * Durchlaufpunkt jeder Projekt-Mutation und pusht dort bei jeder ECHTEN
 * Änderung auf `undoStack`.
 */
type ProjectSliceDeps = {
  activeLevelId: string;
  /** Nicht-blockierende Kurzmeldung (Toast) — Ersatz für `window.alert`, das
   *  im Tauri-WKWebView deaktiviert ist (siehe notifySlice.ts). */
  notify: (message: string, kind?: NotifyKind) => void;
} & HistorySlice;

export function createProjectSlice(
  api: StoreApi<ProjectSlice & ProjectSliceDeps>,
): ProjectSlice & HistorySlice {
  const { set, get } = api;

  // Koaleszenz-Buchführung für Drag-Serien (Griff ziehen, Element verschieben,
  // Kante ziehen, …): diese Aktionen rufen `setProject` bei JEDEM
  // Maus-Move-Schritt auf (kein separates Draft/Preview + Commit-Muster wie
  // bei den Zeichenwerkzeugen — dort läuft die Vorschau über lokalen
  // `draft`-State in App.tsx, und `setProject` wird erst einmal beim Commit
  // aufgerufen, siehe `applyToolResult`/`onToolCommit` in App.tsx). Ohne
  // Koaleszenz würde EIN Drag zig Undo-Schritte erzeugen. Ephemer (wie ein
  // Ref) — kein reaktiver State nötig, wird bei jedem `setProject`-Aufruf neu
  // bewertet und bei `undo`/`redo` zurückgesetzt (siehe `onAfterJump` unten).
  let lastCoalesceKey: string | undefined;
  let lastCoalesceAt = 0;
  const COALESCE_WINDOW_MS = 400;

  const history = createHistorySlice(
    api as unknown as StoreApi<HistorySlice & { project: Project }>,
    () => {
      // Nach einem Sprung (undo/redo) muss die NÄCHSTE Aktion garantiert
      // pushen, auch wenn sie zufällig denselben coalesceKey trägt wie die
      // Serie vor dem Sprung — sonst würde sie mit der alten Serie
      // verschmolzen und verschwände spurlos (kein Undo-Eintrag).
      lastCoalesceKey = undefined;
    },
  );

  // Bequemer immutabler Projekt-Updater (wie setProject in App). Zweiter,
  // optionaler Parameter `coalesceKey`: NUR von den paar bekannten
  // Hochfrequenz-Aktionen (Grip-Drag & Co., s. u.) gesetzt — alle anderen ~50
  // Aktionen in dieser Datei rufen `setProject(fn)` ohne Key auf und pushen
  // damit IMMER diskret (kein Koaleszieren zwischen unterschiedlichen
  // Aktionen möglich, auch nicht bei zufällig identischem Timing in Tests).
  const setProject = (
    next: Project | ((p: Project) => Project),
    coalesceKey?: string,
  ) =>
    set((s) => {
      const nextProject =
        typeof next === "function" ? (next as (p: Project) => Project)(s.project) : next;
      // No-Op-Schutz: echte Immutable-Updates liefern bei tatsächlicher
      // Änderung immer eine NEUE Referenz — bleibt sie gleich, gab es keine
      // Änderung, also kein History-Eintrag (und `set` selbst benachrichtigt
      // dann ebenfalls nicht, da der Patch leer ist).
      if (nextProject === s.project) return {};
      const now = Date.now();
      const coalesced =
        coalesceKey !== undefined &&
        coalesceKey === lastCoalesceKey &&
        now - lastCoalesceAt < COALESCE_WINDOW_MS;
      lastCoalesceKey = coalesceKey;
      lastCoalesceAt = now;
      if (coalesced) return { project: nextProject };
      return { project: nextProject, ...pushHistoryPatch(s.undoStack, s.project) };
    });

  return {
    ...history,

    project: sampleProject,

    setProject,

    // ── Zeichnungsebenen ───────────────────────────────────────────────────
    toggleLevelVisible: (id) =>
      setProject((p) => ({
        ...p,
        drawingLevels: p.drawingLevels.map((z) =>
          z.id === id ? { ...z, visible: !z.visible } : z,
        ),
      })),

    patchActiveFloor: (patch) => {
      const activeLevelId = get().activeLevelId;
      setProject((p) => ({
        ...p,
        drawingLevels: recomputeFloorElevations(
          p.drawingLevels.map((z) =>
            z.id === activeLevelId ? { ...z, ...patch } : z,
          ),
        ),
      }));
    },

    addFloor: () =>
      setProject((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "floor").length + 1;
        const floor: DrawingLevel = {
          id: `floor-${Date.now()}`,
          name: t("default.floorName", { n }),
          kind: "floor",
          visible: true,
          locked: false,
          floorHeight: 2.6,
          cutHeight: 1.0,
        };
        return {
          ...p,
          drawingLevels: recomputeFloorElevations([...p.drawingLevels, floor]),
        };
      }),

    addDrawing: () =>
      setProject((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "drawing").length + 1;
        const drawing: DrawingLevel = {
          id: `drawing-${Date.now()}`,
          name: t("default.drawingName", { n }),
          kind: "drawing",
          visible: true,
          locked: false,
        };
        return { ...p, drawingLevels: [...p.drawingLevels, drawing] };
      }),

    // Schnitt/Ansicht sind vorerst Platzhalter ohne Schnittlinie (linePoints
    // bleibt undefined, bis die Schnitt-UI existiert — siehe toSection.ts).
    addSection: () =>
      setProject((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "section").length + 1;
        const section: DrawingLevel = {
          id: `section-${Date.now()}`,
          name: t("default.sectionName", { n }),
          kind: "section",
          visible: true,
          locked: false,
        };
        return { ...p, drawingLevels: [...p.drawingLevels, section] };
      }),

    addElevation: () =>
      setProject((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "elevation").length + 1;
        const elevation: DrawingLevel = {
          id: `elevation-${Date.now()}`,
          name: t("default.elevationName", { n }),
          kind: "elevation",
          visible: true,
          locked: false,
        };
        return { ...p, drawingLevels: [...p.drawingLevels, elevation] };
      }),

    // Neue freie Zeichnungsebene mit explizitem Namen anlegen und ihre ID
    // zurückgeben (Ziel-Ebene eines DXF-Imports). Der Name kommt vom Aufrufer
    // (Dialog); leere Eingabe fällt auf den Default-Namen zurück.
    addDrawingLevel: (name) => {
      const id = `drawing-${Date.now()}`;
      setProject((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "drawing").length + 1;
        const drawing: DrawingLevel = {
          id,
          name: name.trim() || t("default.drawingName", { n }),
          kind: "drawing",
          visible: true,
          locked: false,
        };
        return { ...p, drawingLevels: [...p.drawingLevels, drawing] };
      });
      return id;
    },

    importDrawings: (drawings) =>
      setProject((p) =>
        drawings.length
          ? { ...p, drawings2d: [...p.drawings2d, ...drawings] }
          : p,
      ),

    patchLevel: (id, patch) =>
      setProject((p) => ({
        ...p,
        drawingLevels: recomputeFloorElevations(
          p.drawingLevels.map((z) => (z.id === id ? { ...z, ...patch } : z)),
        ),
      })),

    duplicateLevel: (id) =>
      setProject((p) => {
        const i = p.drawingLevels.findIndex((z) => z.id === id);
        if (i < 0) return p;
        const src = p.drawingLevels[i];
        const clone: DrawingLevel = {
          ...src,
          id: `${src.kind}-${Date.now()}`,
          name: t("default.copySuffixLevel", { name: src.name }),
        };
        const next = [...p.drawingLevels];
        next.splice(i + 1, 0, clone);
        return { ...p, drawingLevels: recomputeFloorElevations(next) };
      }),

    // Zeichnungsebene löschen (≥1 behalten). War es das aktive Geschoss, auf
    // die erste verbleibende Ebene wechseln (View-Feld, Cross-Slice).
    deleteLevel: (id) => {
      const { project, activeLevelId } = get();
      if (project.drawingLevels.length <= 1) return; // letzte behalten
      if (!project.drawingLevels.some((z) => z.id === id)) return;
      if (activeLevelId === id) {
        const fallback = project.drawingLevels.find((z) => z.id !== id);
        if (fallback) set({ activeLevelId: fallback.id });
      }
      setProject((p) => {
        const removedWallIds = new Set(
          p.walls.filter((w) => w.floorId === id).map((w) => w.id),
        );
        return {
          ...p,
          drawingLevels: recomputeFloorElevations(
            p.drawingLevels.filter((z) => z.id !== id),
          ),
          walls: p.walls.filter((w) => w.floorId !== id),
          ceilings: (p.ceilings ?? []).filter((c) => c.floorId !== id),
          stairs: (p.stairs ?? []).filter((s) => s.floorId !== id),
          rooms: (p.rooms ?? []).filter((r) => r.floorId !== id),
          doors: p.doors.filter((d) => !removedWallIds.has(d.hostWallId)),
          openings: (p.openings ?? []).filter(
            (o) => !removedWallIds.has(o.hostWallId),
          ),
        };
      });
    },

    // ── Ebenen (Kategorien) ────────────────────────────────────────────────
    toggleCategoryVisible: (code) =>
      setProject((p) => ({
        ...p,
        layers: toggleCategoryByCode(p.layers, code),
      })),

    addCategory: () =>
      setProject((p) => {
        const code = nextFreeCode(p.layers);
        const category: LayerCategory = {
          code,
          name: t("default.categoryName"),
          color: "#888888",
          lw: 0.18,
          visible: true,
          locked: false,
        };
        return { ...p, layers: [...p.layers, category] };
      }),

    patchCategory: (code, patch) =>
      setProject((p) => ({
        ...p,
        layers: patchCategoryByCode(p.layers, code, patch),
      })),

    addSubCategory: (parentCode) =>
      setProject((p) => {
        const code = nextFreeCode(p.layers);
        const child: LayerCategory = {
          code,
          name: t("default.subCategoryName"),
          color: "#888888",
          lw: 0.18,
          visible: true,
          locked: false,
        };
        return { ...p, layers: addChildByCode(p.layers, parentCode, child) };
      }),

    duplicateCategory: (code) =>
      setProject((p) => {
        const src = findCategory(p.layers, code);
        if (!src) return p;
        const clone: LayerCategory = {
          ...src,
          code: nextFreeCode(p.layers),
          name: t("default.copySuffixLayer", { name: src.name }),
          children: undefined,
        };
        return { ...p, layers: insertAfterCode(p.layers, code, clone) };
      }),

    deleteCategory: (code) =>
      setProject((p) => {
        if (flattenCategories(p.layers).length <= 1) return p; // letzte behalten
        const src = findCategory(p.layers, code);
        if (!src) return p;
        const codes = new Set(flattenCategories([src]).map((c) => c.code));
        const usedByWall = p.walls.some((w) => codes.has(w.categoryCode));
        const usedByDoor = p.doors.some((d) => codes.has(d.categoryCode));
        const usedByOpening = (p.openings ?? []).some((o) =>
          codes.has(o.categoryCode),
        );
        if (usedByWall || usedByDoor || usedByOpening) {
          get().notify(t("alert.layerInUse", { code: src.code, name: src.name }), "warning");
          return p;
        }
        return { ...p, layers: removeByCode(p.layers, code) };
      }),

    assignWallCategory: (wallId, code) =>
      setProject((p) => ({
        ...p,
        walls: p.walls.map((w) =>
          w.id === wallId ? { ...w, categoryCode: code } : w,
        ),
      })),

    // ── Sichtbarkeits-Kombinationen ────────────────────────────────────────
    snapshotLayerVisibility: () => {
      const out: Record<string, boolean> = {};
      for (const c of flattenCategories(get().project.layers)) {
        out[c.code] = c.visible;
      }
      return out;
    },

    applyLayerVisibility: (codes) =>
      setProject((p) => ({
        ...p,
        layers: applyVisibilityByCode(p.layers, codes),
      })),

    snapshotDrawingVisibility: () => {
      const out: Record<string, boolean> = {};
      for (const z of get().project.drawingLevels) out[z.id] = z.visible;
      return out;
    },

    applyDrawingVisibility: (ids) =>
      setProject((p) => ({
        ...p,
        drawingLevels: p.drawingLevels.map((z) =>
          z.id in ids ? { ...z, visible: ids[z.id] } : z,
        ),
      })),

    // ── Ressourcen ─────────────────────────────────────────────────────────
    patchComponent: (id, patch) =>
      setProject((p) => ({
        ...p,
        components: p.components.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      })),

    addComponent: () =>
      setProject((p) => {
        let hatches = p.hatches;
        let hatchId = hatches[0]?.id;
        if (!hatchId) {
          const fallback: HatchStyle = {
            id: `hatch-${Date.now()}`,
            name: t("default.hatchNone"),
            pattern: "none",
            scale: 1,
            angle: 0,
            color: "#2b3039",
          };
          hatches = [fallback];
          hatchId = fallback.id;
        }
        const component: Component = {
          id: `component-${Date.now()}`,
          name: t("default.componentName"),
          color: "#9aa0a6",
          hatchId,
          joinPriority: 50,
        };
        return { ...p, hatches, components: [...p.components, component] };
      }),

    deleteComponent: (id) =>
      setProject((p) => {
        const used = p.wallTypes.some((wt) =>
          wt.layers.some((l) => l.componentId === id),
        );
        if (used) {
          const name = p.components.find((c) => c.id === id)?.name ?? id;
          get().notify(t("alert.componentInUse", { name }), "warning");
          return p;
        }
        return { ...p, components: p.components.filter((c) => c.id !== id) };
      }),

    patchHatch: (id, patch) =>
      setProject((p) => ({
        ...p,
        hatches: p.hatches.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      })),

    addHatch: () =>
      setProject((p) => {
        const hatch: HatchStyle = {
          id: `hatch-${Date.now()}`,
          name: t("default.hatchName"),
          pattern: "diagonal",
          scale: 1,
          angle: 45,
          color: "#2b3039",
          lineStyleId: p.lineStyles[0]?.id,
        };
        return { ...p, hatches: [...p.hatches, hatch] };
      }),

    deleteHatch: (id) =>
      setProject((p) => {
        const used = p.components.some((c) => c.hatchId === id);
        if (used) {
          const name = p.hatches.find((h) => h.id === id)?.name ?? id;
          get().notify(t("alert.hatchInUse", { name }), "warning");
          return p;
        }
        return { ...p, hatches: p.hatches.filter((h) => h.id !== id) };
      }),

    patchLineStyle: (id, patch) =>
      setProject((p) => ({
        ...p,
        lineStyles: p.lineStyles.map((l) =>
          l.id === id ? { ...l, ...patch } : l,
        ),
      })),

    addLineStyle: () =>
      setProject((p) => {
        const lineStyle: LineStyle = {
          id: `line-${Date.now()}`,
          name: t("default.lineStyleName"),
          weight: 0.18,
          color: "#2b3039",
          dash: null,
        };
        return { ...p, lineStyles: [...p.lineStyles, lineStyle] };
      }),

    deleteLineStyle: (id) =>
      setProject((p) => {
        const used = p.hatches.some((h) => h.lineStyleId === id);
        if (used) {
          const name = p.lineStyles.find((l) => l.id === id)?.name ?? id;
          get().notify(t("alert.lineStyleInUse", { name }), "warning");
          return p;
        }
        return { ...p, lineStyles: p.lineStyles.filter((l) => l.id !== id) };
      }),

    importLineStyles: (styles) =>
      setProject((p) => ({
        ...p,
        lineStyles: [
          ...p.lineStyles,
          ...styles.map((s, i) => ({ ...s, id: `ls-${Date.now()}-${i}` })),
        ],
      })),

    importHatches: (hatches) =>
      setProject((p) => ({
        ...p,
        hatches: [
          ...p.hatches,
          ...hatches.map((h, i) => ({ ...h, id: `ht-${Date.now()}-${i}` })),
        ],
      })),

    // ── Editier-Griffe ─────────────────────────────────────────────────────
    // Diese Aktionen laufen AD-HOC bei jedem Maus-Move-Schritt eines Drags
    // (kein Draft/Commit-Muster wie bei den Zeichenwerkzeugen) — daher mit
    // coalesceKey, damit EIN Drag EINEN Undo-Schritt erzeugt statt vieler.
    moveGripOf: (drawingId, wallId, index, pt) =>
      setProject(
        (p) => moveGrip(p, drawingId, wallId, index, pt),
        `moveGripOf:${drawingId ?? ""}:${wallId ?? ""}:${index}`,
      ),

    moveElementByOf: (drawingId, wallId, delta) =>
      setProject(
        (p) => moveElementBy(p, drawingId, wallId, delta),
        `moveElementByOf:${drawingId ?? ""}:${wallId ?? ""}`,
      ),

    moveEdgeOf: (drawingId, wallId, aIndex, bIndex, delta) =>
      setProject(
        (p) => moveEdge(p, drawingId, wallId, aIndex, bIndex, delta),
        `moveEdgeOf:${drawingId ?? ""}:${wallId ?? ""}:${aIndex}:${bIndex}`,
      ),

    // ── Selektions-Attribute ───────────────────────────────────────────────
    setElementColor: (kind, id, color) =>
      setProject((p) => {
        if (kind === "drawing2d") {
          return {
            ...p,
            drawings2d: p.drawings2d.map((d) =>
              d.id === id ? { ...d, color } : d,
            ),
          };
        }
        return {
          ...p,
          walls: p.walls.map((w) => (w.id === id ? { ...w, color } : w)),
        };
      }),

    // Strichstärke gibt es als direktes Feld NUR auf Drawing2D; bei unbekannter
    // ID bleibt das Projekt unverändert (No-op).
    setElementWeight: (id, weightMm) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) =>
          d.id === id ? { ...d, weightMm } : d,
        ),
      })),

    // Füllschraffur NUR für Drawing2D; `null` entfernt die Schraffur (Feld weg).
    setElementFill: (id, hatchId) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) => {
          if (d.id !== id) return d;
          if (hatchId === null) {
            const { hatchId: _omit, ...rest } = d;
            return rest;
          }
          return { ...d, hatchId };
        }),
      })),

    // Vollton-Füllfarbe NUR für Drawing2D; `null` entfernt das Feld.
    setElementFillColor: (id, fillColor) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) => {
          if (d.id !== id) return d;
          if (fillColor === null) {
            const { fillColor: _omit, ...rest } = d;
            return rest;
          }
          return { ...d, fillColor };
        }),
      })),

    // Vordergrund-/Hintergrund-Override (Wand/Decke/Drawing2D); `null` löscht
    // das Feld (→ „Nach System", erbt wieder vom Bauteil/System).
    setElementForeground: (kind, id, value) =>
      setProject((p) => setOverrideField(p, kind, id, "foreground", value)),
    setElementBackground: (kind, id, value) =>
      setProject((p) => setOverrideField(p, kind, id, "background", value)),

    updateDrawing2D: (id, patch) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) => (d.id === id ? { ...d, ...patch } : d)),
      })),

    reorderDrawings: (ids, op) =>
      setProject((p) => ({
        ...p,
        drawings2d: reorderDrawings2D(p.drawings2d, ids, op),
      })),

    // ── Größe (Resize um Anker) ────────────────────────────────────────────
    resizeElement: (kind, id, w, h, anchor) =>
      setProject((p) => resizeElement(p, kind, id, w, h, anchor)),

    // ── Transformation ─────────────────────────────────────────────────────
    commitTransformOn: (sel, op, points, copyMode, count) =>
      setProject((p) => commitTransform(p, sel, op, points, copyMode, count)),

    // ── Wand-Attribute ─────────────────────────────────────────────────────
    updateWall: (id, patch) =>
      setProject((p) => ({
        ...p,
        walls: p.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      })),

    setWallThickness: (wallId, thickness) =>
      setProject((p) => setWallThickness(p, wallId, thickness)),

    // ── Decken-Editieren ──────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf — auch hier läuft die
    // Mutation bei jedem Maus-Move-Schritt eines Drags.)
    moveCeilingGrip: (ceilingId, index, pt) =>
      setProject(
        (p) => mapCeiling(p, ceilingId, (c) => ({
          ...c,
          outline: c.outline.map((v, i) => (i === index ? pt : v)),
        })),
        `moveCeilingGrip:${ceilingId}:${index}`,
      ),

    moveCeilingBy: (ceilingId, delta) =>
      setProject(
        (p) => mapCeiling(p, ceilingId, (c) => ({
          ...c,
          outline: c.outline.map((v) => ({ x: v.x + delta.x, y: v.y + delta.y })),
        })),
        `moveCeilingBy:${ceilingId}`,
      ),

    moveCeilingEdge: (ceilingId, aIndex, bIndex, delta) =>
      setProject(
        (p) => mapCeiling(p, ceilingId, (c) => ({
          ...c,
          outline: c.outline.map((v, i) =>
            i === aIndex || i === bIndex ? { x: v.x + delta.x, y: v.y + delta.y } : v,
          ),
        })),
        `moveCeilingEdge:${ceilingId}:${aIndex}:${bIndex}`,
      ),

    updateCeiling: (id, patch) =>
      setProject((p) => mapCeiling(p, id, (c) => ({ ...c, ...patch }))),

    setCeilingThickness: (ceilingId, thickness) =>
      setProject((p) => setCeilingThickness(p, ceilingId, thickness)),

    // ── Öffnungs-Editieren ────────────────────────────────────────────────
    updateOpening: (id, patch) =>
      setProject((p) => ({
        ...p,
        openings: (p.openings ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)),
      })),

    // ── Dach-Editieren ─────────────────────────────────────────────────────
    updateRoof: (id, patch) =>
      setProject((p) => ({
        ...p,
        roofs: (p.roofs ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
      })),

    // ── Treppen-Editieren ──────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf.)
    moveStairBy: (stairId, delta) =>
      setProject(
        (p) =>
          mapStair(p, stairId, (s) => ({
            ...s,
            start: { x: s.start.x + delta.x, y: s.start.y + delta.y },
            ...(s.center
              ? { center: { x: s.center.x + delta.x, y: s.center.y + delta.y } }
              : {}),
          })),
        `moveStairBy:${stairId}`,
      ),

    updateStair: (id, patch) =>
      setProject((p) => mapStair(p, id, (s) => ({ ...s, ...patch }))),

    // ── Raum-Editieren ──────────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf.)
    moveRoomBy: (roomId, delta) =>
      setProject(
        (p) =>
          mapRoom(p, roomId, (r) => ({
            ...r,
            boundary: r.boundary.map((v) => ({ x: v.x + delta.x, y: v.y + delta.y })),
            ...(r.stampAnchor
              ? {
                  stampAnchor: {
                    x: r.stampAnchor.x + delta.x,
                    y: r.stampAnchor.y + delta.y,
                  },
                }
              : {}),
          })),
        `moveRoomBy:${roomId}`,
      ),

    moveRoomGrip: (roomId, index, pt) =>
      setProject(
        (p) =>
          mapRoom(p, roomId, (r) => ({
            ...r,
            boundary: r.boundary.map((v, i) => (i === index ? pt : v)),
          })),
        `moveRoomGrip:${roomId}:${index}`,
      ),

    moveRoomEdge: (roomId, aIndex, bIndex, delta) =>
      setProject(
        (p) =>
          mapRoom(p, roomId, (r) => ({
            ...r,
            boundary: r.boundary.map((v, i) =>
              i === aIndex || i === bIndex
                ? { x: v.x + delta.x, y: v.y + delta.y }
                : v,
            ),
          })),
        `moveRoomEdge:${roomId}:${aIndex}:${bIndex}`,
      ),

    updateRoom: (id, patch) =>
      setProject((p) => mapRoom(p, id, (r) => ({ ...r, ...patch }))),

    moveRoomStamp: (roomId, delta) =>
      setProject((p) =>
        mapRoom(p, roomId, (r) => {
          const base = r.stampAnchor ?? roomCentroid(r.boundary);
          return {
            ...r,
            stampAnchor: { x: base.x + delta.x, y: base.y + delta.y },
          };
        }),
      ),

    setRoomStampAnchor: (roomId, anchor) =>
      setProject((p) => mapRoom(p, roomId, (r) => ({ ...r, stampAnchor: anchor }))),

    setRoomStampDoc: (roomId, doc) =>
      setProject((p) => mapRoom(p, roomId, (r) => ({ ...r, stampDoc: doc }))),

    setRoomStamp: (roomId, stamp) =>
      setProject((p) => mapRoom(p, roomId, (r) => ({ ...r, stamp }))),
  };
}

/** Immutabler Map über einen Raum (per ID); No-op ohne Treffer. */
function mapRoom(
  project: Project,
  roomId: string,
  fn: (r: import("../model/types").Room) => import("../model/types").Room,
): Project {
  const rooms = project.rooms ?? [];
  return {
    ...project,
    rooms: rooms.map((r) => (r.id === roomId ? fn(r) : r)),
  };
}

/** Immutabler Map über eine Treppe (per ID); No-op ohne Treffer. */
function mapStair(
  project: Project,
  stairId: string,
  fn: (s: import("../model/types").Stair) => import("../model/types").Stair,
): Project {
  const stairs = project.stairs ?? [];
  return {
    ...project,
    stairs: stairs.map((s) => (s.id === stairId ? fn(s) : s)),
  };
}

/** Immutabler Map über eine Decke (per ID); No-op ohne Treffer. */
/**
 * Setzt/entfernt einen optionalen Farb-Override (`foreground`/`background`) an
 * einem Element (Wand, Decke oder Drawing2D). `value === null` entfernt das Feld
 * (→ „Nach System", erbt wieder). Immutable; unbekannte IDs sind ein No-op.
 */
function setOverrideField(
  project: Project,
  kind: "wall" | "ceiling" | "drawing2d",
  id: string,
  field: "foreground" | "background",
  value: string | null,
): Project {
  const apply = <T extends { id: string }>(item: T): T => {
    if (item.id !== id) return item;
    if (value === null) {
      const { [field]: _omit, ...rest } = item as Record<string, unknown>;
      return rest as unknown as T;
    }
    return { ...item, [field]: value };
  };
  if (kind === "wall") return { ...project, walls: project.walls.map(apply) };
  if (kind === "ceiling")
    return { ...project, ceilings: (project.ceilings ?? []).map(apply) };
  return { ...project, drawings2d: project.drawings2d.map(apply) };
}

/**
 * Z-Anordnen im Grundriss: `drawings2d` IST die Zeichenreihenfolge (spätere
 * Position = weiter oben, siehe `generatePlan.ts`). Unbekannte IDs werden
 * ignoriert; reine, immutable Umsortierung.
 *
 * - "front"/"back": die gewählten Elemente wandern gesammelt ans Ende/an den
 *   Anfang des Arrays, ihre relative Reihenfolge untereinander bleibt erhalten.
 * - "forward"/"backward": jedes gewählte Element rückt einzeln um eine
 *   Position Richtung Ende/Anfang vor. Bei "forward" von hinten nach vorn
 *   iteriert (sonst würde ein vorderes Element ein gerade verschobenes
 *   sofort wieder überholen); bei "backward" entsprechend von vorn nach
 *   hinten. Über die Array-Grenzen hinaus passiert nichts (kein Wrap).
 */
function reorderDrawings2D(
  drawings: Drawing2D[],
  ids: string[],
  op: "front" | "back" | "forward" | "backward",
): Drawing2D[] {
  const selected = new Set(ids.filter((id) => drawings.some((d) => d.id === id)));
  if (selected.size === 0) return drawings;

  if (op === "front" || op === "back") {
    const picked = drawings.filter((d) => selected.has(d.id));
    const rest = drawings.filter((d) => !selected.has(d.id));
    return op === "front" ? [...rest, ...picked] : [...picked, ...rest];
  }

  // "forward" / "backward": jedes gewählte Element um genau eine Position
  // tauschen — Iterationsrichtung verhindert, dass mehrfach-selektierte
  // Nachbarn sich gegenseitig überholen.
  const arr = drawings.slice();
  if (op === "forward") {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (selected.has(arr[i].id) && !selected.has(arr[i + 1].id)) {
        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      }
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      if (selected.has(arr[i].id) && !selected.has(arr[i - 1].id)) {
        [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
      }
    }
  }
  return arr;
}

function mapCeiling(
  project: Project,
  ceilingId: string,
  fn: (c: import("../model/types").Ceiling) => import("../model/types").Ceiling,
): Project {
  const ceilings = project.ceilings ?? [];
  return {
    ...project,
    ceilings: ceilings.map((c) => (c.id === ceilingId ? fn(c) : c)),
  };
}

/**
 * Setzt die Gesamtdicke einer einschichtigen Wand über ihre Wandtyp-Schicht.
 * Wenn der Wandtyp einschichtig ist UND nur von dieser Wand genutzt wird, wird
 * er direkt editiert. Sonst wird ein dedizierter einschichtiger Wandtyp (Klon
 * der ersten Schicht des aktuellen Typs) erzeugt und der Wand zugewiesen.
 */
function setWallThickness(
  project: Project,
  wallId: string,
  thickness: number,
): Project {
  if (!isFinite(thickness) || thickness <= 0) return project;
  const wall = project.walls.find((w) => w.id === wallId);
  if (!wall) return project;
  const wt = project.wallTypes.find((t) => t.id === wall.wallTypeId);
  if (!wt || wt.layers.length === 0) return project;

  const single = wt.layers.length === 1;
  const usedByOthers = project.walls.some(
    (w) => w.id !== wallId && w.wallTypeId === wt.id,
  );

  if (single && !usedByOthers) {
    // Direkt die Schichtdicke des (exklusiven, einschichtigen) Wandtyps setzen.
    return {
      ...project,
      wallTypes: project.wallTypes.map((t) =>
        t.id === wt.id
          ? { ...t, layers: [{ ...t.layers[0], thickness }] }
          : t,
      ),
    };
  }

  // Dedizierten einschichtigen Wandtyp erzeugen (erste Schicht klonen) und der
  // Wand zuweisen — damit die Dicke nur diese Wand betrifft.
  const id = `wt-${Date.now()}`;
  const clone = {
    id,
    name: t("default.wallTypeSingle", { thickness: thickness.toFixed(2) }),
    layers: [{ ...wt.layers[0], thickness }],
  };
  return {
    ...project,
    wallTypes: [...project.wallTypes, clone],
    walls: project.walls.map((w) =>
      w.id === wallId ? { ...w, wallTypeId: id } : w,
    ),
  };
}

/**
 * Setzt die Gesamtdicke einer einschichtigen Decke über ihre Deckentyp-Schicht
 * — analog `setWallThickness`. Wenn der aktive Aufbau-Typ einschichtig UND ein
 * DEDIZIERTER Deckentyp (`ceilingTypeId`) ist, der nur von dieser Decke genutzt
 * wird, wird er direkt editiert. Sonst wird ein neuer, dedizierter
 * einschichtiger Deckentyp (Klon der ersten Schicht des aktuellen Aufbaus)
 * erzeugt und der Decke zugewiesen. Der geteilte LEGACY-Wandtyp
 * (`Ceiling.wallTypeId`) wird dabei NIE mutiert — er gehört den Wänden.
 */
function setCeilingThickness(
  project: Project,
  ceilingId: string,
  thickness: number,
): Project {
  if (!isFinite(thickness) || thickness <= 0) return project;
  const ceiling = (project.ceilings ?? []).find((c) => c.id === ceilingId);
  if (!ceiling) return project;
  const activeId = ceiling.ceilingTypeId ?? ceiling.wallTypeId;
  const ct =
    (project.ceilingTypes ?? []).find((t) => t.id === ceiling.ceilingTypeId) ??
    project.wallTypes.find((t) => t.id === ceiling.wallTypeId);
  if (!ct || ct.layers.length === 0) return project;

  const single = ct.layers.length === 1;
  const usedByOthers = (project.ceilings ?? []).some(
    (c) => c.id !== ceilingId && (c.ceilingTypeId ?? c.wallTypeId) === activeId,
  );

  if (single && !usedByOthers && ceiling.ceilingTypeId) {
    // Direkt die Schichtdicke des (exklusiven, einschichtigen) Deckentyps setzen.
    return {
      ...project,
      ceilingTypes: (project.ceilingTypes ?? []).map((t) =>
        t.id === ct.id ? { ...t, layers: [{ ...t.layers[0], thickness }] } : t,
      ),
    };
  }

  // Dedizierten einschichtigen Deckentyp erzeugen (erste Schicht klonen) und
  // der Decke zuweisen — damit die Dicke nur diese Decke betrifft.
  const id = `ct-${Date.now()}`;
  const clone = {
    id,
    name: t("default.ceilingTypeSingle", { thickness: thickness.toFixed(2) }),
    layers: [{ ...ct.layers[0], thickness }],
  };
  return {
    ...project,
    ceilingTypes: [...(project.ceilingTypes ?? []), clone],
    ceilings: (project.ceilings ?? []).map((c) =>
      c.id === ceilingId ? { ...c, ceilingTypeId: id, thickness: undefined } : c,
    ),
  };
}

// ── Resize (Skalierung auf Zielmaß um einen Anker) ───────────────────────────

/**
 * Skaliert ein Element auf Zielbreite `w` × -höhe `h` (Meter) um einen
 * Ankerpunkt. `anchor.fx/fy ∈ [0,1]` liegen relativ zur aktuellen bbox
 * (0,0 = oben-links, 1,1 = unten-rechts). Der Ankerpunkt bleibt fix; alle
 * übrigen Punkte werden um die Skalierungsfaktoren um ihn herum gestreckt.
 */
function resizeElement(
  project: Project,
  kind: "wall" | "drawing2d",
  id: string,
  w: number,
  h: number,
  anchor: { fx: number; fy: number },
): Project {
  if (kind === "drawing2d") {
    return {
      ...project,
      drawings2d: project.drawings2d.map((d) =>
        d.id === id ? { ...d, geom: resizeGeom(d.geom, w, h, anchor) } : d,
      ),
    };
  }
  return {
    ...project,
    walls: project.walls.map((wall) => {
      if (wall.id !== id) return wall;
      const box = bbox2([wall.start, wall.end]);
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      const apply = (p: Vec2): Vec2 => ({
        x: ax + (p.x - ax) * sx,
        y: ay + (p.y - ay) * sy,
      });
      return { ...wall, start: apply(wall.start), end: apply(wall.end) };
    }),
  };
}

/** bbox einer Punktliste. */
function bbox2(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Liefert Ankerpunkt (ax,ay) und Skalierungsfaktoren (sx,sy), um eine bbox auf
 * Zielbreite `w` × -höhe `h` zu bringen. Bei Null-Ausdehnung in einer Achse
 * bleibt der Faktor 1 (keine Division durch 0, keine Verschiebung).
 */
function scaleAround(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  w: number,
  h: number,
  anchor: { fx: number; fy: number },
): { ax: number; ay: number; sx: number; sy: number } {
  const bw = box.maxX - box.minX;
  const bh = box.maxY - box.minY;
  const ax = box.minX + anchor.fx * bw;
  const ay = box.minY + anchor.fy * bh;
  const sx = bw > 1e-9 ? w / bw : 1;
  const sy = bh > 1e-9 ? h / bh : 1;
  return { ax, ay, sx, sy };
}

/**
 * Skaliert eine 2D-Form auf Zielmaß um den Anker.
 *  • line/polyline/rect: jeder Punkt um den Anker skaliert (B/H aus bbox).
 *  • circle: Radius = halbe Zielbreite (min/Mittelwert wäre auch denkbar; Breite
 *    ist eindeutig), Mittelpunkt um den Anker verschoben.
 *  • arc: wie circle (Radius aus Zielbreite), Winkel unverändert.
 *  • text: nur die Einfügeposition wird um den Anker verschoben; die Schrifthöhe
 *    bleibt (Text skaliert über `height`, nicht über bbox — bewusst unverändert).
 */
function resizeGeom(
  g: import("../model/types").Drawing2DGeom,
  w: number,
  h: number,
  anchor: { fx: number; fy: number },
): import("../model/types").Drawing2DGeom {
  switch (g.shape) {
    case "line": {
      const { ax, ay, sx, sy } = scaleAround(bbox2([g.a, g.b]), w, h, anchor);
      const f = (p: Vec2): Vec2 => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy });
      return { ...g, a: f(g.a), b: f(g.b) };
    }
    case "polyline": {
      const { ax, ay, sx, sy } = scaleAround(bbox2(g.pts), w, h, anchor);
      const f = (p: Vec2): Vec2 => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy });
      return { ...g, pts: g.pts.map(f) };
    }
    case "rect": {
      const box = bbox2([g.min, g.max]);
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      const f = (p: Vec2): Vec2 => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy });
      const a = f(g.min);
      const b = f(g.max);
      return {
        ...g,
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
      };
    }
    case "circle":
    case "arc": {
      // bbox eines Kreises ist 2r×2r; der Anker liegt relativ dazu.
      const box = {
        minX: g.center.x - g.r,
        minY: g.center.y - g.r,
        maxX: g.center.x + g.r,
        maxY: g.center.y + g.r,
      };
      const ax = box.minX + anchor.fx * (2 * g.r);
      const ay = box.minY + anchor.fy * (2 * g.r);
      const r = Math.max(w, h) / 2 > 0 ? Math.max(w, h) / 2 : g.r;
      const sx = g.r > 1e-9 ? (w / 2) / g.r : 1;
      const sy = g.r > 1e-9 ? (h / 2) / g.r : 1;
      // Mittelpunkt anhand der nicht-uniformen Skalierung um den Anker schieben,
      // den Radius aber als skalaren Kreis (max der Zielmaße/2) setzen.
      const center: Vec2 = {
        x: ax + (g.center.x - ax) * sx,
        y: ay + (g.center.y - ay) * sy,
      };
      return { ...g, center, r };
    }
    case "text": {
      // Text: nur die Einfügeposition um den Anker schieben (Höhe bleibt).
      const box = { minX: g.at.x, minY: g.at.y, maxX: g.at.x, maxY: g.at.y };
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      return { ...g, at: { x: ax + (g.at.x - ax) * sx, y: ay + (g.at.y - ay) * sy } };
    }
    default:
      return g;
  }
}

// ── Editier-Griffe (verschoben aus App.tsx, 1:1) ─────────────────────────────

/**
 * Editier-Griffe (Eckpunkte) eines 2D-Zeichenelements in Modell-Metern. Phase 4
 * unterstützt line/polyline/rect; circle/arc/text bekommen (noch) keine Griffe.
 */
export function drawingVertices(d: import("../model/types").Drawing2D): Vec2[] {
  const g = d.geom;
  if (g.shape === "line") return [g.a, g.b];
  if (g.shape === "polyline") return [...g.pts];
  if (g.shape === "rect") {
    return [
      g.min,
      { x: g.max.x, y: g.min.y },
      g.max,
      { x: g.min.x, y: g.max.y },
    ];
  }
  // Text: EIN Griff am Ankerpunkt (zum Verschieben; siehe moveGrip).
  if (g.shape === "text") return [g.at];
  return [];
}

/**
 * Verschiebt den Griff `index` des selektierten Elements (2D-Element ODER Wand)
 * auf `pt` (immutabel). Beim Rechteck bleibt die Achsparallelität erhalten.
 */
function moveGrip(
  project: Project,
  drawingId: string | null,
  wallId: string | null,
  index: number,
  pt: Vec2,
): Project {
  if (drawingId) {
    return {
      ...project,
      drawings2d: project.drawings2d.map((d) => {
        if (d.id !== drawingId) return d;
        const g = d.geom;
        if (g.shape === "line") {
          return { ...d, geom: index === 0 ? { ...g, a: pt } : { ...g, b: pt } };
        }
        if (g.shape === "polyline") {
          const pts = g.pts.map((p, i) => (i === index ? pt : p));
          return { ...d, geom: { ...g, pts } };
        }
        if (g.shape === "rect") {
          const corners = [
            g.min,
            { x: g.max.x, y: g.min.y },
            g.max,
            { x: g.min.x, y: g.max.y },
          ];
          const opp = corners[(index + 2) % 4];
          const min = { x: Math.min(pt.x, opp.x), y: Math.min(pt.y, opp.y) };
          const max = { x: Math.max(pt.x, opp.x), y: Math.max(pt.y, opp.y) };
          return { ...d, geom: { ...g, min, max } };
        }
        // Text: der einzige Griff (Index 0) sitzt am Ankerpunkt → verschiebt ihn.
        if (g.shape === "text") return { ...d, geom: { ...g, at: pt } };
        return d;
      }),
    };
  }
  if (wallId) {
    return {
      ...project,
      walls: project.walls.map((w) =>
        w.id === wallId ? { ...w, ...(index === 0 ? { start: pt } : { end: pt }) } : w,
      ),
    };
  }
  return project;
}

/** Verschiebt das selektierte Element (2D-Element ODER Wand) um `delta` (parallel). */
function moveElementBy(
  project: Project,
  drawingId: string | null,
  wallId: string | null,
  delta: Vec2,
): Project {
  const mv = (p: Vec2): Vec2 => ({ x: p.x + delta.x, y: p.y + delta.y });
  if (drawingId) {
    return {
      ...project,
      drawings2d: project.drawings2d.map((d) => {
        if (d.id !== drawingId) return d;
        const g = d.geom;
        switch (g.shape) {
          case "line":
            return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
          case "polyline":
            return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
          case "rect":
            return { ...d, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
          case "circle":
          case "arc":
            return { ...d, geom: { ...g, center: mv(g.center) } };
          case "text":
            return { ...d, geom: { ...g, at: mv(g.at) } };
          default:
            return d;
        }
      }),
    };
  }
  if (wallId) {
    return {
      ...project,
      walls: project.walls.map((w) =>
        w.id === wallId ? { ...w, start: mv(w.start), end: mv(w.end) } : w,
      ),
    };
  }
  return project;
}

/**
 * Verschiebt eine SEITE (Kante) des selektierten Elements: beide Vertices der
 * Kante um `delta` (immutabel). Für 2D-Elemente:
 *  • rect: die zwei betroffenen Ecken (per Index) verschieben und min/max neu
 *    normalisieren — so wächst/schrumpft das Rechteck an genau dieser Seite.
 *  • polyline: die zwei Vertices `aIndex`/`bIndex` um `delta` verschieben.
 *  • line: beide Endpunkte verschieben (das gesamte Segment senkrecht).
 * Für die Wand: start+end gemeinsam (die ganze Wand senkrecht zur Achse).
 */
function moveEdge(
  project: Project,
  drawingId: string | null,
  wallId: string | null,
  aIndex: number,
  bIndex: number,
  delta: Vec2,
): Project {
  const mv = (p: Vec2): Vec2 => ({ x: p.x + delta.x, y: p.y + delta.y });
  if (drawingId) {
    return {
      ...project,
      drawings2d: project.drawings2d.map((d) => {
        if (d.id !== drawingId) return d;
        const g = d.geom;
        if (g.shape === "line") {
          // Linie hat nur eine Kante [0,1] → das ganze Segment verschieben.
          return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
        }
        if (g.shape === "polyline") {
          const pts = g.pts.map((p, i) => (i === aIndex || i === bIndex ? mv(p) : p));
          return { ...d, geom: { ...g, pts } };
        }
        if (g.shape === "rect") {
          // Ecken in derselben Reihenfolge wie drawingVertices, die zwei Kanten-
          // Ecken verschieben, dann bbox neu bilden (achsparallel halten).
          const corners = [
            g.min,
            { x: g.max.x, y: g.min.y },
            g.max,
            { x: g.min.x, y: g.max.y },
          ];
          const moved = corners.map((c, i) =>
            i === aIndex || i === bIndex ? mv(c) : c,
          );
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const c of moved) {
            minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
            maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
          }
          return { ...d, geom: { ...g, min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } };
        }
        return d;
      }),
    };
  }
  if (wallId) {
    // Wand: beide Enden gemeinsam → ganze Wand senkrecht verschieben.
    return {
      ...project,
      walls: project.walls.map((w) =>
        w.id === wallId ? { ...w, start: mv(w.start), end: mv(w.end) } : w,
      ),
    };
  }
  return project;
}

// ── Immutable Tree-Helfer (verschoben aus App.tsx, 1:1) ──────────────────────

/** Schaltet die Sichtbarkeit der Kategorie mit `code` im Baum um (immutabel). */
export function toggleCategoryByCode(
  cats: LayerCategory[],
  code: string,
): LayerCategory[] {
  return cats.map((c) => {
    if (c.code === code) return { ...c, visible: !c.visible };
    if (c.children)
      return { ...c, children: toggleCategoryByCode(c.children, code) };
    return c;
  });
}

/**
 * Setzt im Baum die `visible`-Flags gemäß `codes` (Code → sichtbar?, immutabel).
 * Kategorien, deren Code nicht in der Map steht, bleiben unverändert; Codes der
 * Map, die es nicht mehr gibt, werden stillschweigend ignoriert.
 */
export function applyVisibilityByCode(
  cats: LayerCategory[],
  codes: Record<string, boolean>,
): LayerCategory[] {
  return cats.map((c) => {
    const next = c.code in codes ? { ...c, visible: codes[c.code] } : c;
    if (next.children)
      return { ...next, children: applyVisibilityByCode(next.children, codes) };
    return next;
  });
}

/** Nächster freier zweistelliger Code über den ganzen Baum hinweg. */
export function nextFreeCode(cats: LayerCategory[]): string {
  const used = new Set<string>();
  const walk = (list: LayerCategory[]) => {
    for (const c of list) {
      used.add(c.code);
      if (c.children) walk(c.children);
    }
  };
  walk(cats);
  const nums = [...used].map((c) => parseInt(c, 10)).filter((n) => !isNaN(n));
  const start = nums.length ? Math.max(...nums) : 0;
  for (let i = start + 1; i < 1000; i++) {
    const c = String(i).padStart(2, "0");
    if (!used.has(c)) return c;
  }
  return String(Date.now());
}

/** Findet eine Kategorie (per Code) im Baum oder `undefined`. */
export function findCategory(
  cats: LayerCategory[],
  code: string,
): LayerCategory | undefined {
  for (const c of cats) {
    if (c.code === code) return c;
    if (c.children) {
      const hit = findCategory(c.children, code);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Patcht die Kategorie mit `code` im Baum (immutabel). */
function patchCategoryByCode(
  cats: LayerCategory[],
  code: string,
  patch: Partial<LayerCategory>,
): LayerCategory[] {
  return cats.map((c) => {
    if (c.code === code) return { ...c, ...patch };
    if (c.children)
      return { ...c, children: patchCategoryByCode(c.children, code, patch) };
    return c;
  });
}

/** Hängt `child` als letztes Kind an die Kategorie mit `parentCode` (immutabel). */
function addChildByCode(
  cats: LayerCategory[],
  parentCode: string,
  child: LayerCategory,
): LayerCategory[] {
  return cats.map((c) => {
    if (c.code === parentCode)
      return { ...c, children: [...(c.children ?? []), child] };
    if (c.children)
      return { ...c, children: addChildByCode(c.children, parentCode, child) };
    return c;
  });
}

/** Fügt `clone` direkt nach der Kategorie mit `code` auf derselben Ebene ein. */
function insertAfterCode(
  cats: LayerCategory[],
  code: string,
  clone: LayerCategory,
): LayerCategory[] {
  const out: LayerCategory[] = [];
  for (const c of cats) {
    const next =
      c.children && !c.children.some((k) => k.code === code)
        ? { ...c, children: insertAfterCode(c.children, code, clone) }
        : c;
    out.push(next);
    if (c.code === code) out.push(clone);
  }
  return out;
}

/** Entfernt die Kategorie mit `code` (samt Kindern) aus dem Baum (immutabel). */
function removeByCode(cats: LayerCategory[], code: string): LayerCategory[] {
  const out: LayerCategory[] = [];
  for (const c of cats) {
    if (c.code === code) continue;
    out.push(c.children ? { ...c, children: removeByCode(c.children, code) } : c);
  }
  return out;
}

/** Beschriftung einer Kategorie für die Status-Leiste: „Code Name". */
export function categoryLabel(cats: LayerCategory[], code: string): string {
  const c = findCategory(cats, code);
  return c ? `${c.code} ${c.name}` : code;
}
