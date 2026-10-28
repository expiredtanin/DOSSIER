// Projekt-Slice: das semantische Modell (`project`) plus ALLE Mutationen, die
// heute in App.tsx als Closures über setProject existieren. Reiner Umzug — die
// Logik ist 1:1 übernommen (inkl. recomputeFloorElevations, refs-aware delete,
// Tree-Helfern). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).
//
// Cross-Slice-Zugriffe: einige Aktionen lesen/schreiben View-Felder
// (activeLevelId) — das geht, weil `get()`/`set` über den Gesamt-RootState
// laufen. Die Slice tippt daher nur ihre eigenen Felder; `get()` liefert
// RootState (siehe appStore.ts), wir greifen punktuell auf View-Felder zu.

import { diffToOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { withVertexType, type PolylineVertexType } from "../core";
import { sampleProject } from "../model/sampleProject";
import {
  flattenCategories,
  recomputeFloorElevations,
} from "../model/types";
import type {
  BuiltinPaletteBank,
  ColorPen,
  Component,
  Drawing2D,
  DrawingLevel,
  HatchStyle,
  LayerCategory,
  LineStyle,
  PenSet,
  Project,
  Vec2,
} from "../model/types";
import {
  activePenSet,
  rebakePenColors,
  seedStandardPenSet as buildStandardPenSet,
  PEN_FALLBACK_COLOR,
  PEN_FALLBACK_WEIGHT,
} from "../model/penSets";
import { lineIntersect } from "../model/geometry";
import { commitTransform } from "../tools/transform";
import type { CopyMode, TransformOp, TransformSelection } from "../tools/transform";
import { uniqueId } from "../tools/types";
import { centroid as roomCentroid } from "../core";
import { bulgeArc, bulgeBetweenAngles, bulgeFromSagittaPoint, bulgePointAt, pointOnCircle } from "../core";
import {
  DEFAULT_SCALE_DENOMINATOR,
  DIM_DEFAULTS_MM,
  dimTextOffsetFromPoint,
  dimTextPos,
  mmToModel,
  modelToMm,
} from "../model/dimension";
import { textFrameCorners } from "../text/textFrame";
import { DEFAULT_PRESETS, type TextStylePreset } from "../text/richText";
import { t } from "../i18n";
import type { StoreApi } from "./store";
import { createHistorySlice, historyPatch, storeDocument } from "./historySlice";
import type { HistorySlice } from "./historySlice";
import type { NotifyKind } from "./notifySlice";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface ProjectSlice {
  project: Project;

  // ── Projekt direkt setzen (für Werkzeuge/Transformationen aus App) ────────
  /**
   * Ersetzt das Projekt (Teil-/Updater wie React-setState). `coalesceKey`:
   * NUR für bekannte Hochfrequenz-Aktionen (Griff-Ziehen, Inline-Text-Tippen)
   * — verschmilzt aufeinanderfolgende Aufrufe mit demselben Key innerhalb
   * `COALESCE_WINDOW_MS` zu EINEM Undo-Schritt, s. Kommentar bei der
   * Implementierung unten.
   */
  setProject: (next: Project | ((p: Project) => Project), coalesceKey?: string) => void;
  /** Die zuletzt angewendeten Ops (JSON-serialisierbar), jüngste zuletzt. */
  recentOps: () => CoreOp[][];

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
  patchTextStyle: (id: string, patch: Partial<TextStylePreset>) => void;
  addTextStyle: () => void;
  deleteTextStyle: (id: string) => void;

  // ── Stiftsätze (ArchiCAD-Stiftsatz-Muster, s. model/penSets.ts) ───────────
  /** Neuer Stift-Platzhalter (Name, keine Farbe) — landet in JEDEM bestehenden Stiftsatz. */
  addPen: () => void;
  renamePen: (id: string, name: string) => void;
  /** Entfernt den Stift-Platzhalter + seinen Eintrag in allen Stiftsätzen; löst betroffene `xxxPenId`-Verweise (Farbe bleibt der letzte gebackene Wert). */
  deletePen: (id: string) => void;
  /** Neuer Stiftsatz — übernimmt die Farben des aktiven Satzes (falls vorhanden), sonst den Fallback; wird aktiv, wenn es der erste Satz ist. */
  addPenSet: () => void;
  renamePenSet: (id: string, name: string) => void;
  /** Blockiert (mit Hinweis), wenn `id` der aktive Satz ist — zuerst einen anderen aktivieren. */
  deletePenSet: (id: string) => void;
  /** Setzt den aktiven Stiftsatz und bäckt sofort alle Stift-gekoppelten Farben neu. */
  setActivePenSet: (id: string) => void;
  /** Ändert die Farbe EINES Stifts in EINEM Stiftsatz; bäckt neu, wenn dieser Satz aktiv ist. */
  patchPenSetColor: (setId: string, penId: string, color: string) => void;
  patchPenSetWeight: (setId: string, penId: string, weight: number) => void;
  /** Ersetzt `pens`/legt einen neuen Satz mit der 255er-CAD-Standardpalette an (s. `model/penSets.ts`). */
  seedStandardPenSet: () => void;

  // ── Benutzerdefinierte Farbpaletten (s. model/types.ts::CustomPalette) ────
  addCustomPalette: () => void;
  renameCustomPalette: (id: string, name: string) => void;
  deleteCustomPalette: (id: string) => void;
  /**
   * Fügt `hex` VORNE in die Palette ein (zuletzt gespeicherte Farbe zuerst
   * sichtbar) — dedupliziert case-insensitive (erneutes Speichern verschiebt
   * die Farbe nur nach vorn, statt sie zu duplizieren). `paletteId`
   * unbekannt/undefined ⇒ legt automatisch eine neue Palette an (Farbmischer
   * kann so "+" drücken, ohne dass vorher zwingend eine Palette existiert).
   */
  addColorToCustomPalette: (paletteId: string | undefined, hex: string) => void;
  removeColorFromCustomPalette: (paletteId: string, hex: string) => void;
  /** Blendet EINE eigene Palette im Farbwahl-Popover ein/aus (Daten bleiben erhalten). */
  setCustomPaletteVisible: (id: string, visible: boolean) => void;
  /** Blendet EINE mitgelieferte Bank (Einfach/Tango/Material/RAL) im Popover ein/aus. */
  setBuiltinPaletteVisible: (bank: BuiltinPaletteBank, visible: boolean) => void;

  // ── Polylinien-Stützpunkte (Kontextmenü im Grundriss) ────────────────────
  /**
   * Fügt einen Stützpunkt in das Segment `segIndex` (= zwischen `pts[segIndex]`
   * und dem Folgepunkt; bei geschlossener Polylinie ist das letzte Segment der
   * Schluss zurück zu `pts[0]`) ein. Bei GERADEM Segment landet der Punkt auf
   * `pt` (i. d. R. der auf die Sehne projizierte Klickpunkt), bei einem
   * BOGEN-Segment stattdessen exakt auf dem Bogenmittelpunkt — und der Bogen
   * wird in zwei Teilbögen mit passenden Bulge-Werten zerlegt, sonst würde der
   * Bogen beim Einfügen still zu zwei Geraden zusammenfallen.
   */
  insertDrawingPoint: (drawingId: string, segIndex: number, pt: Vec2) => void;
  /**
   * Entfernt den Stützpunkt `index` (samt zugehörigem Bulge-Eintrag).
   * Blockiert (mit Hinweis), wenn zu wenige Punkte übrig blieben: offene
   * Polylinie braucht ≥2, geschlossene ≥3.
   */
  deleteDrawingPoint: (drawingId: string, index: number) => void;
  /**
   * Punkttyp eines Polylinien-Stützpunkts setzen (Eckpunkt/Bogenpunkt/Splinepunkt),
   * s. `geometry/polylineVertexType.ts` — rechnet nur die Bulges der beiden
   * anliegenden Segmente um.
   */
  setPolylineVertexType: (drawingId: string, index: number, type: PolylineVertexType) => void;

  // ── Editier-Griffe + Body-Move des selektierten Elements ──────────────────
  moveGripOf: (
    drawingId: string | null,
    wallId: string | null,
    index: number,
    pt: Vec2,
    /** Papier-Massstab (1:N), nur für den Masszahl-Griff der Bemassung. */
    scaleDenominator?: number,
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
   * Sortiert die gewählten Zeichnungsebenen in `drawingLevels` um — dieselbe
   * "front"/"back"/"forward"/"backward"-Semantik wie `reorderDrawings`, nur
   * für Geschosse/Schnitte/Ansichten/2D-Zeichnungen statt Drawing2D-Elemente.
   * Die Array-Reihenfolge bestimmt die Überlagerungs-Reihenfolge bei mehreren
   * gleichzeitig sichtbaren Ebenen (s. generatePlan.ts::generateVisibleLevelsPlan,
   * viewportContent.tsx::overlaySectionLevels) — Nutzer-Wunsch "Ansichten in
   * den Hintergrund legen können". Panel-Liste zeigt die REVERSE Array-
   * Reihenfolge (oben = zuletzt im Array = vorne/obenauf), s. DrawingLevelsPanel.
   */
  reorderDrawingLevels: (
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
  /**
   * Generischer immutabler Patch auf eine Wand (per ID). `coalesceKey`
   * optional (Default: kein Coalescing, jeder Aufruf ein eigener Undo-
   * Schritt — Panel-Feld-Edits) — der 3D-Höhen-Griff (`App.tsx::
   * onEdit3dWallTop`) übergibt einen festen Schlüssel je Wand, damit EIN
   * Drag (viele Maus-Move-Schritte) EINEN Undo-Schritt erzeugt statt vieler.
   */
  updateWall: (
    id: string,
    patch: Partial<import("../model/types").Wall>,
    coalesceKey?: string,
  ) => void;
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

  /**
   * Immutable Änderung eines Dachs (Form/Neigung/Überstand/Firstrichtung/
   * Dicke). `coalesceKey` optional — s. `updateWall`-Doc (derselbe Zweck,
   * hier vom 3D-First-Griff `App.tsx::onEdit3dRoofPitch` genutzt).
   */
  updateRoof: (
    id: string,
    patch: Partial<import("../model/types").Roof>,
    coalesceKey?: string,
  ) => void;
  /** Dach-Eckgriff (3D): Umriss-Ecke `index` auf `pt`, Gegenecke fix (Rechteck). */
  moveRoofGrip: (roofId: string, index: number, pt: import("../model/types").Vec2) => void;
  /** Dach als Ganzes um `delta` verschieben (Verschiebe-Griff). */
  moveRoofBy: (roofId: string, delta: import("../model/types").Vec2) => void;

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
 * Änderung einen Undo-Schritt im Kern-Dokument auf.
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

  // Koaleszenz von Drag-Serien (Griff ziehen, Element verschieben, Kante ziehen, …): diese
  // Aktionen rufen `setProject` bei JEDEM Maus-Move-Schritt mit einem `coalesceKey` auf (kein
  // Draft/Commit-Muster wie bei den Zeichenwerkzeugen, deren Vorschau über lokalen `draft`-State
  // in App.tsx läuft). Gleicher Schlüssel innerhalb des Zeitfensters = EIN Undo-Schritt; die
  // Buchführung (Schlüssel, Zeitfenster, Rücksetzen nach Undo/Redo) liegt im Kern (`ops.rs`).
  // Protokoll der angewendeten Ops (jüngste zuletzt) — Rohstoff für Undo-Verlauf [84], Makros [85].
  const opLog: CoreOp[][] = [];
  const OP_LOG_LIMIT = 200;

  const history = createHistorySlice(api as unknown as StoreApi<HistorySlice & { project: Project }>);

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
      const wanted =
        typeof next === "function" ? (next as (p: Project) => Project)(s.project) : next;
      // No-Op-Schutz: echte Immutable-Updates liefern bei tatsächlicher
      // Änderung immer eine NEUE Referenz — bleibt sie gleich, gab es keine
      // Änderung, also kein History-Eintrag (und `set` selbst benachrichtigt
      // dann ebenfalls nicht, da der Patch leer ist).
      if (wanted === s.project) return {};
      // Das Projekt ändert sich NUR über Ops (core/ops.ts): die gewünschte Änderung wird in
      // eine Op-Folge übersetzt; der Kern prüft (NaN, doppelte ids), wendet an und zeichnet den
      // Undo-Schritt auf. Verstösse werden zurückgerollt und gemeldet.
      const ops = diffToOps(s.project, wanted);
      if (ops.length === 0) return {};
      const doc = storeDocument(s.project);
      const res = doc.commit(s.project, ops, coalesceKey, Date.now());
      if ("problems" in res) {
        const problems = res.problems;
        console.warn("Projektänderung verworfen:", problems);
        queueMicrotask(() => get().notify(`${t("project.change.rejected")} ${problems[0]}`, "error"));
        return {};
      }
      opLog.push(ops);
      if (opLog.length > OP_LOG_LIMIT) opLog.shift();
      return { project: res.project, ...historyPatch(doc) };
    });

  return {
    ...history,

    // Store-Default beim Modul-Laden — sichtbar nur ganz kurz HINTER dem
    // Splash/Startbildschirm (App.tsx bootPhase: splash → start → editor),
    // bevor eine der drei Optionen (Neu/Öffnen/Zuletzt) das echte Projekt
    // setzt. Der konkrete Wert spielt daher praktisch keine Rolle mehr.
    project: sampleProject,

    setProject,
    recentOps: () => opLog.slice(),

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
        const usedByOpening = (p.openings ?? []).some((o) =>
          codes.has(o.categoryCode),
        );
        if (usedByWall || usedByOpening) {
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

    patchTextStyle: (id, patch) =>
      setProject((p) => ({
        ...p,
        textStyles: (p.textStyles ?? DEFAULT_PRESETS).map((s) =>
          s.id === id ? { ...s, ...patch, marks: { ...s.marks, ...patch.marks } } : s,
        ),
      })),

    addTextStyle: () =>
      setProject((p) => {
        const style: TextStylePreset = {
          id: `ts-${Date.now()}`,
          label: t("default.textStyleName"),
          marks: { sizePt: 10 },
        };
        return { ...p, textStyles: [...(p.textStyles ?? DEFAULT_PRESETS), style] };
      }),

    deleteTextStyle: (id) =>
      setProject((p) => ({
        ...p,
        textStyles: (p.textStyles ?? DEFAULT_PRESETS).filter((s) => s.id !== id),
      })),

    importHatches: (hatches) =>
      setProject((p) => ({
        ...p,
        hatches: [
          ...p.hatches,
          ...hatches.map((h, i) => ({ ...h, id: `ht-${Date.now()}-${i}` })),
        ],
      })),

    // ── Stiftsätze ─────────────────────────────────────────────────────────
    addPen: () =>
      setProject((p) => {
        const pen: ColorPen = { id: `pen-${Date.now()}`, name: t("default.penName") };
        return {
          ...p,
          pens: [...(p.pens ?? []), pen],
          // Neuer Stift bekommt in JEDEM bestehenden Stiftsatz sofort einen
          // Eintrag (Fallback-Grauton+Stärke) — Stiftsätze bleiben dadurch
          // immer deckungsgleich zur `pens`-Liste, keine "fehlt in Satz X"-Lücken.
          penSets: p.penSets?.map((s) => ({
            ...s,
            pens: { ...s.pens, [pen.id]: { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT } },
          })),
        };
      }),

    renamePen: (id, name) =>
      setProject((p) => ({
        ...p,
        pens: p.pens?.map((pen) => (pen.id === id ? { ...pen, name } : pen)),
      })),

    deletePen: (id) =>
      setProject((p) => {
        const clearPenRefs = <T extends { colorPenId?: string; foregroundPenId?: string; backgroundPenId?: string }>(x: T): T =>
          x.colorPenId === id || x.foregroundPenId === id || x.backgroundPenId === id
            ? {
                ...x,
                colorPenId: x.colorPenId === id ? undefined : x.colorPenId,
                foregroundPenId: x.foregroundPenId === id ? undefined : x.foregroundPenId,
                backgroundPenId: x.backgroundPenId === id ? undefined : x.backgroundPenId,
              }
            : x;
        const clearCategoryPenRefs = (cat: LayerCategory): LayerCategory => ({
          ...(cat.colorPenId === id ? { ...cat, colorPenId: undefined } : cat),
          ...(cat.children ? { children: cat.children.map(clearCategoryPenRefs) } : {}),
        });
        return {
          ...p,
          pens: p.pens?.filter((pen) => pen.id !== id),
          penSets: p.penSets?.map((s) => {
            const { [id]: _removed, ...rest } = s.pens;
            return { ...s, pens: rest };
          }),
          components: p.components.map(clearPenRefs),
          layers: p.layers.map(clearCategoryPenRefs),
        };
      }),

    addPenSet: () =>
      setProject((p) => {
        const current = activePenSet(p);
        const penSet: PenSet = {
          id: `penset-${Date.now()}`,
          name: t("default.penSetName"),
          pens: current
            ? { ...current.pens }
            : Object.fromEntries(
                (p.pens ?? []).map((pen) => [pen.id, { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT }]),
              ),
        };
        const penSets = [...(p.penSets ?? []), penSet];
        // Erster Stiftsatz überhaupt: automatisch aktivieren (sonst löst jeder
        // Stift-Verweis bis zur ersten manuellen Aktivierung auf den Fallback auf).
        return {
          ...p,
          penSets,
          activePenSetId: p.activePenSetId ?? penSet.id,
        };
      }),

    renamePenSet: (id, name) =>
      setProject((p) => ({
        ...p,
        penSets: p.penSets?.map((s) => (s.id === id ? { ...s, name } : s)),
      })),

    deletePenSet: (id) =>
      setProject((p) => {
        if (p.activePenSetId === id) {
          const name = p.penSets?.find((s) => s.id === id)?.name ?? id;
          get().notify(t("alert.penSetIsActive", { name }), "warning");
          return p;
        }
        return { ...p, penSets: p.penSets?.filter((s) => s.id !== id) };
      }),

    setActivePenSet: (id) =>
      setProject((p) => rebakePenColors({ ...p, activePenSetId: id })),

    patchPenSetColor: (setId, penId, color) =>
      setProject((p) => {
        const next = {
          ...p,
          penSets: p.penSets?.map((s) =>
            s.id === setId
              ? {
                  ...s,
                  pens: {
                    ...s.pens,
                    [penId]: { ...(s.pens[penId] ?? { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT }), color },
                  },
                }
              : s,
          ),
        };
        return setId === p.activePenSetId ? rebakePenColors(next) : next;
      }),

    patchPenSetWeight: (setId, penId, weight) =>
      setProject((p) => {
        const next = {
          ...p,
          penSets: p.penSets?.map((s) =>
            s.id === setId
              ? {
                  ...s,
                  pens: {
                    ...s.pens,
                    [penId]: { ...(s.pens[penId] ?? { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT }), weight },
                  },
                }
              : s,
          ),
        };
        return setId === p.activePenSetId ? rebakePenColors(next) : next;
      }),

    seedStandardPenSet: () => setProject((p) => buildStandardPenSet(p)),

    addCustomPalette: () =>
      setProject((p) => ({
        ...p,
        customPalettes: [
          ...(p.customPalettes ?? []),
          { id: `palette-${Date.now()}`, name: t("default.customPaletteName"), colors: [] },
        ],
      })),

    renameCustomPalette: (id, name) =>
      setProject((p) => ({
        ...p,
        customPalettes: p.customPalettes?.map((c) => (c.id === id ? { ...c, name } : c)),
      })),

    deleteCustomPalette: (id) =>
      setProject((p) => ({
        ...p,
        customPalettes: p.customPalettes?.filter((c) => c.id !== id),
      })),

    addColorToCustomPalette: (paletteId, hex) =>
      setProject((p) => {
        const palettes = p.customPalettes ?? [];
        const target = palettes.find((c) => c.id === paletteId);
        if (!target) {
          const created = { id: `palette-${Date.now()}`, name: t("default.customPaletteName"), colors: [hex] };
          return { ...p, customPalettes: [...palettes, created] };
        }
        const withoutDupe = target.colors.filter((c) => c.toLowerCase() !== hex.toLowerCase());
        const updated = { ...target, colors: [hex, ...withoutDupe] };
        return { ...p, customPalettes: palettes.map((c) => (c.id === target.id ? updated : c)) };
      }),

    removeColorFromCustomPalette: (paletteId, hex) =>
      setProject((p) => ({
        ...p,
        customPalettes: p.customPalettes?.map((c) =>
          c.id === paletteId ? { ...c, colors: c.colors.filter((h) => h.toLowerCase() !== hex.toLowerCase()) } : c,
        ),
      })),

    setCustomPaletteVisible: (id, visible) =>
      setProject((p) => ({
        ...p,
        customPalettes: p.customPalettes?.map((c) => (c.id === id ? { ...c, visible } : c)),
      })),

    setBuiltinPaletteVisible: (bank, visible) =>
      setProject((p) => ({
        ...p,
        builtinPaletteBanks: { ...p.builtinPaletteBanks, [bank]: visible },
      })),

    insertDrawingPoint: (drawingId, segIndex, pt) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) => {
          if (d.id !== drawingId || d.geom.shape !== "polyline") return d;
          const g = d.geom;
          const n = g.pts.length;
          const last = segIndex === n - 1;
          if (segIndex < 0 || segIndex >= n || (last && !g.closed)) return d;
          const a = g.pts[segIndex];
          const b = last ? g.pts[0] : g.pts[segIndex + 1];
          // Bogen: exakt über die Kreisgeometrie in der Winkel-Mitte teilen —
          // dieselbe Technik, mit der kernel2d Bogen-Segmente zuschneidet
          // (`bulgeBetweenAngles`). Eine Näherung über tessellierte Punkte
          // (`bulgePointAt`) wäre hier zu ungenau, weil sie auf Stützstellen
          // rundet und der Sagitta-Rückschluss den Fehler verstärkt.
          const arc = bulgeArc(a, b, g.bulge?.[segIndex] ?? 0);
          const aMid = arc ? arc.a0 + arc.sweep / 2 : 0;
          const insertPt = arc ? pointOnCircle(arc.center, arc.r, aMid) : pt;
          const sweepSign: 1 | -1 = arc && arc.sweep < 0 ? -1 : 1;
          const b1 = arc ? bulgeBetweenAngles(arc.center, arc.r, arc.a0, aMid, sweepSign) : 0;
          const b2 = arc ? bulgeBetweenAngles(arc.center, arc.r, aMid, arc.a1, sweepSign) : 0;
          const pts = [...g.pts.slice(0, segIndex + 1), insertPt, ...g.pts.slice(segIndex + 1)];
          // Bulge-Array nur mitführen, wenn es eines gab (additiv bleiben).
          const nextBulge = g.bulge
            ? [...g.bulge.slice(0, segIndex), b1, b2, ...g.bulge.slice(segIndex + 1)]
            : undefined;
          return { ...d, geom: { ...g, pts, ...(nextBulge ? { bulge: nextBulge } : {}) } };
        }),
      })),

    setPolylineVertexType: (drawingId, index, type) =>
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) => {
          if (d.id !== drawingId || d.geom.shape !== "polyline" || d.locked) return d;
          const g = d.geom;
          const bulge = withVertexType(g, index, type);
          const { bulge: _old, ...rest } = g;
          return { ...d, geom: bulge.some((b) => b !== 0) ? { ...rest, bulge } : rest };
        }),
      })),

    deleteDrawingPoint: (drawingId, index) =>
      setProject((p) => {
        const d = p.drawings2d.find((x) => x.id === drawingId);
        if (!d || d.geom.shape !== "polyline") return p;
        const g = d.geom;
        const min = g.closed ? 4 : 3;
        if (g.pts.length < min) {
          get().notify(t("alert.polylineMinPoints"), "warning");
          return p;
        }
        if (index < 0 || index >= g.pts.length) return p;
        const pts = g.pts.filter((_, i) => i !== index);
        // Zwei Segmente werden zu einem: der Bulge des ENTFERNTEN Segments
        // fällt weg, das verbleibende behält seinen Wert (die exakte
        // Bogenform lässt sich nicht erhalten, wenn ihr Stützpunkt entfällt).
        const bulge = g.bulge ? g.bulge.filter((_, i) => i !== index) : undefined;
        return {
          ...p,
          drawings2d: p.drawings2d.map((x) =>
            x.id === drawingId
              ? { ...x, geom: { ...g, pts, ...(bulge ? { bulge } : {}) } }
              : x,
          ),
        };
      }),

    // ── Editier-Griffe ─────────────────────────────────────────────────────
    // Diese Aktionen laufen AD-HOC bei jedem Maus-Move-Schritt eines Drags
    // (kein Draft/Commit-Muster wie bei den Zeichenwerkzeugen) — daher mit
    // coalesceKey, damit EIN Drag EINEN Undo-Schritt erzeugt statt vieler.
    moveGripOf: (drawingId, wallId, index, pt, scaleDenominator) =>
      setProject(
        (p) => moveGrip(p, drawingId, wallId, index, pt, scaleDenominator),
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

    reorderDrawingLevels: (ids, op) =>
      setProject((p) => ({
        ...p,
        drawingLevels: reorderDrawingLevelsArr(p.drawingLevels, ids, op),
      })),

    // ── Größe (Resize um Anker) ────────────────────────────────────────────
    resizeElement: (kind, id, w, h, anchor) =>
      setProject((p) => resizeElement(p, kind, id, w, h, anchor)),

    // ── Transformation ─────────────────────────────────────────────────────
    commitTransformOn: (sel, op, points, copyMode, count) =>
      setProject((p) => commitTransform(p, sel, op, points, copyMode, count)),

    // ── Wand-Attribute ─────────────────────────────────────────────────────
    updateWall: (id, patch, coalesceKey) =>
      setProject(
        (p) => ({
          ...p,
          walls: p.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
        }),
        coalesceKey,
      ),

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
          outline: movePolygonEdge(c.outline, aIndex, bIndex, delta, true),
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
    updateRoof: (id, patch, coalesceKey) =>
      setProject(
        (p) => ({
          ...p,
          roofs: (p.roofs ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
        }),
        coalesceKey,
      ),

    // Dach-Eckgriff (3D): der gezogene Umriss-Eckpunkt `index` wandert auf `pt`;
    // die GEGENÜBERLIEGENDE Ecke bleibt fix → der Umriss bleibt ein achsparalleles
    // Rechteck (die Dach-Geometrie rechnet ohnehin auf der Bounding-Box).
    moveRoofGrip: (roofId, index, pt) =>
      setProject(
        (p) => ({
          ...p,
          roofs: (p.roofs ?? []).map((r) => {
            if (r.id !== roofId || r.outline.length < 4) return r;
            const opp = r.outline[(index + 2) % r.outline.length];
            const x0 = Math.min(pt.x, opp.x);
            const x1 = Math.max(pt.x, opp.x);
            const y0 = Math.min(pt.y, opp.y);
            const y1 = Math.max(pt.y, opp.y);
            return {
              ...r,
              outline: [
                { x: x0, y: y0 },
                { x: x1, y: y0 },
                { x: x1, y: y1 },
                { x: x0, y: y1 },
              ],
            };
          }),
        }),
        `moveRoofGrip:${roofId}`,
      ),

    // Dach als Ganzes verschieben (Verschiebe-Griff).
    moveRoofBy: (roofId, delta) =>
      setProject(
        (p) => ({
          ...p,
          roofs: (p.roofs ?? []).map((r) =>
            r.id === roofId
              ? { ...r, outline: r.outline.map((v) => ({ x: v.x + delta.x, y: v.y + delta.y })) }
              : r,
          ),
        }),
        `moveRoofBy:${roofId}`,
      ),

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
            boundary: movePolygonEdge(r.boundary, aIndex, bIndex, delta, true),
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

/**
 * Wie `reorderDrawings2D`, nur für `DrawingLevel[]` (Zeichnungsebenen statt
 * Drawing2D-Elemente) — identische "front"/"back"/"forward"/"backward"-Logik,
 * bewusst dupliziert statt genericisiert (zwei kleine, unabhängige Domänen).
 */
function reorderDrawingLevelsArr(
  levels: DrawingLevel[],
  ids: string[],
  op: "front" | "back" | "forward" | "backward",
): DrawingLevel[] {
  const selected = new Set(ids.filter((id) => levels.some((l) => l.id === id)));
  if (selected.size === 0) return levels;

  if (op === "front" || op === "back") {
    const picked = levels.filter((l) => selected.has(l.id));
    const rest = levels.filter((l) => !selected.has(l.id));
    return op === "front" ? [...rest, ...picked] : [...picked, ...rest];
  }

  const arr = levels.slice();
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
    case "line":
    case "xline":
    case "ray": {
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
    case "ellipse": {
      // bbox: rotation=0 angenommen (das Werkzeug erzeugt nur achsparallele
      // Ellipsen); rx/ry unabhängig skaliert, Mittelpunkt um den Anker verschoben.
      const box = {
        minX: g.center.x - g.rx,
        minY: g.center.y - g.ry,
        maxX: g.center.x + g.rx,
        maxY: g.center.y + g.ry,
      };
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      const center: Vec2 = {
        x: ax + (g.center.x - ax) * sx,
        y: ay + (g.center.y - ay) * sy,
      };
      return { ...g, center, rx: Math.max(1e-3, g.rx * sx), ry: Math.max(1e-3, g.ry * sy) };
    }
    case "bezier":
    case "spline": {
      const { ax, ay, sx, sy } = scaleAround(bbox2(g.pts), w, h, anchor);
      const f = (p: Vec2): Vec2 => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy });
      return { ...g, pts: g.pts.map(f) };
    }
    case "text": {
      // Text: nur die Einfügeposition um den Anker schieben (Höhe bleibt).
      const box = { minX: g.at.x, minY: g.at.y, maxX: g.at.x, maxY: g.at.y };
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      return { ...g, at: { x: ax + (g.at.x - ax) * sx, y: ay + (g.at.y - ay) * sy } };
    }
    case "block": {
      // Wie Text: nur der Einfügepunkt wandert (kein Skalierungsfaktor am
      // Symbol selbst in v1).
      const box = { minX: g.at.x, minY: g.at.y, maxX: g.at.x, maxY: g.at.y };
      const { ax, ay, sx, sy } = scaleAround(box, w, h, anchor);
      return { ...g, at: { x: ax + (g.at.x - ax) * sx, y: ay + (g.at.y - ay) * sy } };
    }
    case "image": {
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
    default:
      return g;
  }
}

/**
 * Kreis, solange rx≈ry (relative Toleranz 0.5%) — sonst Ellipse (rotation 0).
 * Trägt den Kreis-zu-Ellipse-Formwandel beim Griff-Ziehen (Nutzer-Wunsch:
 * „Kreis wird wie bisher erstellt, kann beim Bearbeiten zur Ellipse werden");
 * symmetrisch nutzbar auch für die Rückrichtung (Ellipse → Kreis, wenn man
 * die Halbachsen wieder aneinander annähert).
 */
function ellipseOrCircle(
  center: Vec2,
  rx: number,
  ry: number,
): import("../model/types").Drawing2DGeom {
  if (Math.abs(rx - ry) <= 0.005 * Math.max(rx, ry)) {
    return { shape: "circle", center, r: (rx + ry) / 2 };
  }
  return { shape: "ellipse", center, rx, ry, rotation: 0 };
}

// ── Editier-Griffe (verschoben aus App.tsx, 1:1) ─────────────────────────────

/**
 * Editier-Griffe (Eckpunkte) eines 2D-Zeichenelements in Modell-Metern.
 * line/polyline/rect: Eckpunkte. circle: EIN Radius-Griff (Ost, Index 0).
 * arc: Start-/End-Winkel-Griff (Index 0/1, ändern a0/a1) + ein Radius-Griff
 * auf halbem Bogen (Index 2, ändert r) — siehe {@link moveGrip}.
 */
export function drawingVertices(
  d: import("../model/types").Drawing2D,
  /** Papier-Massstab (1:N) — nur für die Bemassungs-Griffe, deren Lage von
   *  der in Papier-mm angegebenen Schrifthöhe abhängt. */
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
): Vec2[] {
  const g = d.geom;
  if (g.shape === "line" || g.shape === "xline" || g.shape === "ray") return [g.a, g.b];
  // Polylinie: Eckpunkt-Griffe (Index 0..n-1) PLUS ein Bulge-Griff je Segment
  // (Index n..; Apex des aktuellen Bogens, oder Sehnen-Mitte bei bulge=0) —
  // senkrecht zur Sehne ziehen krümmt genau dieses Segment (s. moveGrip).
  if (g.shape === "polyline") {
    const n = g.pts.length;
    const closeSeg = g.closed && n > 2;
    const segCount = Math.max(0, n - 1) + (closeSeg ? 1 : 0);
    const bulgeGrips: Vec2[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = g.pts[i];
      const b = i === n - 1 ? g.pts[0] : g.pts[i + 1];
      bulgeGrips.push(bulgePointAt(a, b, g.bulge?.[i] ?? 0, 0.5));
    }
    return [...g.pts, ...bulgeGrips];
  }
  if (g.shape === "rect" || g.shape === "image") {
    return [
      g.min,
      { x: g.max.x, y: g.min.y },
      g.max,
      { x: g.min.x, y: g.max.y },
    ];
  }
  // Kreis: zwei Griffe (Ost/Nord, wie bei der Ellipse) — zieht man EINEN der
  // beiden unabhängig, wird der Kreis zur Ellipse (s. `moveGrip`). So bleibt
  // ein Kreis ein Kreis, solange man ihn nicht gezielt verzerrt (Nutzer-
  // Wunsch: „Kreis erstellen wie bisher, beim Bearbeiten kann er zur Ellipse
  // werden").
  if (g.shape === "circle") {
    return [
      { x: g.center.x + g.r, y: g.center.y },
      { x: g.center.x, y: g.center.y + g.r },
    ];
  }
  if (g.shape === "arc") {
    const mid = (g.a0 + g.a1) / 2;
    return [
      { x: g.center.x + g.r * Math.cos(g.a0), y: g.center.y + g.r * Math.sin(g.a0) },
      { x: g.center.x + g.r * Math.cos(g.a1), y: g.center.y + g.r * Math.sin(g.a1) },
      { x: g.center.x + g.r * Math.cos(mid), y: g.center.y + g.r * Math.sin(mid) },
    ];
  }
  // Ellipse: zwei Griffe (Index 0 = rx-Achse, Index 1 = ry-Achse), gedreht um
  // `rotation` (0 beim heutigen Werkzeug) — siehe `moveGrip`.
  if (g.shape === "ellipse") {
    const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
    return [
      { x: g.center.x + g.rx * c, y: g.center.y + g.rx * s },
      { x: g.center.x - g.ry * s, y: g.center.y + g.ry * c },
    ];
  }
  // Bezier/Spline: alle Kontroll-/Wegpunkte als Griffe (wie polyline).
  if (g.shape === "bezier" || g.shape === "spline") return [...g.pts];
  // Bemassung: Griff 0..N-1 = jeder Punkt der Kette (wie polyline); EIN
  // zusätzlicher Griff (Index N) sitzt AUF der Masslinie (Mitte der Kette) —
  // ihn zu ziehen ändert nur `offset`, nicht die Punkte (s. moveGrip).
  if (g.shape === "dimension") {
    const a = g.pts[0], b = g.pts[g.pts.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * g.offset, ny = (dx / len) * g.offset;
    const mid: Vec2 = { x: (a.x + b.x) / 2 + nx, y: (a.y + b.y) / 2 + ny };
    // Reihenfolge: Kettenpunkte · Offset-Griff · JE SEGMENT ein Masszahl-Griff
    // (verschiebt nur die Zahl, s. moveGrip) — dieselbe Ordnung erwartet
    // moveGrip beim Auflösen des Index.
    const heightM = mmToModel(g.textHeightMm ?? DIM_DEFAULTS_MM.textHeight, scaleDenominator);
    const textGrips = g.pts.slice(0, -1).map((p0, i) => {
      const off = g.textOffsetsMm?.[i];
      return dimTextPos(
        p0,
        g.pts[i + 1],
        g.offset,
        heightM,
        off
          ? { along: mmToModel(off.along, scaleDenominator), perp: mmToModel(off.perp, scaleDenominator) }
          : undefined,
      );
    });
    return [...g.pts, mid, ...textGrips];
  }
  // Kote: EIN Griff an der Dreieck-Spitze (zum Verschieben; siehe moveGrip).
  if (g.shape === "kote") return [g.at];
  // Detail-/Schnitt-Verweis: EIN Griff am Kreis-Zentrum (zum Verschieben).
  if (g.shape === "detailref") return [g.at];
  // Massstabsbalken: EIN Griff an der linken unteren Ecke (zum Verschieben).
  if (g.shape === "scalebar") return [g.at];
  // Punkt-/Knotenmarker: EIN Griff am Zentrum (zum Verschieben).
  if (g.shape === "pointmarker") return [g.at];
  // Text: Griff 0 am Ankerpunkt; trägt der Text einen Leader, zusätzlich ein
  // Griff je Knickpunkt (`leaderBendPoints`, falls gesetzt) und ein
  // ABSCHLIESSENDER Griff an der Spitze (Pfeilspitze unabhängig verschiebbar;
  // s. moveGrip) — Reihenfolge Anker→Knicke→Spitze, wie der Pfad gerendert wird.
  // Text-entlang-Pfad: die Pfadpunkte SELBST sind die Griffe (wie polyline),
  // ersetzt das Anker/Leader-Griffmodell komplett (schliessen sich aus).
  // Textspalte (`width` gesetzt, kein Leader/Pfad): VIER Rahmen-Eckpunkte als
  // Griffe (Nutzer-Wunsch: "nicht nur ein Griff unten links bei der ersten
  // Glyphe") — Ziehen ändert NUR die Spaltenbreite (InDesign-Verhalten,
  // Nutzer-Entscheidung), s. `moveGrip`. Dieselbe Rahmen-Berechnung wie der
  // Auswahl-Rahmen im Grundriss (`text/textFrame.ts`), damit Griffe und
  // sichtbarer Rahmen immer übereinstimmen.
  if (g.shape === "text") {
    if (g.pathPts) return [...g.pathPts];
    if (g.leaderTarget) return [g.at, ...(g.leaderBendPoints ?? []), g.leaderTarget];
    if (g.width && g.width > 0) {
      return textFrameCorners({
        at: g.at,
        text: g.text,
        heightM: g.height,
        angle: g.angle,
        marks: g.marks,
        doc: g.doc,
        wrapWidth: g.width,
      });
    }
    return [g.at];
  }
  // Block-Instanz: EIN Griff am Einfügepunkt (Rotation läuft über move/mirror,
  // kein eigener Rotations-Griff in v1; s. moveGrip).
  if (g.shape === "block") return [g.at];
  return [];
}

/**
 * Fügt ein Bild-Zeichenelement (eingebettete Data-URL, z. B. Foto/Logo oder
 * gerasterte PDF-Seite) achsparallel bei `[at .. at+size]` an — analog zu den
 * Zeichenwerkzeugen, aber ohne Command (Datei-Auswahl ist async, s. App.tsx
 * Bild-/PDF-Import). Direkt selektiert zurückgegeben, damit Griffe/Objekt-Info
 * sofort zum Verschieben/Skalieren bereitstehen.
 */
export function addImageDrawing2d(
  project: Project,
  levelId: string,
  categoryCode: string,
  src: string,
  at: Vec2,
  widthM: number,
  heightM: number,
): { project: Project; id: string } {
  const id = uniqueId("dr2d");
  const d: Drawing2D = {
    id,
    type: "drawing2d",
    levelId,
    categoryCode,
    geom: {
      shape: "image",
      min: at,
      max: { x: at.x + widthM, y: at.y + heightM },
      src,
    },
  };
  return { project: { ...project, drawings2d: [...project.drawings2d, d] }, id };
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
  /** Papier-Massstab (1:N) — nur für den Masszahl-Griff, s. `drawingVertices`. */
  scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR,
): Project {
  // Objekt-Sperre: gesperrte Elemente lassen sich anwählen, aber nicht
  // ziehen (s. Kommentar bei `onPlanSelect` in useMouseSelectionHandlers.ts).
  if (drawingId && project.drawings2d.find((d) => d.id === drawingId)?.locked) return project;
  if (wallId && project.walls.find((w) => w.id === wallId)?.locked) return project;
  if (drawingId) {
    return {
      ...project,
      drawings2d: project.drawings2d.map((d) => {
        if (d.id !== drawingId) return d;
        const g = d.geom;
        if (g.shape === "line" || g.shape === "xline" || g.shape === "ray") {
          return { ...d, geom: index === 0 ? { ...g, a: pt } : { ...g, b: pt } };
        }
        if (g.shape === "polyline") {
          const n = g.pts.length;
          if (index < n) {
            const pts = g.pts.map((p, i) => (i === index ? pt : p));
            return { ...d, geom: { ...g, pts } };
          }
          // Bulge-Griff (Index ≥ n): Segment-Mitte senkrecht zur Sehne gezogen
          // → neuer Bogen-Faktor für GENAU dieses Segment (s. drawingVertices).
          const segIndex = index - n;
          const a = g.pts[segIndex];
          const b = segIndex === n - 1 ? g.pts[0] : g.pts[segIndex + 1];
          const bulgeVal = bulgeFromSagittaPoint(a, b, pt);
          const bulge = [...(g.bulge ?? [])];
          while (bulge.length <= segIndex) bulge.push(0);
          bulge[segIndex] = bulgeVal;
          return { ...d, geom: { ...g, bulge } };
        }
        if (g.shape === "bezier" || g.shape === "spline") {
          const pts = g.pts.map((p, i) => (i === index ? pt : p));
          return { ...d, geom: { ...g, pts } };
        }
        // Bemassung: Griff 0..N-1 verschiebt den jeweiligen Kettenpunkt
        // (Masszahlen folgen automatisch, s. Rendering); der LETZTE Griff
        // (auf der Masslinie) ändert nur `offset` — Normalabstand von `pt`
        // zur (unveränderten) Punktreihe.
        if (g.shape === "dimension") {
          if (index < g.pts.length) {
            const pts = g.pts.map((p, i) => (i === index ? pt : p));
            return { ...d, geom: { ...g, pts } };
          }
          if (index === g.pts.length) {
            const a = g.pts[0], b = g.pts[g.pts.length - 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len;
            const offset = (pt.x - a.x) * nx + (pt.y - a.y) * ny;
            return { ...d, geom: { ...g, offset } };
          }
          // Masszahl-Griff: verschiebt NUR die Zahl des betroffenen Segments
          // (Geometrie bleibt unangetastet) und rastet nahe der Standardlage
          // ein, s. `model/dimension.ts::dimTextOffsetFromPoint`.
          const seg = index - g.pts.length - 1;
          if (seg < 0 || seg >= g.pts.length - 1) return d;
          const height = mmToModel(g.textHeightMm ?? DIM_DEFAULTS_MM.textHeight, scaleDenominator);
          const m = dimTextOffsetFromPoint(g.pts[seg], g.pts[seg + 1], g.offset, height, pt);
          // Zurück in Papier-mm speichern (Einheit des Modells).
          const next = {
            along: modelToMm(m.along, scaleDenominator),
            perp: modelToMm(m.perp, scaleDenominator),
          };
          const textOffsetsMm = Array.from({ length: g.pts.length - 1 }, (_, i) =>
            i === seg ? next : (g.textOffsetsMm?.[i] ?? { along: 0, perp: 0 }),
          );
          return { ...d, geom: { ...g, textOffsetsMm } };
        }
        if (g.shape === "rect" || g.shape === "image") {
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
        // Text: Griff 0 = Ankerpunkt; bei Leader zusätzlich ein Griff je
        // Knickpunkt UND ein ABSCHLIESSENDER Griff am Zielpunkt (Reihenfolge
        // wie `drawingVertices`: Anker→Knicke→Spitze); trägt der Text einen
        // Pfad, adressiert der Index einen Pfadpunkt; Textspalte (kein
        // Leader/Pfad, `width` gesetzt) hat 4 Rahmen-Eck-Griffe (s.
        // drawingVertices) — dieselbe Reihenfolge (pathPts > leaderTarget >
        // Breiten-Ecken > einzelner Anker) MUSS hier gespiegelt werden, sonst
        // adressiert ein Griff-Index das falsche Verhalten.
        if (g.shape === "text") {
          if (g.pathPts) {
            const pathPts = g.pathPts.map((pp, i) => (i === index ? pt : pp));
            return { ...d, geom: { ...g, pathPts } };
          }
          if (g.leaderTarget) {
            const bends = g.leaderBendPoints ?? [];
            const tipIndex = bends.length + 1;
            if (index === 0) return { ...d, geom: { ...g, at: pt } };
            if (index === tipIndex) return { ...d, geom: { ...g, leaderTarget: pt } };
            if (index > 0 && index < tipIndex) {
              const leaderBendPoints = bends.map((bp, i) => (i === index - 1 ? pt : bp));
              return { ...d, geom: { ...g, leaderBendPoints } };
            }
            return d;
          }
          if (g.width && g.width > 0 && index >= 0 && index < 4) {
            // Nur die Breite ändert sich (InDesign-Textrahmen-Verhalten,
            // Nutzer-Entscheidung) — Höhe bleibt inhaltsgetrieben. Ziehen wird
            // auf die LOKALE x-Achse projiziert (rotationsfest): linke Ecken
            // (Index 0/3, s. textFrameCorners-Reihenfolge oben-links/oben-
            // rechts/unten-rechts/unten-links) verschieben zusätzlich `at`,
            // damit die RECHTE Kante fest bleibt; rechte Ecken (1/2) lassen
            // `at`/die linke Kante fest.
            const cos = Math.cos(g.angle);
            const sin = Math.sin(g.angle);
            const dx = pt.x - g.at.x;
            const dy = pt.y - g.at.y;
            const localX = dx * cos + dy * sin;
            const MIN_WIDTH = 0.1;
            const isLeft = index === 0 || index === 3;
            if (isLeft) {
              const width = Math.max(MIN_WIDTH, g.width - localX);
              const at = { x: g.at.x + localX * cos, y: g.at.y + localX * sin };
              return { ...d, geom: { ...g, at, width } };
            }
            const width = Math.max(MIN_WIDTH, localX);
            return { ...d, geom: { ...g, width } };
          }
          return { ...d, geom: { ...g, at: pt } };
        }
        // Kote: der einzige Griff (Index 0) sitzt an der Dreieck-Spitze.
        if (g.shape === "kote") return { ...d, geom: { ...g, at: pt } };
        // Detail-/Schnitt-Verweis: der einzige Griff (Index 0) sitzt am Kreis-Zentrum.
        if (g.shape === "detailref") return { ...d, geom: { ...g, at: pt } };
        // Massstabsbalken: der einzige Griff (Index 0) sitzt an der linken unteren Ecke.
        if (g.shape === "scalebar") return { ...d, geom: { ...g, at: pt } };
        // Punkt-/Knotenmarker: der einzige Griff (Index 0) sitzt am Zentrum.
        if (g.shape === "pointmarker") return { ...d, geom: { ...g, at: pt } };
        // Block-Instanz: der einzige Griff (Index 0) sitzt am Einfügepunkt.
        if (g.shape === "block") return { ...d, geom: { ...g, at: pt } };
        // Kreis: Griff 0 (Ost) bzw. 1 (Nord) — zieht man die beiden Achsen
        // unabhängig auseinander, wird der Kreis zur Ellipse (rotation 0);
        // bleiben rx/ry (fast) gleich, bleibt es ein Kreis (s. `ellipseOrCircle`).
        if (g.shape === "circle") {
          const dx = pt.x - g.center.x, dy = pt.y - g.center.y;
          const rx = index === 0 ? Math.max(1e-3, Math.abs(dx)) : g.r;
          const ry = index === 0 ? g.r : Math.max(1e-3, Math.abs(dy));
          return { ...d, geom: ellipseOrCircle(g.center, rx, ry) };
        }
        // Bogen: Griff 0/1 (Start-/End-Winkel, s. drawingVertices) ändert a0/a1;
        // Griff 2 (Bogenmitte) ändert nur den Radius (Winkel bleiben fest).
        if (g.shape === "arc") {
          if (index === 2) {
            const r = Math.max(1e-3, Math.hypot(pt.x - g.center.x, pt.y - g.center.y));
            return { ...d, geom: { ...g, r } };
          }
          const ang = Math.atan2(pt.y - g.center.y, pt.x - g.center.x);
          return { ...d, geom: index === 0 ? { ...g, a0: ang } : { ...g, a1: ang } };
        }
        // Ellipse: Griff 0 (rx-Achse) bzw. 1 (ry-Achse) — der gezogene Punkt wird
        // ins lokale (gedrehte) Achsensystem projiziert, nur die jeweils
        // betroffene Halbachse ändert sich.
        if (g.shape === "ellipse") {
          const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
          const dx = pt.x - g.center.x, dy = pt.y - g.center.y;
          const lx = dx * c + dy * s;
          const ly = -dx * s + dy * c;
          const rx = index === 0 ? Math.max(1e-3, Math.abs(lx)) : g.rx;
          const ry = index === 0 ? g.ry : Math.max(1e-3, Math.abs(ly));
          // Nur bei rotation 0 kann eine (fast) gleichseitige Ellipse wieder
          // zum Kreis kollabieren — eine gedrehte Ellipse mit rx≈ry ist optisch
          // bereits ein Kreis, „Drehung" wäre dann aber wieder bedeutungslos.
          if (g.rotation === 0) return { ...d, geom: ellipseOrCircle(g.center, rx, ry) };
          return { ...d, geom: { ...g, rx, ry } };
        }
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
  // Objekt-Sperre: s. Kommentar in `moveGrip` oben.
  if (drawingId && project.drawings2d.find((d) => d.id === drawingId)?.locked) return project;
  if (wallId && project.walls.find((w) => w.id === wallId)?.locked) return project;
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
          case "image":
            return { ...d, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
          case "circle":
          case "arc":
          case "ellipse":
            return { ...d, geom: { ...g, center: mv(g.center) } };
          case "bezier":
          case "spline":
          case "dimension":
            return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
          case "kote":
            return { ...d, geom: { ...g, at: mv(g.at) } };
          case "detailref":
            return { ...d, geom: { ...g, at: mv(g.at) } };
          case "scalebar":
            return { ...d, geom: { ...g, at: mv(g.at) } };
          case "pointmarker":
            return { ...d, geom: { ...g, at: mv(g.at) } };
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
 * Neue Position eines Eckpunkts, dessen EINE Kante parallel um `delta`
 * verschoben wird: der Punkt bleibt NICHT einfach delta-verschoben, sondern
 * wandert entlang seiner ANDEREN (unverschobenen) Nachbarkante — deren
 * Richtung bleibt exakt erhalten (nur ihre Länge ändert sich), statt sich mit
 * zu drehen. Nutzer-Report: bei Vielecken mit mehr als 4/5 Ecken (nicht
 * rechtwinklige Anschlüsse) kippten die Nachbarkanten bisher im Winkel, weil
 * der Eckpunkt stur um `delta` versetzt wurde (korrekt nur bei rechtwinkligen
 * Anschlüssen — Zufall bei Rechtecken, da rect ohnehin nur achsparallele
 * Ecken kennt). Berechnet als Schnittpunkt der verschobenen Kanten-Linie mit
 * der (unendlich verlängerten) Nachbarkanten-Linie durch den fixen
 * Nachbarpunkt — dasselbe Prinzip wie die Wandstoß-Gehrung in `model/
 * joins.ts`. Fällt bei fehlendem Nachbarn (offenes Kettenende) oder (fast)
 * paralleler Nachbarkante (kein/instabiler Schnittpunkt) auf die einfache
 * Delta-Verschiebung zurück.
 */
function edgeMoveVertex(
  vertexOrig: Vec2,
  neighborFixed: Vec2 | null,
  shiftedLinePoint: Vec2,
  edgeDir: Vec2,
  delta: Vec2,
): Vec2 {
  const fallback: Vec2 = { x: vertexOrig.x + delta.x, y: vertexOrig.y + delta.y };
  if (!neighborFixed) return fallback;
  const neighborDir: Vec2 = {
    x: vertexOrig.x - neighborFixed.x,
    y: vertexOrig.y - neighborFixed.y,
  };
  if (Math.hypot(neighborDir.x, neighborDir.y) < 1e-9) return fallback; // entartete Nachbarkante
  return lineIntersect(neighborFixed, neighborDir, shiftedLinePoint, edgeDir) ?? fallback;
}

/**
 * Nachbar-Index in einem Vertex-Ring/einer -Kette in Richtung `dir`. `null`,
 * wenn `i` am offenen Ende liegt und `closed` falsch ist (kein Nachbar dort)
 * ODER der Nachbar auf die andere Kanten-Ecke selbst fiele (entartetes
 * 2-Punkt-„Polygon" — kein sinnvoller dritter Bezugspunkt).
 */
function ringNeighbor(
  i: number,
  n: number,
  closed: boolean,
  dir: 1 | -1,
  excluding: number,
): number | null {
  const j = i + dir;
  const k = j >= 0 && j < n ? j : closed ? ((j % n) + n) % n : null;
  return k !== null && k !== excluding ? k : null;
}

/**
 * Verschiebt die Kante (aIndex,bIndex) eines Vertex-Rings/einer -Kette um
 * `delta`, winkeltreu an den beiden Nachbar-Ecken (s. `edgeMoveVertex`).
 * `closed`: Ring (Raum/Decke/geschlossene Polylinie) oder offene Kette
 * (offene Polylinie).
 */
function movePolygonEdge(
  pts: Vec2[],
  aIndex: number,
  bIndex: number,
  delta: Vec2,
  closed: boolean,
): Vec2[] {
  const n = pts.length;
  const A = pts[aIndex];
  const B = pts[bIndex];
  const shiftedA: Vec2 = { x: A.x + delta.x, y: A.y + delta.y };
  const edgeDir: Vec2 = { x: B.x - A.x, y: B.y - A.y };
  const prevOfA = ringNeighbor(aIndex, n, closed, -1, bIndex);
  const nextOfB = ringNeighbor(bIndex, n, closed, 1, aIndex);
  return pts.map((p, i) => {
    if (i === aIndex) {
      return edgeMoveVertex(A, prevOfA != null ? pts[prevOfA] : null, shiftedA, edgeDir, delta);
    }
    if (i === bIndex) {
      return edgeMoveVertex(B, nextOfB != null ? pts[nextOfB] : null, shiftedA, edgeDir, delta);
    }
    return p;
  });
}

/**
 * Verschiebt eine SEITE (Kante) des selektierten Elements: beide Vertices der
 * Kante um `delta` (immutabel), winkeltreu an den Nachbarkanten (s. o.). Für
 * 2D-Elemente:
 *  • rect: die zwei betroffenen Ecken (per Index) verschieben und min/max neu
 *    normalisieren — so wächst/schrumpft das Rechteck an genau dieser Seite
 *    (immer rechtwinklig, `movePolygonEdge` nicht nötig).
 *  • polyline: die zwei Vertices `aIndex`/`bIndex` um `delta` verschieben,
 *    winkeltreu über `movePolygonEdge`.
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
  // Objekt-Sperre: s. Kommentar in `moveGrip` oben.
  if (drawingId && project.drawings2d.find((d) => d.id === drawingId)?.locked) return project;
  if (wallId && project.walls.find((w) => w.id === wallId)?.locked) return project;
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
        if (g.shape === "polyline" || g.shape === "spline") {
          const pts = movePolygonEdge(g.pts, aIndex, bIndex, delta, !!g.closed);
          return { ...d, geom: { ...g, pts } };
        }
        if (g.shape === "rect" || g.shape === "image") {
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
