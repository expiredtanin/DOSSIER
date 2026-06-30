// Oberleiste (Top-Bar) — MVP nach docs/design/topbar-footer.md.
//
// Gruppen (links → rechts): Marke · Ansichts-Umschalter (Grundriss/Perspektive)
// · Detailgrad (grob/mittel/fein) · Massstab „1:N" + Zoom (Einpassen/Auswahl/
// 100 %) · Render-Modus · Referenzlinien-Toggle · Layout-Menü · Ressourcen.
//
// Die Leiste ist rein gesteuert (controlled): alle Zustände kommen als Props
// aus App, Aktionen melden sich über Callbacks zurück. Bezeichner englisch,
// UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { ReactNode } from "react";
import type { Project } from "../model/types";
import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Dropdown } from "./Dropdown";
import type { DropdownItem, DropdownOption } from "./Dropdown";

/** Ansichtstyp eines Geschosses (wie in App). */
export type ViewType = "grundriss" | "perspektive";

/**
 * Detailgrad der Darstellung (≙ DOSSIER Einfach/Standard/Detail). Wirkt im
 * Grundriss auf Tür-/Fenstersymbole + Schraffuren/Linienfeinheit (siehe
 * generatePlan.DetailLevel); in der Perspektive noch ohne Wirkung (deferred).
 */
export type DetailLevel = "grob" | "mittel" | "fein";

/**
 * Render-/Anzeigemodus der 3D-Ansicht: schattiert, einheitlich weiss (Clay-Look),
 * Drahtgitter, Verdeckte Kanten (Hidden-Line). Wirkt nur in der Perspektive.
 */
export type RenderMode = "shaded" | "white" | "wireframe" | "hidden";

/**
 * Kanonischer Blickwinkel der 3D-Ansicht (Vectorworks/DOSSIER-Stil). „front",
 * „top", „side", „iso" springen auf die jeweilige Standardansicht; „perspective"
 * ist der freie 3/4-Blick. Wirkt nur in der Perspektive.
 */
export type View3d = "front" | "top" | "side" | "iso" | "perspective";

/**
 * Farb-Modus des Grundrisses: „color" zeigt Kategorie-/Element-Farben (heutiges
 * Verhalten), „mono" erzeugt einen reinen Schwarz-Weiss-Plan. Wirkt nur im
 * Grundriss (orthogonal zum Linien-Modus Display/Print).
 */
export type PlanColorMode = "color" | "mono";

/**
 * Massstab-Presets „1:N" (Nenner). `null` steht für „frei" (benutzerdefiniert,
 * per Eingabe). Quelle für die Anzeige in Top-Bar und Status-Leiste.
 */
export const SCALE_PRESETS: number[] = [1, 5, 10, 20, 50, 100, 200, 500, 1000];

export interface TopBarProps {
  project: Project;

  // Ansicht.
  /** Ob der Ansichts-Umschalter sinnvoll ist (nur für Geschosse). */
  viewToggleEnabled: boolean;
  viewType: ViewType;
  onViewType: (v: ViewType) => void;

  // 3D-Ansicht: kanonischer Blickwinkel + Kamera-Sichtwinkel (FOV). Wirkt nur in
  // der Perspektive; ein Preset-Klick wechselt nötigenfalls auch dorthin.
  view3d: View3d;
  onView3d: (v: View3d) => void;
  /** Sichtwinkel der Perspektivkamera in Grad (Kamera-Einstellungen). */
  fov: number;
  onFov: (n: number) => void;

  // Zeichenwerkzeuge (Auswahl/Wand/Linie …), Wandtyp-Wahl und Fang-Menü leben
  // jetzt in der Werkzeug-Palette (ToolsPanel), nicht mehr in der Oberleiste.

  // Detailgrad.
  detail: DetailLevel;
  onDetail: (d: DetailLevel) => void;
  /** Detailgrad wirkt nur, wenn ein Plan gezeichnet wird (sonst deaktiviert). */
  detailEnabled: boolean;

  // Massstab + Zoom.
  /**
   * Gewählter (angewandter) Papier-Massstab-Nenner (1:N) — steuert das Dropdown
   * und „100 %". Setzt beim Wählen den Plan-Zoom auf exakt 1:N.
   */
  scaleDenominator: number;
  /** Einen Papier-Massstab anwenden (Preset/frei): setzt N + Plan-Zoom. */
  onApplyScale: (n: number) => void;
  /**
   * LIVE Papier-Massstab-Nenner aus der aktuellen View-Transform (ändert sich
   * beim Wheel-Zoom) oder `null`, wenn keine Plan-Ansicht aktiv ist.
   */
  liveScale: number | null;
  /** Live-Zoom in Prozent (aus der Plan-View-Transform). */
  zoomPercent: number;
  /** Zoom-Aktionen — nur wirksam, wenn eine Plan-Ansicht aktiv ist. */
  zoomEnabled: boolean;
  onFit: () => void;
  onFitSelection: () => void;
  onZoom100: () => void;

  // Darstellungsart — kontextabhängig: Perspektive nutzt `renderMode`,
  // Grundriss nutzt `planColorMode`. Genau einer der beiden ist je View aktiv.
  renderMode: RenderMode;
  onRenderMode: (m: RenderMode) => void;
  /** Render-Modus nur in der Perspektive sinnvoll (sonst deaktiviert). */
  renderModeEnabled: boolean;

  // Farb-Modus des Grundrisses (Farbig ↔ Schwarz-Weiss). Nur im Grundriss.
  planColorMode: PlanColorMode;
  onPlanColorMode: (m: PlanColorMode) => void;

  // Referenzlinien (Wandachsen).
  referenceLines: boolean;
  onReferenceLines: (on: boolean) => void;
  /** Referenzlinien nur im Grundriss sinnvoll (sonst deaktiviert). */
  referenceLinesEnabled: boolean;

  // Linien-Darstellung: Display (Haarlinien) ↔ Print (echte mm-Strichstärken).
  lineMode: "display" | "print";
  onLineMode: (m: "display" | "print") => void;
  /** Nur im Grundriss sinnvoll. */
  lineModeEnabled: boolean;

  // Sichtbarkeits-Kombinationen (Ebenen-/Zeichnungskombinationen).
  /** Handler-Satz für die beiden Kombinations-Dropdowns. */
  combos: ComboMenuHandlers;

  // Ressourcen-Fenster.
  resourcesOpen: boolean;
  onToggleResources: () => void;

  /** Layout-Menü (von App geliefert, damit dessen Logik dort bleibt). */
  layoutMenu: ReactNode;
}

/**
 * Verdrahtung der beiden Kombinations-Dropdowns (Vectorworks-Stil). App liefert
 * die Speicher-/Lade-/Lösch-Logik; die Komponente bleibt rein gesteuert.
 */
export interface ComboMenuHandlers {
  // Ebenen-Kombinationen.
  listLayerCombos: () => string[];
  saveLayerCombo: (name: string) => void;
  loadLayerCombo: (name: string) => void;
  deleteLayerCombo: (name: string) => void;
  // Zeichnungs-Kombinationen.
  listDrawingCombos: () => string[];
  saveDrawingCombo: (name: string) => void;
  loadDrawingCombo: (name: string) => void;
  deleteDrawingCombo: (name: string) => void;
}

/** Kleiner vertikaler Trenner zwischen Gruppen. */
function Sep() {
  return <span className="tb-sep" aria-hidden="true" />;
}

/**
 * Kleines Kombinations-Menü (Vectorworks-Stil) — gespiegelt von `LayoutMenu`:
 * aktuelle Sichtbarkeit unter einem Namen sichern, eine gespeicherte Kombination
 * wählen (laden) oder löschen. Die Namen werden frisch gelesen, sobald das Menü
 * geöffnet wird (onFocus/onMouseDown). Rein gesteuert: alle Aktionen kommen über
 * die Callbacks zurück. Wiederverwendbar für Ebenen- UND Zeichnungskombinationen.
 */
function ComboMenu({
  title,
  savePrompt,
  list,
  onSave,
  onLoad,
  onDelete,
}: {
  /** Tooltip/aria-label des Dropdowns. */
  title: string;
  /** Prompt-Text beim Speichern. */
  savePrompt: string;
  list: () => string[];
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  // Namen werden frisch gelesen, sobald das Menü gebaut wird (beim Render des
  // Triggers reicht nicht — wir lesen bei jedem Öffnen über `refresh`). Da das
  // Dropdown gesteuert ist, halten wir die aktuelle Liste im State und
  // aktualisieren sie beim Trigger-Klick (siehe `items`-Aufbau unten).
  const [names, setNames] = useState<string[]>([]);

  const refresh = () => setNames(list());

  const save = () => {
    const name = window.prompt(savePrompt);
    if (!name) return;
    onSave(name.trim());
    refresh();
  };

  // Aktions-Menü (analog ContextMenu-Items): „Aktuelle speichern" oben, dann je
  // eine Gruppe „Laden" und „Löschen" (danach Trenner). Das Häkchen entfällt
  // hier (kein „Wert"); Löschen ist als danger-Item markiert.
  const items: DropdownItem[] = [];
  items.push({ label: t("combo.saveCurrent"), onSelect: save });
  if (names.length > 0) {
    items.push({ divider: true });
    for (const n of names) {
      items.push({ label: n, onSelect: () => onLoad(n) });
    }
    items.push({ divider: true });
    for (const n of names) {
      items.push({
        label: `✕ ${n}`,
        danger: true,
        onSelect: () => {
          onDelete(n);
          refresh();
        },
      });
    }
  }

  return (
    <span onPointerDownCapture={refresh}>
      <Dropdown
        items={items}
        placeholder={t("combo.placeholder")}
        title={title}
      />
    </span>
  );
}

/**
 * Kamera-Einstellungen als kleines Popover (Vectorworks-Stil): ein FOV-Regler
 * für den Sichtwinkel der Perspektivkamera. Öffnet/schliesst per Button; ein
 * Klick ausserhalb schliesst es. Rein gesteuert über `fov`/`onFov`.
 */
function CameraMenu({
  fov,
  onFov,
  disabled,
}: {
  fov: number;
  onFov: (n: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Popover-Position (fixed), aus dem Button-Rect berechnet — die Oberleiste
  // hat overflow:hidden und würde ein absolut positioniertes Popover abschneiden.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6 });
    }
    setOpen(next);
  };

  return (
    <div className="tb-popwrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className={`view-icon${open ? " active" : ""}`}
        disabled={disabled}
        onClick={toggle}
        title={`${t("view3d.camera")} — ${t("view3d.camera.hint")}`}
        aria-label={t("view3d.camera")}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <ViewIcon name="camera" />
      </button>
      {open && !disabled && (
        <div
          className="tb-popover"
          role="dialog"
          aria-label={t("view3d.camera")}
          style={{ left: pos.left, top: pos.top }}
        >
          <label className="tb-poprow">
            <span className="tb-label">
              {t("view3d.fov")}: {Math.round(fov)}°
            </span>
            <input
              type="range"
              min={20}
              max={90}
              step={1}
              value={fov}
              onChange={(e) => onFov(Number(e.target.value))}
              title={t("view3d.fov.hint")}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Parst eine Massstab-Eingabe „1:35" ODER „35" zum Nenner N (gerundet, > 0).
 * Liefert null bei ungültiger/leerer Eingabe.
 */
function parseScaleInput(input: string | null): number | null {
  if (!input) return null;
  // Teil nach einem ':' nehmen, falls vorhanden („1:35" → „35").
  const raw = input.includes(":") ? input.split(":").pop() ?? "" : input;
  const n = Math.round(Number(raw.trim()));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Kleines Vektor-Icon je 3D-Ansicht (16×16, currentColor). Front/Oben/Seite als
 * Quadrat mit Mittellinie (keine/horizontal/vertikal), Perspektive/Isometrie als
 * Würfel, Kamera als Kamera-Glyph. Tooltip nennt die Bedeutung im Klartext.
 */
function ViewIcon({ name }: { name: View3d | "camera" | "grundriss" }) {
  const s = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "grundriss":
      // Grundriss (2D-Plan): Rechteck mit zwei inneren Wandstummeln + Türlücke.
      return (
        <svg {...s}>
          <rect x="2.5" y="2.5" width="11" height="11" />
          <path d="M2.5 9.5 L6 9.5 M9 9.5 L13.5 9.5 M9 9.5 L9 13.5" />
        </svg>
      );
    case "front":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
        </svg>
      );
    case "top":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
          <line x1="3.5" y1="8" x2="12.5" y2="8" />
        </svg>
      );
    case "side":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
          <line x1="8" y1="3.5" x2="8" y2="12.5" />
        </svg>
      );
    case "perspective":
      return (
        <svg {...s}>
          <rect x="2.5" y="6" width="7" height="7" />
          <path d="M9.5 6 L13.5 3 M9.5 13 L13.5 10 M2.5 6 L6.5 3 L13.5 3 L13.5 10" />
        </svg>
      );
    case "iso":
      return (
        <svg {...s}>
          <path d="M8 2 L14 5.5 L14 10.5 L8 14 L2 10.5 L2 5.5 Z M8 8 L8 14 M8 8 L14 5.5 M8 8 L2 5.5" />
        </svg>
      );
    case "camera":
      return (
        <svg {...s}>
          <rect x="2.5" y="5.5" width="11" height="7.5" rx="1" />
          <path d="M6 5.5 L7 3.5 L9 3.5 L10 5.5" />
          <circle cx="8" cy="9.2" r="2.1" />
        </svg>
      );
  }
}

export function TopBar({
  project,
  viewToggleEnabled,
  viewType,
  onViewType,
  view3d,
  onView3d,
  fov,
  onFov,
  detail,
  onDetail,
  detailEnabled,
  scaleDenominator,
  onApplyScale,
  liveScale,
  zoomPercent,
  zoomEnabled,
  onFit,
  onFitSelection,
  onZoom100,
  renderMode,
  onRenderMode,
  renderModeEnabled,
  planColorMode,
  onPlanColorMode,
  referenceLines,
  onReferenceLines,
  referenceLinesEnabled,
  lineMode,
  onLineMode,
  lineModeEnabled,
  combos,
  resourcesOpen,
  onToggleResources,
  layoutMenu,
}: TopBarProps) {
  // Dezente Scrollleiste: die Oberleiste scrollt horizontal (overflow-x). Statt
  // der prägnanten Standard-Leiste blenden wir eine eigene, sehr ruhige Leiste
  // NUR während des Scrollens ein (Klasse `is-scrolling`, ~900 ms nachlaufend).
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      el.classList.add("is-scrolling");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("is-scrolling"), 900);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // „frei" wird über einen Prompt erfasst; akzeptiert „1:35" ODER „35".
  const onScaleChange = (value: string) => {
    if (value === "__custom__") {
      const input = window.prompt(
        t("topbar.scale.prompt"),
        `1:${scaleDenominator}`,
      );
      const n = parseScaleInput(input);
      if (n != null) onApplyScale(n);
      return;
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) onApplyScale(n);
  };

  // Aktueller Nenner steht evtl. nicht in den Presets (frei gesetzt) → dann
  // einen Eintrag „1:N" voranstellen, damit das Select den Wert anzeigt.
  const inPresets = SCALE_PRESETS.includes(scaleDenominator);

  // Optionsliste des Massstab-Dropdowns: ggf. der frei gesetzte aktuelle Wert
  // (damit er sichtbar bleibt), dann die Presets, zuletzt „frei …" als
  // Sonder-Wert, der über onScaleChange den Prompt öffnet (Funktion unverändert).
  const scaleOptions: DropdownOption[] = [
    ...(inPresets
      ? []
      : [{ value: "__current__", label: `1:${scaleDenominator}` }]),
    ...SCALE_PRESETS.map((n) => ({ value: String(n), label: `1:${n}` })),
    { value: "__custom__", label: t("topbar.scale.custom") },
  ];

  return (
    <header className="topbar" ref={headerRef}>
      {/* Marke/Logo. */}
      <div className="brand">
        <span className="logo">▦</span> cad{" "}
        <span className="tag">{t("brand.tag")}</span>
      </div>

      <Sep />

      {/* Ansichten als EIN kompaktes Icon-Grid (Vectorworks/DOSSIER-Stil): der
          2D-Grundriss UND die 3D-Blicke sind eine durchgängige Icon-Serie —
          „Grundriss" schaltet auf den 2D-Plan, die übrigen auf die jeweilige
          3D-Ansicht (Perspektive wird dabei automatisch aktiviert). 4 oben /
          3 unten. Tooltip nennt jede Ansicht im Klartext. */}
      {viewToggleEnabled && (
        <>
          <div className="tb-group" role="group" aria-label={t("topbar.viewGroup")}>
            <div className="view-grid view-grid-4">
              <button
                className={`view-icon${viewType === "grundriss" ? " active" : ""}`}
                onClick={() => onViewType("grundriss")}
                title={t("topbar.grundriss")}
                aria-label={t("topbar.grundriss")}
              >
                <ViewIcon name="grundriss" />
              </button>
              {(
                [
                  ["top", t("view3d.top")],
                  ["iso", t("view3d.iso")],
                  ["perspective", t("view3d.perspective")],
                  ["front", t("view3d.front")],
                  ["side", t("view3d.side")],
                ] as [View3d, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`view-icon${
                    viewType === "perspektive" && view3d === key ? " active" : ""
                  }`}
                  onClick={() => {
                    onView3d(key);
                    if (viewType !== "perspektive") onViewType("perspektive");
                  }}
                  title={`${label} — ${t(`view3d.${key}.hint`)}`}
                  aria-label={label}
                >
                  <ViewIcon name={key} />
                </button>
              ))}
              <CameraMenu
                fov={fov}
                onFov={onFov}
                disabled={viewType !== "perspektive"}
              />
            </div>
          </div>
          <Sep />
        </>
      )}

      {/* Sichtbarkeits-Kombinationen (Vectorworks: Ebenen-/Zeichnungs-
          kombinationen). Sitzt direkt nach dem Ansichts-Umschalter, weil beides
          „Navigations-/Sicht"-Steuerung ist — ruhige Stelle vor dem Detailgrad.
          Nur die Dropdowns; eine grafische Überschreibung kommt später. */}
      <div className="tb-group tb-stack" role="group" aria-label={t("combo.layers.title")}>
        <label className="tb-field tb-field-row">
          <span className="tb-label">{t("combo.layers")}</span>
          <ComboMenu
            title={t("combo.layers.title")}
            savePrompt={t("combo.layers.savePrompt")}
            list={combos.listLayerCombos}
            onSave={combos.saveLayerCombo}
            onLoad={combos.loadLayerCombo}
            onDelete={combos.deleteLayerCombo}
          />
        </label>
        <label className="tb-field tb-field-row">
          <span className="tb-label">{t("combo.drawings")}</span>
          <ComboMenu
            title={t("combo.drawings.title")}
            savePrompt={t("combo.drawings.savePrompt")}
            list={combos.listDrawingCombos}
            onSave={combos.saveDrawingCombo}
            onLoad={combos.loadDrawingCombo}
            onDelete={combos.deleteDrawingCombo}
          />
        </label>
      </div>

      <Sep />

      {/* Zeichenwerkzeuge liegen jetzt in der Werkzeug-Palette (ToolsPanel,
          dockbar) — nicht mehr in der Oberleiste (Vectorworks-Bild: Werkzeuge
          in der Palette). Auch Wandtyp-Wahl + Fang-Menü sind dort. */}

      {/* Detailgrad (grob/mittel/fein) — wirkt im Grundriss auf Symbole +
          Schraffuren/Linien. In der Perspektive (noch) ohne Wirkung → dort
          deaktiviert mit Tooltip statt stiller No-Op. */}
      <div className="tb-group" role="group" aria-label={t("topbar.detailGroup")}>
        <label className="tb-field">
          <span className="tb-label">{t("topbar.detail")}</span>
          <Dropdown
            value={detail}
            disabled={!detailEnabled}
            onChange={(v) => onDetail(v as DetailLevel)}
            title={
              detailEnabled
                ? t("topbar.detail.hint")
                : t("topbar.detail.hintDisabled")
            }
            options={[
              { value: "grob", label: t("topbar.detail.grob") },
              { value: "mittel", label: t("topbar.detail.mittel") },
              { value: "fein", label: t("topbar.detail.fein") },
            ]}
          />
        </label>
      </div>

      <Sep />

      {/* Massstab „1:N" (echter Papier-Massstab) + Zoom-Buttons. Das Dropdown
          zeigt den gewählten/angewandten Massstab; rechts steht der LIVE 1:N
          aus der View-Transform (ändert sich beim Zoomen). Nur aktiv, wenn ein
          Plan gezeichnet wird (Perspektive zeigt „—"). */}
      <div className="tb-group" role="group" aria-label={t("topbar.scaleGroup")}>
        <label className="tb-field">
          <span className="tb-label">{t("topbar.scale")}</span>
          <Dropdown
            value={inPresets ? String(scaleDenominator) : "__current__"}
            disabled={!zoomEnabled}
            onChange={onScaleChange}
            title={t("topbar.scale.apply")}
            triggerClassName="tb-dd-mono"
            options={scaleOptions}
          />
        </label>
        <span className="tb-live-scale" title={t("topbar.scale.live")}>
          {zoomEnabled && liveScale != null ? `1:${Math.round(liveScale)}` : "—"}
        </span>
        <div className="tb-btns">
          <button
            className="tb-btn"
            onClick={onZoom100}
            disabled={!zoomEnabled}
            title={t("topbar.zoom100.hint", { n: scaleDenominator })}
          >
            {t("topbar.zoom100")}
          </button>
          <button
            className="tb-btn"
            onClick={onFit}
            disabled={!zoomEnabled}
            title={t("topbar.fit.hint")}
          >
            {t("topbar.fit")}
          </button>
          <button
            className="tb-btn"
            onClick={onFitSelection}
            disabled={!zoomEnabled}
            title={t("topbar.fitSelection.hint")}
          >
            {t("topbar.fitSelection")}
          </button>
        </div>
        <span className="tb-zoom" title={t("topbar.zoom.current")}>
          {zoomEnabled ? `${Math.round(zoomPercent)}%` : "—"}
        </span>
      </div>

      <Sep />

      {/* Darstellungsart (Vectorworks-Stil) — EIN Dropdown, dessen Optionen vom
          Ansichtstyp abhängen: Grundriss → Farbig/Schwarz-Weiss (planColorMode);
          Perspektive → Schattiert/Weiss/Drahtgitter/Kanten (renderMode). Der
          Linien-Modus (Display/Print) bleibt separat. */}
      <div className="tb-group" role="group" aria-label={t("display.style.group")}>
        <label className="tb-field">
          <span className="tb-label">{t("display.style")}</span>
          {viewType === "perspektive" ? (
            <Dropdown
              value={renderMode}
              disabled={!renderModeEnabled}
              onChange={(v) => onRenderMode(v as RenderMode)}
              title={t("display.style.hint")}
              options={[
                { value: "shaded", label: t("display.style.shaded") },
                { value: "white", label: t("display.style.white") },
                { value: "wireframe", label: t("display.style.wireframe") },
                { value: "hidden", label: t("display.style.hidden") },
              ]}
            />
          ) : (
            <Dropdown
              value={planColorMode}
              onChange={(v) => onPlanColorMode(v as PlanColorMode)}
              title={t("display.style.hint")}
              options={[
                { value: "color", label: t("display.style.color") },
                { value: "mono", label: t("display.style.mono") },
              ]}
            />
          )}
        </label>
      </div>

      <Sep />

      {/* Referenzlinien (Wandachsen) — zeigt/versteckt die gestrichelten
          Achslinien im Grundriss. Nur im Grundriss sinnvoll → sonst deaktiviert. */}
      <div className="tb-group" role="group" aria-label={t("topbar.referenceLinesGroup")}>
        <button
          className={`tb-toggle${referenceLines ? " active" : ""}`}
          onClick={() => onReferenceLines(!referenceLines)}
          disabled={!referenceLinesEnabled}
          aria-pressed={referenceLines}
          title={
            referenceLinesEnabled
              ? t("topbar.referenceLines.hint")
              : t("topbar.referenceLines.hintDisabled")
          }
        >
          {t("topbar.referenceLines")}
        </button>
      </div>

      <Sep />

      {/* Linien-Darstellung: Display (alle Haarlinien) ↔ Print (echte mm-
          Strichstärken). Nur im Grundriss sinnvoll. */}
      <div className="tb-group" role="group" aria-label={t("topbar.lineModeGroup")}>
        <div className="view-toggle">
          <button
            className={`view-btn${lineMode === "display" ? " active" : ""}`}
            onClick={() => onLineMode("display")}
            disabled={!lineModeEnabled}
            title={t("topbar.lineMode.display.hint")}
          >
            {t("topbar.lineMode.display")}
          </button>
          <button
            className={`view-btn${lineMode === "print" ? " active" : ""}`}
            onClick={() => onLineMode("print")}
            disabled={!lineModeEnabled}
            title={t("topbar.lineMode.print.hint")}
          >
            {t("topbar.lineMode.print")}
          </button>
        </div>
      </div>

      {/* Rechte Gruppe: Layout-Menü · Ressourcen · Projektname. */}
      <div className="topbar-right">
        {layoutMenu}
        <button
          className={`res-trigger${resourcesOpen ? " active" : ""}`}
          onClick={onToggleResources}
          title={t("topbar.resources.hint")}
        >
          {t("topbar.resources")}
        </button>
        <span className="project-name">{project.name}</span>
      </div>
    </header>
  );
}

// Hinweis: Die früheren Helfer SNAP_TOGGLES + SnapMenu (Fang-Optionen) und die
// Zeichenwerkzeug-Buttons wurden aus der Oberleiste entfernt; sie leben jetzt
// in der Werkzeug-Palette (src/panels/ToolsPanel.tsx).
