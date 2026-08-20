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
import { LinesTab } from "./resourceManager/LinesTab";
import { CeilingStylesTab, RoofStylesTab, WallStylesTab } from "./resourceManager/LayeredStylesTab";
import { DoorStylesTab } from "./resourceManager/DoorStylesTab";
import { WindowStylesTab } from "./resourceManager/WindowStylesTab";
import { StairStylesTab } from "./resourceManager/StairStylesTab";
import { MaterialsTab } from "./resourceManager/MaterialsTab";
import { OverridesTab } from "./resourceManager/OverridesTab";

// ── Manager-Schublade ──────────────────────────────────────────────────────

export type TabId =
  | "components"
  | "hatches"
  | "lines"
  | "wallStyles"
  | "ceilingStyles"
  | "roofStyles"
  | "doorStyles"
  | "windowStyles"
  | "stairStyles"
  | "materials"
  | "overrides";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "components", labelKey: "resources.tab.components" },
  { id: "hatches", labelKey: "resources.tab.hatches" },
  { id: "lines", labelKey: "resources.tab.lines" },
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
  onAddDoorType?: () => void;
  onPatchDoorType?: (id: string, patch: Partial<DoorType>) => void;
  onDeleteDoorType?: (id: string) => void;
  onAddWindowType?: () => void;
  onPatchWindowType?: (id: string, patch: Partial<WindowType>) => void;
  onDeleteWindowType?: (id: string) => void;
  onAddStairType?: () => void;
  onPatchStairType?: (id: string, patch: Partial<StairType>) => void;
  onDeleteStairType?: (id: string) => void;
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
          {tab === "materials" && <MaterialsTab />}
          {tab === "overrides" && (
            <OverridesTab
              project={project}
              onSetOverrideRules={handlers.onSetOverrideRules}
            />
          )}
        </div>

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
