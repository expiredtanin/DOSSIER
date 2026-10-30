// Ressourcen-Manager — verwaltete Stil-Bibliotheken nach DOSSIER-Vorbild
// (Vectorworks-Stil): Bauteile, Schraffuren, Linien, Wand-/Decken-/Dachstile,
// Tür-/Fenster-/Treppentypen, Materialien und grafische Overrides in einer
// rechten Schublade (Drawer) mit mehreren Tabs.
//
// Diese Datei ist nur noch die SHELL: schwebendes/eingebettetes Fenster,
// Tab-Umschaltung, der `ResourceManagerHandlers`-Vertrag. Die eigentlichen
// Tabs (Rendering + Editor-Logik je Ressource) leben unter `resourceManager/`,
// je Domäne eine Datei — siehe dort für die konkreten Feldlisten.
//
// Reine Darstellung + Callbacks: alle Mutationen laufen immutabel über die
// vom App gereichten Handler (setProject). Plan & 3D leiten aus demselben
// Projekt ab und aktualisieren dadurch live — diese Komponente kennt weder
// Rendering noch Persistenz. Bezeichner englisch, UI-Text deutsch
// (CONVENTIONS.md).

import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  BuiltinPaletteBank,
  CeilingType,
  Component,
  DoorType,
  HatchStyle,
  LineStyle,
  OverrideRule,
  Project,
  RoofType,
  StairType,
  WallType,
  WindowType,
} from "../model/types";
import { EyeIcon } from "./EyeIcon";
import { t } from "../i18n";
import { ComponentsTab } from "./resourceManager/ComponentsTab";
import { HatchesTab } from "./resourceManager/HatchesTab";
import { StandardsUpdateDialog } from "./resourceManager/StandardsUpdateDialog";
import { LinesTab } from "./resourceManager/LinesTab";
import { CeilingStylesTab, RoofStylesTab, WallStylesTab } from "./resourceManager/LayeredStylesTab";
import { DoorStylesTab } from "./resourceManager/DoorStylesTab";
import { WindowStylesTab } from "./resourceManager/WindowStylesTab";
import { StairStylesTab } from "./resourceManager/StairStylesTab";
import { MaterialsTab } from "./resourceManager/MaterialsTab";
import { OverridesTab } from "./resourceManager/OverridesTab";
import { PenSetsTab } from "./resourceManager/PenSetsTab";
import { PalettesTab } from "./resourceManager/PalettesTab";
import { TextStylesTab } from "./resourceManager/TextStylesTab";
import { DEFAULT_PRESETS } from "../text/richText";
import type { TextStylePreset } from "../text/richText";

// ── Manager-Schublade ──────────────────────────────────────────────────────

export type TabId =
  | "components"
  | "hatches"
  | "lines"
  | "textStyles"
  | "wallStyles"
  | "ceilingStyles"
  | "roofStyles"
  | "doorStyles"
  | "windowStyles"
  | "stairStyles"
  | "materials"
  | "overrides"
  | "pens"
  | "palettes";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "components", labelKey: "resources.tab.components" },
  { id: "hatches", labelKey: "resources.tab.hatches" },
  { id: "lines", labelKey: "resources.tab.lines" },
  { id: "textStyles", labelKey: "resources.tab.textStyles" },
  { id: "pens", labelKey: "resources.tab.pens" },
  { id: "palettes", labelKey: "resources.tab.palettes" },
  { id: "wallStyles", labelKey: "resources.tab.wallStyles" },
  { id: "ceilingStyles", labelKey: "resources.tab.ceilingStyles" },
  { id: "roofStyles", labelKey: "resources.tab.roofStyles" },
  { id: "doorStyles", labelKey: "resources.tab.doorStyles" },
  { id: "windowStyles", labelKey: "resources.tab.windowStyles" },
  { id: "stairStyles", labelKey: "resources.tab.stairStyles" },
  { id: "materials", labelKey: "resources.tab.materials" },
  { id: "overrides", labelKey: "resources.tab.overrides" },
];

/** Bündel der immutablen Mutationen (von App über setProject bereitgestellt). */
export interface ResourceManagerHandlers {
  onPatchComponent: (id: string, patch: Partial<Component>) => void;
  onAddComponent: () => void;
  onDeleteComponent: (id: string) => void;
  onPatchHatch: (id: string, patch: Partial<HatchStyle>) => void;
  onAddHatch: () => void;
  onDeleteHatch: (id: string) => void;
  onPatchLineStyle: (id: string, patch: Partial<LineStyle>) => void;
  onAddLineStyle: () => void;
  onDeleteLineStyle: (id: string) => void;
  /** Wandstile: immutable Änderung eines Wandtyps (z. B. Schichtfugen-Stile). */
  onPatchWallType: (id: string, patch: Partial<WallType>) => void;
  onAddWallType: () => void;
  onDeleteWallType: (id: string) => void;
  /** Deckenstile: immutable Änderung eines Deckentyps (z. B. Schichtfugen-Stile). */
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
  onAddCeilingType: () => void;
  onDeleteCeilingType: (id: string) => void;
  /** Dachtypen (Dachaufbauten): immutable Änderung/Anlage/Löschung. */
  onPatchRoofType: (id: string, patch: Partial<RoofType>) => void;
  onAddRoofType: () => void;
  onDeleteRoofType: (id: string) => void;
  /** Import: fügt fertige (id-lose) Linienstile/Schraffuren hinzu (.lin/.pat). */
  onImportLineStyles: (styles: Omit<LineStyle, "id">[]) => void;
  onImportHatches: (hatches: Omit<HatchStyle, "id">[]) => void;
  /**
   * Textstil-Bibliothek (benannte Marks-Vorlagen, s. `Project.textStyles`).
   * Optional, damit ältere Einbettungen ohne diese Handler weiter kompilieren.
   */
  onPatchTextStyle?: (id: string, patch: Partial<TextStylePreset>) => void;
  onAddTextStyle?: () => void;
  onDeleteTextStyle?: (id: string) => void;
  /**
   * Grafische Override-Regeln: ersetzt die GANZE Regelliste (Reihenfolge =
   * Priorität). Optional, damit ältere Einbettungen ohne diesen Handler
   * weiter kompilieren — ohne Handler ist der Tab nur lesend.
   */
  onSetOverrideRules?: (rules: OverrideRule[]) => void;
  /**
   * Bauteil-Typen (Tür/Fenster/Treppe) — Bibliotheks-CRUD, analog Wand-/
   * Deckentypen. Optional, damit ältere Einbettungen ohne diesen Handler
   * weiter kompilieren; ohne Handler bleiben die Tabs verborgen.
   */
  onAddDoorType?: (preset?: DoorType) => void;
  onPatchDoorType?: (id: string, patch: Partial<DoorType>) => void;
  onDeleteDoorType?: (id: string) => void;
  onAddWindowType?: (preset?: WindowType) => void;
  onPatchWindowType?: (id: string, patch: Partial<WindowType>) => void;
  onDeleteWindowType?: (id: string) => void;
  onAddStairType?: () => void;
  onPatchStairType?: (id: string, patch: Partial<StairType>) => void;
  onDeleteStairType?: (id: string) => void;
  /**
   * Stiftsätze (ArchiCAD-Stiftsatz-Muster, s. `model/penSets.ts`). Optional,
   * damit ältere Einbettungen ohne diese Handler weiter kompilieren; ohne
   * Handler bleibt der Tab nur lesend (Aktiv-Anzeige, keine Editier-Buttons).
   */
  onAddPen?: () => void;
  onRenamePen?: (id: string, name: string) => void;
  onDeletePen?: (id: string) => void;
  onAddPenSet?: () => void;
  onRenamePenSet?: (id: string, name: string) => void;
  onDeletePenSet?: (id: string) => void;
  onSetActivePenSet?: (id: string) => void;
  onPatchPenSetColor?: (setId: string, penId: string, color: string) => void;
  onPatchPenSetWeight?: (setId: string, penId: string, weight: number) => void;
  /** Ersetzt `pens`/legt einen neuen Satz mit der 255er-CAD-Standardpalette an. */
  onSeedStandardPenSet?: () => void;
  /** Ergänzt die fehlenden SIA-400-Standards ([100]–[102], „Standards laden"). */
  onLoadStandards?: () => void;
  /** „Standards aktualisieren" ([109]): bringt die gewählten Standard-Einträge (`"<Liste>:<id>"`) auf den heutigen Stand. */
  onUpdateStandards?: (selected: string[]) => void;
  /**
   * Farbpaletten (Tab „Paletten"): eigene Paletten verwalten + Sichtbarkeit
   * der Bänke im Farbwahl-Popover. Optional wie die Stift-Handler.
   */
  onAddCustomPalette?: () => void;
  onRenameCustomPalette?: (id: string, name: string) => void;
  onDeleteCustomPalette?: (id: string) => void;
  onRemoveColorFromCustomPalette?: (paletteId: string, hex: string) => void;
  onSetCustomPaletteVisible?: (id: string, visible: boolean) => void;
  onSetBuiltinPaletteVisible?: (bank: BuiltinPaletteBank, visible: boolean) => void;
  /** „+"-Zelle im Farbwahl-Raster: aktuelle Farbe in einer eigenen Palette ablegen. */
  onAddColorToCustomPalette?: (paletteId: string | undefined, hex: string) => void;
}

// ── Schwebendes Fenster (nicht-modal) ──────────────────────────────────────
// Der Ressourcen-Manager schwebt frei über dem Grundriss, OHNE abdunkelnden
// Hintergrund: der Plan bleibt bedienbar, damit Schraffur-/Linien-Änderungen
// live am Modell sichtbar sind. Position/Größe leben lokal im Fenster; die
// Kopfzeile (res-head) ist der Verschiebegriff, unten rechts sitzt ein
// Größen-Greifer — beide über POINTER-Events mit Pointer-Capture (dieselbe
// Technik wie FloatingPanel), damit die Geste auch außerhalb weiterläuft.

/** Standard- und Mindestgröße des schwebenden Ressourcen-Fensters (CSS-Pixel). */
const RES_DEFAULT_W = 760;
const RES_DEFAULT_H = 640;
const RES_MIN_W = 420;
const RES_MIN_H = 320;

/** Rechteck eines frei positionierten Fensters. */
interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sinnvolle Startlage: rechts oben unter der Oberleiste, in den Viewport geklemmt. */
function initialRect(): WindowRect {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(RES_DEFAULT_W, Math.round(vw * 0.9));
  const h = Math.min(RES_DEFAULT_H, Math.round(vh * 0.85));
  const x = Math.max(16, vw - w - 24);
  const y = 64;
  return { x, y, w, h };
}

/**
 * Rechte Schublade mit mehreren Tabs (Bauteile / Schraffuren / Linien / …). Wird
 * über den „Ressourcen"-Eintrag der Oberleiste geöffnet und mutiert das Projekt
 * live über die gereichten Handler. Rendert als FREI SCHWEBENDES, nicht-modales
 * Fenster (kein Backdrop) — verschiebbar über die Kopfzeile, größenveränderbar
 * über den Greifer unten rechts.
 */
export function ResourceManager({
  project,
  onClose,
  handlers,
  initialTab,
  windowed = false,
}: {
  project: Project;
  onClose: () => void;
  handlers: ResourceManagerHandlers;
  /** Beim Öffnen (bzw. bei erneutem Sprung) direkt aktiver Tab, z. B. „doorStyles". */
  initialTab?: TabId;
  /**
   * Läuft in einem EIGENEN nativen Fenster (siehe native/resourceWindow.ts)
   * statt als schwebendes Overlay im Hauptfenster: füllt die Fensterfläche
   * komplett (kein eigenes Verschieben/Grössenändern per JS — das übernimmt
   * das OS-Fenster), Kopfzeile bleibt nur als Tab-Träger ohne Drag-Cursor.
   */
  windowed?: boolean;
}) {
  const [tab, setTab] = useState<TabId>(initialTab ?? "components");
  // Erneuter Sprung aus einem Element heraus (z. B. „Typ bearbeiten" an einer
  // Öffnung): auf den angeforderten Tab wechseln, auch wenn das Fenster schon offen ist.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [rect, setRect] = useState<WindowRect>(initialRect);
  const [updateStandardsOpen, setUpdateStandardsOpen] = useState(false);

  // Verschieben über die Kopfzeile: Cursor − linke/obere Kante festhalten und die
  // Kante der Cursorbewegung folgen lassen (Pointer-Capture hält die Geste).
  const onTitlePointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    // Klicks auf Knöpfe (Schließen) nicht als Verschiebe-Start werten.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const dx = e.clientX - rect.x;
    const dy = e.clientY - rect.y;
    const move = (ev: PointerEvent) => {
      setRect((r) => ({ ...r, x: ev.clientX - dx, y: ev.clientY - dy }));
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // Größe ändern über den Greifer unten rechts (Deltas ab Startpunkt, Mindestmaß).
  const onResizePointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.w;
    const startH = rect.h;
    const move = (ev: PointerEvent) => {
      const w = Math.max(RES_MIN_W, Math.round(startW + (ev.clientX - startX)));
      const h = Math.max(RES_MIN_H, Math.round(startH + (ev.clientY - startY)));
      setRect((r) => ({ ...r, w, h }));
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
      <aside
        className={`res-window${windowed ? " res-window-embedded" : ""}`}
        role="dialog"
        aria-label={t("resources.label")}
        style={
          windowed
            ? undefined
            : {
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.w}px`,
                height: `${rect.h}px`,
              }
        }
      >
        <header
          className="res-head"
          onPointerDown={windowed ? undefined : onTitlePointerDown}
          // Im eigenen nativen Fenster (randlos, s. BORDERLESS_WINDOW_CHROME)
          // ist diese Kopfzeile der einzige Ziehbereich — genau wie die
          // TopBar des Hauptfensters (`data-tauri-drag-region`). Ohne OS-
          // Titelzeile bleibt so trotzdem EIN Griff zum Verschieben.
          {...(windowed ? { "data-tauri-drag-region": true } : {})}
        >
          <div className="res-head-title">
            <span className="res-head-icon">
              <EyeIcon open />
            </span>
            {t("resources.title")}
          </div>
          {handlers.onLoadStandards && (
            <button
              className="res-add res-load-standards"
              title={t("resources.loadStandards.hint")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => handlers.onLoadStandards?.()}
            >
              {t("resources.loadStandards")}
            </button>
          )}
          {handlers.onUpdateStandards && (
            <button
              className="res-add res-update-standards"
              title={t("resources.updateStandards.hint")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setUpdateStandardsOpen(true)}
            >
              {t("resources.updateStandards")}
            </button>
          )}
          {!windowed && (
            <button
              className="res-close"
              onClick={onClose}
              aria-label={t("resources.close")}
            >
              ×
            </button>
          )}
        </header>

        <nav className="res-tabs" role="tablist">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              role="tab"
              aria-selected={tab === tabDef.id}
              className={`res-tab-btn${tab === tabDef.id ? " active" : ""}`}
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </nav>

        <div className="res-body">
          {tab === "components" && (
            <ComponentsTab
              project={project}
              onPatchComponent={handlers.onPatchComponent}
              onAddComponent={handlers.onAddComponent}
              onDeleteComponent={handlers.onDeleteComponent}
              onAddColorToCustomPalette={handlers.onAddColorToCustomPalette}
            />
          )}
          {tab === "hatches" && (
            <HatchesTab
              project={project}
              onPatchHatch={handlers.onPatchHatch}
              onAddHatch={handlers.onAddHatch}
              onDeleteHatch={handlers.onDeleteHatch}
              onImportHatches={handlers.onImportHatches}
            />
          )}
          {tab === "lines" && (
            <LinesTab
              project={project}
              onPatchLineStyle={handlers.onPatchLineStyle}
              onAddLineStyle={handlers.onAddLineStyle}
              onDeleteLineStyle={handlers.onDeleteLineStyle}
              onImportLineStyles={handlers.onImportLineStyles}
            />
          )}
          {tab === "textStyles" && handlers.onPatchTextStyle && handlers.onAddTextStyle && handlers.onDeleteTextStyle && (
            <TextStylesTab
              styles={project.textStyles ?? DEFAULT_PRESETS}
              onPatchTextStyle={handlers.onPatchTextStyle}
              onAddTextStyle={handlers.onAddTextStyle}
              onDeleteTextStyle={handlers.onDeleteTextStyle}
            />
          )}
          {tab === "wallStyles" && (
            <WallStylesTab
              project={project}
              onPatchWallType={handlers.onPatchWallType}
              onAddWallType={handlers.onAddWallType}
              onDeleteWallType={handlers.onDeleteWallType}
            />
          )}
          {tab === "ceilingStyles" && (
            <CeilingStylesTab
              project={project}
              onPatchCeilingType={handlers.onPatchCeilingType}
              onAddCeilingType={handlers.onAddCeilingType}
              onDeleteCeilingType={handlers.onDeleteCeilingType}
            />
          )}
          {tab === "roofStyles" && (
            <RoofStylesTab
              project={project}
              onPatchRoofType={handlers.onPatchRoofType}
              onAddRoofType={handlers.onAddRoofType}
              onDeleteRoofType={handlers.onDeleteRoofType}
            />
          )}
          {tab === "doorStyles" && (
            <DoorStylesTab
              project={project}
              onAddDoorType={handlers.onAddDoorType}
              onPatchDoorType={handlers.onPatchDoorType}
              onDeleteDoorType={handlers.onDeleteDoorType}
            />
          )}
          {tab === "windowStyles" && (
            <WindowStylesTab
              project={project}
              onAddWindowType={handlers.onAddWindowType}
              onPatchWindowType={handlers.onPatchWindowType}
              onDeleteWindowType={handlers.onDeleteWindowType}
            />
          )}
          {tab === "stairStyles" && (
            <StairStylesTab
              project={project}
              onAddStairType={handlers.onAddStairType}
              onPatchStairType={handlers.onPatchStairType}
              onDeleteStairType={handlers.onDeleteStairType}
            />
          )}
          {tab === "pens" && (
            <PenSetsTab
              project={project}
              onAddPen={handlers.onAddPen}
              onRenamePen={handlers.onRenamePen}
              onDeletePen={handlers.onDeletePen}
              onAddPenSet={handlers.onAddPenSet}
              onRenamePenSet={handlers.onRenamePenSet}
              onDeletePenSet={handlers.onDeletePenSet}
              onSetActivePenSet={handlers.onSetActivePenSet}
              onPatchPenSetColor={handlers.onPatchPenSetColor}
              onPatchPenSetWeight={handlers.onPatchPenSetWeight}
              onSeedStandardPenSet={handlers.onSeedStandardPenSet}
              onAddColorToCustomPalette={handlers.onAddColorToCustomPalette}
            />
          )}
          {tab === "palettes" && (
            <PalettesTab
              project={project}
              onAddCustomPalette={handlers.onAddCustomPalette}
              onRenameCustomPalette={handlers.onRenameCustomPalette}
              onDeleteCustomPalette={handlers.onDeleteCustomPalette}
              onRemoveColorFromCustomPalette={handlers.onRemoveColorFromCustomPalette}
              onSetCustomPaletteVisible={handlers.onSetCustomPaletteVisible}
              onSetBuiltinPaletteVisible={handlers.onSetBuiltinPaletteVisible}
            />
          )}
          {tab === "materials" && <MaterialsTab />}
          {tab === "overrides" && (
            <OverridesTab
              project={project}
              onSetOverrideRules={handlers.onSetOverrideRules}
            />
          )}
        </div>

        {updateStandardsOpen && handlers.onUpdateStandards && (
          <StandardsUpdateDialog
            project={project}
            onApply={(sel) => handlers.onUpdateStandards?.(sel)}
            onClose={() => setUpdateStandardsOpen(false)}
          />
        )}

        {/* Greifer unten rechts (Größe ändern) — im eigenen OS-Fenster übernimmt
            das Betriebssystem das Grössenändern, daher windowed ohne Greifer. */}
        {!windowed && (
          <div
            className="floating-resize res-resize"
            role="separator"
            aria-label={t("dock.resizePanel")}
            title={t("dock.resizePanel")}
            onPointerDown={onResizePointerDown}
          />
        )}
      </aside>
  );
}
