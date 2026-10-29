// Projekt-Slice: das semantische Modell (`project`) plus ALLE Mutationen, die
// heute in App.tsx als Closures über setProject existieren. Reiner Umzug — die
// Logik ist 1:1 übernommen (inkl. recomputeFloorElevations, refs-aware delete,
// Tree-Helfern). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).
//
// Cross-Slice-Zugriffe: einige Aktionen lesen/schreiben View-Felder
// (activeLevelId) — das geht, weil `get()`/`set` über den Gesamt-RootState
// laufen. Die Slice tippt daher nur ihre eigenen Felder; `get()` liefert
// RootState (siehe appStore.ts), wir greifen punktuell auf View-Felder zu.

import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import type { ProjectMutation } from "../core";
import type { LoadFileResult } from "../core/document";
import {
  addItems,
  fieldOps,
  patchItem,
  patchItems,
  removeItems,
  replaceItem,
  setField,
  setFieldIfChanged,
} from "../core";
import type { PolylineVertexType } from "../core";
import { sampleProject } from "../model/sampleProject";
import {
  addChildByCode,
  applyVisibilityByCode,
  findCategory,
  flattenCategories,
  insertAfterCode,
  nextFreeCode,
  patchCategoryByCode,
  recomputeFloorElevations,
  removeCategoryByCode,
  toggleCategoryByCode,
} from "../model/layers";
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
  deletePenOps,
  rebakePenOps,
  seedStandardPenSetOps,
  PEN_FALLBACK_COLOR,
  PEN_FALLBACK_WEIGHT,
} from "../model/penSets";
import { reorderByIds } from "../model/reorder";
import { transformMutation } from "../tools/transform";
import type { CopyMode, TransformOp, TransformSelection } from "../tools/transform";
import { uniqueId } from "../tools/types";
import { gripPt, type GripRequest } from "../core";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
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
   * Änderung als Projekt → Projekt-Funktion MIT mitgeführten Ops (`opsMutation`, Schnittstellen wie
   * `CommandResult.commit`); der Kern bekommt die Ops ([K4] S3 — keine Projekt-Differenz mehr).
   * `coalesceKey`: NUR für bekannte Hochfrequenz-Aktionen (Griff-Ziehen, Inline-Text-Tippen) —
   * gleicher Key im Zeitfenster = EIN Undo-Schritt. Ein anderes Projekt als Ganzes:
   * {@link loadProject}/{@link openProjectFile}.
   */
  setProject: (next: ProjectMutation, coalesceKey?: string) => void;
  /**
   * Änderung direkt als Ops ([K4] S3): `ops` oder ein Op-Bauer auf dem aktuellen Projekt
   * (`core/opsBuild.ts`). Geht direkt an den Kern (Prüfung, Verlauf); sonst wie
   * {@link setProject} (gleicher `coalesceKey` im Zeitfenster = ein Undo-Schritt).
   */
  applyChange: (ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[]), coalesceKey?: string) => void;
  /** Die zuletzt angewendeten Ops (JSON-serialisierbar), jüngste zuletzt. */
  recentOps: () => CoreOp[][];
  /**
   * Ein anderes Projekt übernehmen (Neu, Musterhaus; [K4] S4): lädt es als Ganzes ins Kern-Dokument
   * und leert den Verlauf (Rückgängig führt nicht ins vorherige Projekt).
   */
  loadProject: (next: Project) => void;
  /**
   * Projektdatei (Text) öffnen (Öffnen, Vorlage, Wiederherstellen): der Kern liest, migriert, prüft
   * und lädt sie direkt (`ProjectDocument.loadFile`), der Verlauf wird geleert. Bei Fehler bleibt
   * das Projekt unverändert.
   */
  openProjectFile: (text: string) => LoadFileResult;

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
   * im Kern (`polyline_vertex.rs`, Griff-Änderung `vertexType`) — rechnet nur die Bulges der beiden
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

  // Kern-Commit einer Op-Folge auf `s.project` (Prüfung, Verlauf, Leseansicht nachführen).
  // Verstösse werden zurückgerollt und gemeldet.
  const commitOps = (
    s: { project: Project },
    ops: readonly CoreOp[],
    coalesceKey: string | undefined,
  ): Partial<ProjectSlice & HistorySlice> => {
    if (ops.length === 0) return {};
    const doc = storeDocument(s.project);
    const res = doc.commit(s.project, ops, coalesceKey, Date.now());
    if ("problems" in res) {
      const problems = res.problems;
      console.warn("Projektänderung verworfen:", problems);
      queueMicrotask(() => get().notify(`${t("project.change.rejected")} ${problems[0]}`, "error"));
      return {};
    }
    opLog.push(ops.slice());
    if (opLog.length > OP_LOG_LIMIT) opLog.shift();
    return { project: res.project, ...historyPatch(doc) };
  };

  // Änderung mit mitgeführten Ops (`opsMutation`). Zweiter, optionaler Parameter `coalesceKey`: NUR
  // von den paar bekannten Hochfrequenz-Aktionen (Grip-Drag & Co.) gesetzt — alle anderen Aktionen
  // rufen ohne Key auf und pushen damit IMMER diskret. Das Projekt ändert sich NUR über Ops: der Kern
  // prüft (NaN, doppelte ids), wendet an und zeichnet den Undo-Schritt auf ([K4] S3).
  const setProject = (next: ProjectMutation, coalesceKey?: string) =>
    next.coreReq ? applyCmd(next.coreReq, coalesceKey) : set((s) => commitOps(s, next.toOps(s.project), coalesceKey));

  // Befehl ([K4] S3, `commands.rs`): der Kern rechnet ihn auf dem Dokument und wendet ihn im selben
  // Aufruf an (`cmdMutation`); Prüfung, Verlauf und Meldungen wie `commitOps`.
  const applyCmd = (req: object, coalesceKey?: string) =>
    set((s) => {
      const doc = storeDocument(s.project);
      const res = doc.commitCmd(s.project, req, coalesceKey, Date.now());
      if ("problems" in res) {
        const problems = res.problems;
        console.warn("Projektänderung verworfen:", problems);
        queueMicrotask(() => get().notify(`${t("project.change.rejected")} ${problems[0]}`, "error"));
        return {};
      }
      if (res.ops.length === 0) return {};
      opLog.push(res.ops);
      if (opLog.length > OP_LOG_LIMIT) opLog.shift();
      return { project: res.project, ...historyPatch(doc) };
    });

  // Änderung direkt als Ops (ohne Differenz), s. `ProjectSlice.applyChange`.
  const applyChange = (
    ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[]),
    coalesceKey?: string,
  ) => set((s) => commitOps(s, typeof ops === "function" ? ops(s.project) : ops, coalesceKey));

  // Griff-Änderung ([K4] S3): der Kern rechnet sie auf dem Dokument und wendet sie im selben Aufruf an
  // (`grips.rs`, ein WASM-Aufruf je Mausschritt); Prüfung, Verlauf und Meldungen wie `commitOps`.
  const applyGrip = (req: GripRequest, coalesceKey?: string) => {
    let notice: string | undefined;
    set((s) => {
      const doc = storeDocument(s.project);
      const res = doc.commitGrip(s.project, req, coalesceKey, Date.now());
      if ("problems" in res) {
        const problems = res.problems;
        console.warn("Projektänderung verworfen:", problems);
        queueMicrotask(() => get().notify(`${t("project.change.rejected")} ${problems[0]}`, "error"));
        return {};
      }
      notice = res.notice;
      if (res.ops.length === 0) return {};
      opLog.push(res.ops);
      if (opLog.length > OP_LOG_LIMIT) opLog.shift();
      return { project: res.project, ...historyPatch(doc) };
    });
    if (notice) get().notify(t(notice as Parameters<typeof t>[0]), "warning");
  };

  return {
    ...history,

    // Store-Default beim Modul-Laden — sichtbar nur ganz kurz HINTER dem
    // Splash/Startbildschirm (App.tsx bootPhase: splash → start → editor),
    // bevor eine der drei Optionen (Neu/Öffnen/Zuletzt) das echte Projekt
    // setzt. Der konkrete Wert spielt daher praktisch keine Rolle mehr.
    project: sampleProject,

    setProject,
    applyChange,
    recentOps: () => opLog.slice(),

    loadProject: (next) => {
      const doc = storeDocument(get().project);
      doc.load(next);
      set({ project: next, ...historyPatch(doc) });
    },

    openProjectFile: (text) => {
      const doc = storeDocument(get().project);
      const r = doc.loadFile(text);
      if (r.ok) set({ project: r.project, ...historyPatch(doc) });
      return r;
    },

    // ── Zeichnungsebenen ───────────────────────────────────────────────────
    toggleLevelVisible: (id) =>
      applyChange((p) => patchItem(p, "drawingLevels", id, (z) => ({ ...z, visible: !z.visible }))),

    patchActiveFloor: (patch) => {
      const activeLevelId = get().activeLevelId;
      applyChange((p) =>
        fieldOps(
          p,
          "drawingLevels",
          recomputeFloorElevations(
            p.drawingLevels.map((z) => (z.id === activeLevelId ? { ...z, ...patch } : z)),
          ),
        ),
      );
    },

    addFloor: () =>
      applyChange((p) => {
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
        return fieldOps(p, "drawingLevels", recomputeFloorElevations([...p.drawingLevels, floor]));
      }),

    addDrawing: () =>
      applyChange((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "drawing").length + 1;
        const drawing: DrawingLevel = {
          id: `drawing-${Date.now()}`,
          name: t("default.drawingName", { n }),
          kind: "drawing",
          visible: true,
          locked: false,
        };
        return addItems("drawingLevels", [drawing]);
      }),

    // Schnitt/Ansicht sind vorerst Platzhalter ohne Schnittlinie (linePoints
    // bleibt undefined, bis die Schnitt-UI existiert — siehe toSection.ts).
    addSection: () =>
      applyChange((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "section").length + 1;
        const section: DrawingLevel = {
          id: `section-${Date.now()}`,
          name: t("default.sectionName", { n }),
          kind: "section",
          visible: true,
          locked: false,
        };
        return addItems("drawingLevels", [section]);
      }),

    addElevation: () =>
      applyChange((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "elevation").length + 1;
        const elevation: DrawingLevel = {
          id: `elevation-${Date.now()}`,
          name: t("default.elevationName", { n }),
          kind: "elevation",
          visible: true,
          locked: false,
        };
        return addItems("drawingLevels", [elevation]);
      }),

    // Neue freie Zeichnungsebene mit explizitem Namen anlegen und ihre ID
    // zurückgeben (Ziel-Ebene eines DXF-Imports). Der Name kommt vom Aufrufer
    // (Dialog); leere Eingabe fällt auf den Default-Namen zurück.
    addDrawingLevel: (name) => {
      const id = `drawing-${Date.now()}`;
      applyChange((p) => {
        const n = p.drawingLevels.filter((z) => z.kind === "drawing").length + 1;
        const drawing: DrawingLevel = {
          id,
          name: name.trim() || t("default.drawingName", { n }),
          kind: "drawing",
          visible: true,
          locked: false,
        };
        return addItems("drawingLevels", [drawing]);
      });
      return id;
    },

    importDrawings: (drawings) => applyChange(addItems("drawings2d", drawings)),

    patchLevel: (id, patch) =>
      applyChange((p) =>
        fieldOps(
          p,
          "drawingLevels",
          recomputeFloorElevations(p.drawingLevels.map((z) => (z.id === id ? { ...z, ...patch } : z))),
        ),
      ),

    duplicateLevel: (id) =>
      applyChange((p) => {
        const i = p.drawingLevels.findIndex((z) => z.id === id);
        if (i < 0) return [];
        const src = p.drawingLevels[i];
        const clone: DrawingLevel = {
          ...src,
          id: `${src.kind}-${Date.now()}`,
          name: t("default.copySuffixLevel", { name: src.name }),
        };
        const next = [...p.drawingLevels];
        next.splice(i + 1, 0, clone);
        return fieldOps(p, "drawingLevels", recomputeFloorElevations(next));
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
      applyChange((p) => {
        const removedWallIds = new Set(
          p.walls.filter((w) => w.floorId === id).map((w) => w.id),
        );
        return [
          ...fieldOps(p, "drawingLevels", recomputeFloorElevations(p.drawingLevels.filter((z) => z.id !== id))),
          ...removeItems(p, "walls", removedWallIds),
          ...removeItems(p, "ceilings", (c) => c.floorId === id),
          ...removeItems(p, "stairs", (s) => s.floorId === id),
          ...removeItems(p, "rooms", (r) => r.floorId === id),
          ...removeItems(p, "openings", (o) => removedWallIds.has(o.hostWallId)),
        ];
      });
    },

    // ── Ebenen (Kategorien) ────────────────────────────────────────────────
    toggleCategoryVisible: (code) =>
      applyChange((p) => fieldOps(p, "layers", toggleCategoryByCode(p.layers, code))),

    addCategory: () =>
      applyChange((p) => {
        const code = nextFreeCode(p.layers);
        const category: LayerCategory = {
          code,
          name: t("default.categoryName"),
          color: "#888888",
          lw: 0.18,
          visible: true,
          locked: false,
        };
        return [setField("layers", [...p.layers, category])];
      }),

    patchCategory: (code, patch) =>
      applyChange((p) => fieldOps(p, "layers", patchCategoryByCode(p.layers, code, patch))),

    addSubCategory: (parentCode) =>
      applyChange((p) => {
        const code = nextFreeCode(p.layers);
        const child: LayerCategory = {
          code,
          name: t("default.subCategoryName"),
          color: "#888888",
          lw: 0.18,
          visible: true,
          locked: false,
        };
        return fieldOps(p, "layers", addChildByCode(p.layers, parentCode, child));
      }),

    duplicateCategory: (code) =>
      applyChange((p) => {
        const src = findCategory(p.layers, code);
        if (!src) return [];
        const clone: LayerCategory = {
          ...src,
          code: nextFreeCode(p.layers),
          name: t("default.copySuffixLayer", { name: src.name }),
          children: undefined,
        };
        return fieldOps(p, "layers", insertAfterCode(p.layers, code, clone));
      }),

    deleteCategory: (code) =>
      applyChange((p) => {
        if (flattenCategories(p.layers).length <= 1) return []; // letzte behalten
        const src = findCategory(p.layers, code);
        if (!src) return [];
        const codes = new Set(flattenCategories([src]).map((c) => c.code));
        const usedByWall = p.walls.some((w) => codes.has(w.categoryCode));
        const usedByOpening = (p.openings ?? []).some((o) =>
          codes.has(o.categoryCode),
        );
        if (usedByWall || usedByOpening) {
          get().notify(t("alert.layerInUse", { code: src.code, name: src.name }), "warning");
          return [];
        }
        return fieldOps(p, "layers", removeCategoryByCode(p.layers, code));
      }),

    assignWallCategory: (wallId, code) =>
      applyChange((p) => patchItem(p, "walls", wallId, { categoryCode: code })),

    // ── Sichtbarkeits-Kombinationen ────────────────────────────────────────
    snapshotLayerVisibility: () => {
      const out: Record<string, boolean> = {};
      for (const c of flattenCategories(get().project.layers)) {
        out[c.code] = c.visible;
      }
      return out;
    },

    applyLayerVisibility: (codes) =>
      applyChange((p) => fieldOps(p, "layers", applyVisibilityByCode(p.layers, codes))),

    snapshotDrawingVisibility: () => {
      const out: Record<string, boolean> = {};
      for (const z of get().project.drawingLevels) out[z.id] = z.visible;
      return out;
    },

    applyDrawingVisibility: (ids) =>
      applyChange((p) =>
        patchItems(p, "drawingLevels", (z) => z.id in ids, (z) => ({ ...z, visible: ids[z.id] })),
      ),

    // ── Ressourcen ─────────────────────────────────────────────────────────
    patchComponent: (id, patch) => applyChange((p) => patchItem(p, "components", id, patch)),

    addComponent: () =>
      applyChange((p) => {
        const ops: CoreOp[] = [];
        let hatchId = p.hatches[0]?.id;
        if (!hatchId) {
          const fallback: HatchStyle = {
            id: `hatch-${Date.now()}`,
            name: t("default.hatchNone"),
            pattern: "none",
            scale: 1,
            angle: 0,
            color: "#2b3039",
          };
          ops.push(...fieldOps(p, "hatches", [fallback]));
          hatchId = fallback.id;
        }
        const component: Component = {
          id: `component-${Date.now()}`,
          name: t("default.componentName"),
          color: "#9aa0a6",
          hatchId,
          joinPriority: 50,
        };
        return [...ops, ...addItems("components", [component])];
      }),

    deleteComponent: (id) =>
      applyChange((p) => {
        const used = p.wallTypes.some((wt) =>
          wt.layers.some((l) => l.componentId === id),
        );
        if (used) {
          const name = p.components.find((c) => c.id === id)?.name ?? id;
          get().notify(t("alert.componentInUse", { name }), "warning");
          return [];
        }
        return removeItems(p, "components", [id]);
      }),

    patchHatch: (id, patch) => applyChange((p) => patchItem(p, "hatches", id, patch)),

    addHatch: () =>
      applyChange((p) => {
        const hatch: HatchStyle = {
          id: `hatch-${Date.now()}`,
          name: t("default.hatchName"),
          pattern: "diagonal",
          scale: 1,
          angle: 45,
          color: "#2b3039",
          lineStyleId: p.lineStyles[0]?.id,
        };
        return addItems("hatches", [hatch]);
      }),

    deleteHatch: (id) =>
      applyChange((p) => {
        const used = p.components.some((c) => c.hatchId === id);
        if (used) {
          const name = p.hatches.find((h) => h.id === id)?.name ?? id;
          get().notify(t("alert.hatchInUse", { name }), "warning");
          return [];
        }
        return removeItems(p, "hatches", [id]);
      }),

    patchLineStyle: (id, patch) => applyChange((p) => patchItem(p, "lineStyles", id, patch)),

    addLineStyle: () =>
      applyChange(() => {
        const lineStyle: LineStyle = {
          id: `line-${Date.now()}`,
          name: t("default.lineStyleName"),
          weight: 0.18,
          color: "#2b3039",
          dash: null,
        };
        return addItems("lineStyles", [lineStyle]);
      }),

    deleteLineStyle: (id) =>
      applyChange((p) => {
        const used = p.hatches.some((h) => h.lineStyleId === id);
        if (used) {
          const name = p.lineStyles.find((l) => l.id === id)?.name ?? id;
          get().notify(t("alert.lineStyleInUse", { name }), "warning");
          return [];
        }
        return removeItems(p, "lineStyles", [id]);
      }),

    importLineStyles: (styles) =>
      applyChange(addItems("lineStyles", styles.map((s, i) => ({ ...s, id: `ls-${Date.now()}-${i}` })))),

    patchTextStyle: (id, patch) =>
      applyChange((p) =>
        fieldOps(
          p,
          "textStyles",
          (p.textStyles ?? DEFAULT_PRESETS).map((s) =>
            s.id === id ? { ...s, ...patch, marks: { ...s.marks, ...patch.marks } } : s,
          ),
        ),
      ),

    addTextStyle: () =>
      applyChange((p) => {
        const style: TextStylePreset = {
          id: `ts-${Date.now()}`,
          label: t("default.textStyleName"),
          marks: { sizePt: 10 },
        };
        return fieldOps(p, "textStyles", [...(p.textStyles ?? DEFAULT_PRESETS), style]);
      }),

    deleteTextStyle: (id) =>
      applyChange((p) => fieldOps(p, "textStyles", (p.textStyles ?? DEFAULT_PRESETS).filter((s) => s.id !== id))),

    importHatches: (hatches) =>
      applyChange(addItems("hatches", hatches.map((h, i) => ({ ...h, id: `ht-${Date.now()}-${i}` })))),

    // ── Stiftsätze ─────────────────────────────────────────────────────────
    addPen: () =>
      applyChange((p) => {
        const pen: ColorPen = { id: `pen-${Date.now()}`, name: t("default.penName") };
        return [
          ...addItems("pens", [pen]),
          // Neuer Stift bekommt in JEDEM bestehenden Stiftsatz sofort einen
          // Eintrag (Fallback-Grauton+Stärke) — Stiftsätze bleiben dadurch
          // immer deckungsgleich zur `pens`-Liste, keine "fehlt in Satz X"-Lücken.
          ...patchItems(p, "penSets", () => true, (s) => ({
            ...s,
            pens: { ...s.pens, [pen.id]: { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT } },
          })),
        ];
      }),

    renamePen: (id, name) => applyChange((p) => patchItem(p, "pens", id, { name })),

    deletePen: (id) => applyChange((p) => deletePenOps(p, id)),

    addPenSet: () =>
      applyChange((p) => {
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
        // Erster Stiftsatz überhaupt: automatisch aktivieren (sonst löst jeder
        // Stift-Verweis bis zur ersten manuellen Aktivierung auf den Fallback auf).
        return [
          ...addItems("penSets", [penSet]),
          ...setFieldIfChanged(p, "activePenSetId", p.activePenSetId ?? penSet.id),
        ];
      }),

    renamePenSet: (id, name) => applyChange((p) => patchItem(p, "penSets", id, { name })),

    deletePenSet: (id) =>
      applyChange((p) => {
        if (p.activePenSetId === id) {
          const name = p.penSets?.find((s) => s.id === id)?.name ?? id;
          get().notify(t("alert.penSetIsActive", { name }), "warning");
          return [];
        }
        return removeItems(p, "penSets", [id]);
      }),

    setActivePenSet: (id) =>
      applyChange((p) => {
        const stateOps = [setField("activePenSetId", id)];
        return [...stateOps, ...rebakePenOps(applyOps(p, stateOps))];
      }),

    patchPenSetColor: (setId, penId, color) =>
      applyChange((p) => {
        const stateOps = patchItem(p, "penSets", setId, (s) => ({
          ...s,
          pens: {
            ...s.pens,
            [penId]: { ...(s.pens[penId] ?? { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT }), color },
          },
        }));
        return setId === p.activePenSetId ? [...stateOps, ...rebakePenOps(applyOps(p, stateOps))] : stateOps;
      }),

    patchPenSetWeight: (setId, penId, weight) =>
      applyChange((p) => {
        const stateOps = patchItem(p, "penSets", setId, (s) => ({
          ...s,
          pens: {
            ...s.pens,
            [penId]: { ...(s.pens[penId] ?? { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT }), weight },
          },
        }));
        return setId === p.activePenSetId ? [...stateOps, ...rebakePenOps(applyOps(p, stateOps))] : stateOps;
      }),

    seedStandardPenSet: () => applyChange((p) => seedStandardPenSetOps(p)),

    addCustomPalette: () =>
      applyChange(
        addItems("customPalettes", [{ id: `palette-${Date.now()}`, name: t("default.customPaletteName"), colors: [] }]),
      ),

    renameCustomPalette: (id, name) => applyChange((p) => patchItem(p, "customPalettes", id, { name })),

    deleteCustomPalette: (id) => applyChange((p) => removeItems(p, "customPalettes", [id])),

    addColorToCustomPalette: (paletteId, hex) =>
      applyChange((p) => {
        const target = (p.customPalettes ?? []).find((c) => c.id === paletteId);
        if (!target) {
          const created = { id: `palette-${Date.now()}`, name: t("default.customPaletteName"), colors: [hex] };
          return addItems("customPalettes", [created]);
        }
        const withoutDupe = target.colors.filter((c) => c.toLowerCase() !== hex.toLowerCase());
        return [replaceItem("customPalettes", { ...target, colors: [hex, ...withoutDupe] })];
      }),

    removeColorFromCustomPalette: (paletteId, hex) =>
      applyChange((p) =>
        patchItem(p, "customPalettes", paletteId, (c) => ({
          ...c,
          colors: c.colors.filter((h) => h.toLowerCase() !== hex.toLowerCase()),
        })),
      ),

    setCustomPaletteVisible: (id, visible) => applyChange((p) => patchItem(p, "customPalettes", id, { visible })),

    setBuiltinPaletteVisible: (bank, visible) =>
      applyChange((p) => [setField("builtinPaletteBanks", { ...p.builtinPaletteBanks, [bank]: visible })]),

    insertDrawingPoint: (drawingId, segIndex, pt) =>
      applyGrip({ op: "insertPoint", id: drawingId, seg: segIndex, pt: gripPt(pt) }),

    setPolylineVertexType: (drawingId, index, type) =>
      applyGrip({ op: "vertexType", id: drawingId, index, vertexType: type }),

    deleteDrawingPoint: (drawingId, index) => applyGrip({ op: "deletePoint", id: drawingId, index }),

    // ── Editier-Griffe ─────────────────────────────────────────────────────
    // Diese Aktionen laufen AD-HOC bei jedem Maus-Move-Schritt eines Drags
    // (kein Draft/Commit-Muster wie bei den Zeichenwerkzeugen) — daher mit
    // coalesceKey, damit EIN Drag EINEN Undo-Schritt erzeugt statt vieler.
    moveGripOf: (drawingId, wallId, index, pt, scaleDenominator = DEFAULT_SCALE_DENOMINATOR) =>
      applyGrip(
        { op: "moveGrip", drawingId, wallId, index, pt: gripPt(pt), scale: scaleDenominator },
        `moveGripOf:${drawingId ?? ""}:${wallId ?? ""}:${index}`,
      ),

    moveElementByOf: (drawingId, wallId, delta) =>
      applyGrip({ op: "moveBy", drawingId, wallId, delta: gripPt(delta) }, `moveElementByOf:${drawingId ?? ""}:${wallId ?? ""}`),

    moveEdgeOf: (drawingId, wallId, aIndex, bIndex, delta) =>
      applyGrip(
        { op: "moveEdge", drawingId, wallId, a: aIndex, b: bIndex, delta: gripPt(delta) },
        `moveEdgeOf:${drawingId ?? ""}:${wallId ?? ""}:${aIndex}:${bIndex}`,
      ),

    // ── Selektions-Attribute ───────────────────────────────────────────────
    setElementColor: (kind, id, color) =>
      applyChange((p) =>
        kind === "drawing2d" ? patchItem(p, "drawings2d", id, { color }) : patchItem(p, "walls", id, { color }),
      ),

    // Strichstärke gibt es als direktes Feld NUR auf Drawing2D; bei unbekannter
    // ID bleibt das Projekt unverändert (No-op).
    setElementWeight: (id, weightMm) => applyChange((p) => patchItem(p, "drawings2d", id, { weightMm })),

    // Füllschraffur NUR für Drawing2D; `null` entfernt die Schraffur (Feld weg).
    setElementFill: (id, hatchId) =>
      applyChange((p) =>
        patchItem(p, "drawings2d", id, (d) => {
          if (hatchId === null) {
            const { hatchId: _omit, ...rest } = d;
            return rest;
          }
          return { ...d, hatchId };
        }),
      ),

    // Vollton-Füllfarbe NUR für Drawing2D; `null` entfernt das Feld.
    setElementFillColor: (id, fillColor) =>
      applyChange((p) =>
        patchItem(p, "drawings2d", id, (d) => {
          if (fillColor === null) {
            const { fillColor: _omit, ...rest } = d;
            return rest;
          }
          return { ...d, fillColor };
        }),
      ),

    // Vordergrund-/Hintergrund-Override (Wand/Decke/Drawing2D); `null` löscht
    // das Feld (→ „Nach System", erbt wieder vom Bauteil/System).
    setElementForeground: (kind, id, value) =>
      applyChange((p) => setOverrideField(p, kind, id, "foreground", value)),
    setElementBackground: (kind, id, value) =>
      applyChange((p) => setOverrideField(p, kind, id, "background", value)),

    updateDrawing2D: (id, patch) => applyChange((p) => patchItem(p, "drawings2d", id, patch)),

    reorderDrawings: (ids, op) =>
      applyChange((p) => fieldOps(p, "drawings2d", reorderByIds(p.drawings2d, ids, op))),

    reorderDrawingLevels: (ids, op) =>
      applyChange((p) => fieldOps(p, "drawingLevels", reorderByIds(p.drawingLevels, ids, op))),

    // ── Größe (Resize um Anker) ────────────────────────────────────────────
    resizeElement: (kind, id, w, h, anchor) => applyGrip({ op: "resize", kind, id, w, h, fx: anchor.fx, fy: anchor.fy }),

    // ── Transformation ─────────────────────────────────────────────────────
    commitTransformOn: (sel, op, points, copyMode, count) => setProject(transformMutation(sel, op, points, copyMode, count)),

    // ── Wand-Attribute ─────────────────────────────────────────────────────
    updateWall: (id, patch, coalesceKey) => applyChange((p) => patchItem(p, "walls", id, patch), coalesceKey),

    // Dicke einer einschichtigen Wand (Kern `grips.rs`); id und Name eines ggf. neuen Wandtyps kommen von hier.
    setWallThickness: (wallId, thickness) =>
      applyGrip({
        op: "wallThickness",
        id: wallId,
        thickness,
        newId: `wt-${Date.now()}`,
        newName: t("default.wallTypeSingle", { thickness: thickness.toFixed(2) }),
      }),

    // ── Decken-Editieren ──────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf — auch hier läuft die
    // Mutation bei jedem Maus-Move-Schritt eines Drags.)
    moveCeilingGrip: (ceilingId, index, pt) =>
      applyGrip({ op: "ceilingGrip", id: ceilingId, index, pt: gripPt(pt) }, `moveCeilingGrip:${ceilingId}:${index}`),

    moveCeilingBy: (ceilingId, delta) =>
      applyGrip({ op: "ceilingBy", id: ceilingId, delta: gripPt(delta) }, `moveCeilingBy:${ceilingId}`),

    moveCeilingEdge: (ceilingId, aIndex, bIndex, delta) =>
      applyGrip(
        { op: "ceilingEdge", id: ceilingId, a: aIndex, b: bIndex, delta: gripPt(delta) },
        `moveCeilingEdge:${ceilingId}:${aIndex}:${bIndex}`,
      ),

    updateCeiling: (id, patch) =>
      applyChange((p) => mapCeiling(p, id, (c) => ({ ...c, ...patch }))),

    // Dicke einer einschichtigen Decke (Kern `grips.rs`), analog zur Wand.
    setCeilingThickness: (ceilingId, thickness) =>
      applyGrip({
        op: "ceilingThickness",
        id: ceilingId,
        thickness,
        newId: `ct-${Date.now()}`,
        newName: t("default.ceilingTypeSingle", { thickness: thickness.toFixed(2) }),
      }),

    // ── Öffnungs-Editieren ────────────────────────────────────────────────
    updateOpening: (id, patch) => applyChange((p) => patchItem(p, "openings", id, patch)),

    // ── Dach-Editieren ─────────────────────────────────────────────────────
    updateRoof: (id, patch, coalesceKey) => applyChange((p) => patchItem(p, "roofs", id, patch), coalesceKey),

    // Dach-Eckgriff (3D): der gezogene Umriss-Eckpunkt `index` wandert auf `pt`;
    // die GEGENÜBERLIEGENDE Ecke bleibt fix → der Umriss bleibt ein achsparalleles
    // Rechteck (die Dach-Geometrie rechnet ohnehin auf der Bounding-Box).
    moveRoofGrip: (roofId, index, pt) =>
      applyGrip({ op: "roofGrip", id: roofId, index, pt: gripPt(pt) }, `moveRoofGrip:${roofId}`),

    // Dach als Ganzes verschieben (Verschiebe-Griff).
    moveRoofBy: (roofId, delta) => applyGrip({ op: "roofBy", id: roofId, delta: gripPt(delta) }, `moveRoofBy:${roofId}`),

    // ── Treppen-Editieren ──────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf.)
    moveStairBy: (stairId, delta) => applyGrip({ op: "stairBy", id: stairId, delta: gripPt(delta) }, `moveStairBy:${stairId}`),

    updateStair: (id, patch) =>
      applyChange((p) => mapStair(p, id, (s) => ({ ...s, ...patch }))),

    // ── Raum-Editieren ──────────────────────────────────────────────────────
    // (coalesceKey: siehe Kommentar bei moveGripOf.)
    moveRoomBy: (roomId, delta) => applyGrip({ op: "roomBy", id: roomId, delta: gripPt(delta) }, `moveRoomBy:${roomId}`),

    moveRoomGrip: (roomId, index, pt) =>
      applyGrip({ op: "roomGrip", id: roomId, index, pt: gripPt(pt) }, `moveRoomGrip:${roomId}:${index}`),

    moveRoomEdge: (roomId, aIndex, bIndex, delta) =>
      applyGrip(
        { op: "roomEdge", id: roomId, a: aIndex, b: bIndex, delta: gripPt(delta) },
        `moveRoomEdge:${roomId}:${aIndex}:${bIndex}`,
      ),

    updateRoom: (id, patch) =>
      applyChange((p) => mapRoom(p, id, (r) => ({ ...r, ...patch }))),

    moveRoomStamp: (roomId, delta) => applyGrip({ op: "roomStamp", id: roomId, delta: gripPt(delta) }),

    setRoomStampAnchor: (roomId, anchor) =>
      applyChange((p) => mapRoom(p, roomId, (r) => ({ ...r, stampAnchor: anchor }))),

    setRoomStampDoc: (roomId, doc) =>
      applyChange((p) => mapRoom(p, roomId, (r) => ({ ...r, stampDoc: doc }))),

    setRoomStamp: (roomId, stamp) =>
      applyChange((p) => mapRoom(p, roomId, (r) => ({ ...r, stamp }))),
  };
}

/** Immutabler Map über einen Raum (per ID); No-op ohne Treffer. */
function mapRoom(
  project: Project,
  roomId: string,
  fn: (r: import("../model/types").Room) => import("../model/types").Room,
): CoreOp[] {
  return patchItem(project, "rooms", roomId, fn);
}

/** Immutabler Map über eine Treppe (per ID); No-op ohne Treffer. */
function mapStair(
  project: Project,
  stairId: string,
  fn: (s: import("../model/types").Stair) => import("../model/types").Stair,
): CoreOp[] {
  return patchItem(project, "stairs", stairId, fn);
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
): CoreOp[] {
  const apply = <T extends { id: string }>(item: T): T => {
    if (value === null) {
      const { [field]: _omit, ...rest } = item as Record<string, unknown>;
      return rest as unknown as T;
    }
    return { ...item, [field]: value };
  };
  if (kind === "wall") return patchItem(project, "walls", id, apply);
  if (kind === "ceiling") return patchItem(project, "ceilings", id, apply);
  return patchItem(project, "drawings2d", id, apply);
}

function mapCeiling(
  project: Project,
  ceilingId: string,
  fn: (c: import("../model/types").Ceiling) => import("../model/types").Ceiling,
): CoreOp[] {
  return patchItem(project, "ceilings", ceilingId, fn);
}

/**
 * Fügt ein Bild-Zeichenelement (eingebettete Data-URL, z. B. Foto/Logo oder
 * gerasterte PDF-Seite) achsparallel bei `[at .. at+size]` an — analog zu den
 * Zeichenwerkzeugen, aber ohne Command (Datei-Auswahl ist async, s. App.tsx
 * Bild-/PDF-Import). Direkt selektiert zurückgegeben, damit Griffe/Objekt-Info
 * sofort zum Verschieben/Skalieren bereitstehen.
 */
export function imageDrawing2d(
  levelId: string,
  categoryCode: string,
  src: string,
  at: Vec2,
  widthM: number,
  heightM: number,
): Drawing2D {
  return {
    id: uniqueId("dr2d"),
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
}
