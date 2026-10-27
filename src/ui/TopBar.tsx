// Oberleiste (Top-Bar) — MVP nach docs/design/topbar-footer.md.
//
// Gruppen (links → rechts): Marke · Ansichts-Umschalter (Grundriss/Perspektive)
// · Detailgrad (grob/mittel/fein) · Massstab „1:N" + Zoom (Einpassen/Auswahl/
// 100 %) · Render-Modus · Referenzlinien-Toggle · Layout-Menü · Ressourcen.
//
// Die Leiste ist rein gesteuert (controlled): alle Zustände kommen als Props
// aus App, Aktionen melden sich über Callbacks zurück. Bezeichner englisch,
// UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import { t } from "../i18n";
import { checkForUpdate } from "../update/checkForUpdate";
import { getRunningVersion } from "../update/version";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dropdown } from "./Dropdown";
import type { DropdownItem, DropdownOption } from "./Dropdown";
import { PromptDialog } from "./PromptDialog";
import { WindowControls } from "./WindowControls";
import {
  applyMark,
  applyPreset,
  commonMarkValue,
  DEFAULT_LINE_HEIGHT,
  docLength,
  isMarkActive,
  toggleMark,
} from "../text/richText";
import type { DetailLevel, RenderMode, View3d, ViewType } from "../model/viewTypes";
import type {
  Align,
  BoolMark,
  RichTextDoc,
  TextRange,
  TextStylePreset,
} from "../text/richText";

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

/**
 * Gemeinsame Breite (px) von Massstab-Dropdown und Zoom-Segmentpille im
 * Zoom-Cluster — beide sollen exakt gleich breit sein (Nutzer-Wunsch).
 */
const ZOOM_CLUSTER_WIDTH = 140;

export interface TopBarProps {
  project: Project;

  // Kein Ribbon-Tab-Reiter mehr (Werkzeuge leben im ToolsPanel, siehe
  // ribbonItems.ts/layout.ts v12) — die TopBar ist nur noch die schmale
  // globale Leiste: Marke/Menü · Datei/Export/Einstellungen. Ansichts-/Zoom-/
  // Darstellungs-Steuerung folgt direkt darunter (siehe ViewRibbonTab, von
  // App unconditional gerendert statt über Tab-Umschaltung).

  /** Ob Zoom/Plan aktiv ist — steuert nur noch, ob Export im Datei-Menü geht. */
  zoomEnabled: boolean;
  /** Öffnet den PDF-Export-Dialog (nur im Grundriss sinnvoll). */
  onExportPdf: () => void;
  /** Öffnet den DXF-Export-Dialog (nur im Grundriss sinnvoll). */
  onExportDxf: () => void;
  /** Lädt die Bauteilliste des Projekts als CSV herunter. */
  onExportSchedule: () => void;
  /** Lädt das Projekt als IFC4-STEP-Datei herunter. */
  onExportIfc: () => void;
  onExportObj: () => void;
  onExportStl: () => void;
  onExportStep?: () => void;

  // Kamera-Settings (FOV), ZUSÄTZLICH zur bestehenden im „Ansichten"-Ribbon-
  // Tab (ViewRibbonTab) und im 3D-Ribbon-Tab (Ribbon3dTab) — hier direkt neben
  // dem CSV-Export in der schmalen Chrome-Zeile, damit sie immer erreichbar
  // ist (Nutzer-Wunsch). Dieselben Felder/Handler wie dort.
  viewType: ViewType;
  fov: number;
  onFov: (n: number) => void;
  /** Presets nur sinnvoll, solange ein Geschoss aktiv ist (wie `viewToggleEnabled`
   *  in {@link ViewRibbonTabProps}). */
  cameraEnabled: boolean;

  // Ressourcen-Fenster.
  resourcesOpen: boolean;
  onToggleResources: () => void;

  /** Öffnet das Einstellungs-Fenster (Darstellungsfarben, Projekt-Felder). */
  onOpenSettings: () => void;

  /** Layout-Menü (von App geliefert, damit dessen Logik dort bleibt). */

  // ── Datei-Menü (Burger, ganz rechts) ───────────────────────────────────────
  /** Öffnet den DXF/DWG-Import-Datei-Dialog. */
  onImport: () => void;
  /** Projekt als Datei speichern (JSON-Export des gesamten Projekts). */
  onSaveProject: () => void;
  /** Projekt aus einer Datei laden. */
  onOpenProject: () => void;

  /** Menüleiste (Bearbeiten/Ansicht/Fenster, {@link AppMenuBar}) — von App
   * zusammengesetzt (dort leben Undo/Redo/Auswahl/View-State), hier nur
   * platziert. `undefined` blendet sie aus (z. B. für künftige eingebettete
   * Kontexte ohne volle Chrome). */
  menuBar?: React.ReactNode;

  /** Ansichts-/Zoom-/Darstellungs-Steuerung ({@link ViewRibbonTab}) — von App
   * geliefert (dort leben View-State/Setter), hier direkt in DERSELBEN
   * schmalen Leiste platziert (kein eigenes Band mehr, Mockup: EINE Zeile). */
  viewControls?: React.ReactNode;
}

/**
 * Beschreibt das aktuell formatierbare Rich-Text-Ziel der Oberleiste. `apply`
 * schreibt das neue Dokument zurück in den App-State (z. B. via setRoomStampDoc).
 */
export interface TextTarget {
  doc: RichTextDoc;
  range: TextRange | null;
  apply: (doc: RichTextDoc) => void;
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
  // Name-Erfassung über PromptDialog statt window.prompt (im Tauri-WKWebView
  // deaktiviert — liefert sofort null, nichts würde je gespeichert).
  const [saving, setSaving] = useState(false);

  const refresh = () => setNames(list());

  const save = () => setSaving(true);
  const commitSave = (name: string) => {
    onSave(name.trim());
    refresh();
    setSaving(false);
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
      {saving && (
        <PromptDialog
          title={title}
          label={savePrompt}
          onConfirm={commitSave}
          onClose={() => setSaving(false)}
        />
      )}
    </span>
  );
}

/** Die vier oberen Iso-Oktanten (untere vier bleiben im Hochbau ungenutzt). */
const ISO_VARIANTS: View3d[] = ["iso", "isoFrontLeft", "isoBackRight", "isoBackLeft"];

/** Häkchen vor der aktiven Iso-Zeile (gleiche Glyphe wie `Dropdown`s Check). */
function IsoCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.5 6.2 L4.7 8.6 L9.5 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Die Elevations-Ansichten (Vorne/Hinten/Links/Rechts/Oben) — als EIN Symbol
 *  + Dropdown zusammengefasst (statt fünf Buchstaben-Knöpfen). */
const ELEVATION_VIEWS: View3d[] = ["front", "back", "left", "side", "top"];

/**
 * Split-Button mit Dropdown (Vectorworks-Stil): Klick auf das Symbol springt
 * direkt auf die aktuelle/zuletzt gewählte Ansicht der Gruppe; der schmale
 * Pfeil daneben öffnet ein Popover mit allen Varianten. Generisch für die
 * „Ansichten" (Elevations) UND „Iso" (Oktanten) — beide teilen dieselbe
 * robuste Popover-Logik (fixed positioniert, entkommt dem Oberleisten-
 * Overflow; schliesst bei Aussenklick).
 */
function ViewSplitMenu({
  view3d,
  onView3d,
  viewType,
  onViewType,
  disabled,
  variants,
  fallback,
  icon,
  menuLabel,
}: {
  view3d: View3d;
  onView3d: (v: View3d) => void;
  viewType: ViewType;
  onViewType: (v: ViewType) => void;
  disabled: boolean;
  /** Die im Dropdown wählbaren Ansichten dieser Gruppe. */
  variants: View3d[];
  /** Ziel des Symbol-Klicks, falls die aktuelle Ansicht nicht zur Gruppe gehört. */
  fallback: View3d;
  /** Symbol des Haupt-Knopfs. */
  icon: React.ReactNode;
  /** Beschriftung (aria/Tooltip) der Gruppe. */
  menuLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);

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

  const current: View3d = variants.includes(view3d) ? view3d : fallback;
  const active = viewType === "perspektive" && variants.includes(view3d);

  const select = (v: View3d) => {
    onView3d(v);
    if (viewType !== "perspektive") onViewType("perspektive");
    setOpen(false);
  };

  const toggle = () => {
    const next = !open;
    if (next && caretRef.current) {
      const r = caretRef.current.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6 });
    }
    setOpen(next);
  };

  return (
    <div className="tb-popwrap view-icon-split" ref={wrapRef}>
      <button
        type="button"
        className={`view-icon view-icon-split-main${active ? " active" : ""}`}
        disabled={disabled}
        onClick={() => select(current)}
        title={disabled ? t("topbar.viewGroup.disabled") : `${t(`view3d.${current}`)} — ${t(`view3d.${current}.hint`)}`}
        aria-label={menuLabel}
      >
        {icon}
      </button>
      <button
        ref={caretRef}
        type="button"
        className={`view-icon-caret${open ? " active" : ""}`}
        disabled={disabled}
        onClick={toggle}
        title={disabled ? t("topbar.viewGroup.disabled") : menuLabel}
        aria-label={menuLabel}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg width="9" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M0 0l5 6 5-6z" fill="currentColor" />
        </svg>
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            className="ctx-menu tb-dd-menu"
            role="menu"
            aria-label={menuLabel}
            style={{ left: pos.left, top: pos.top }}
          >
            {variants.map((v) => (
              <button
                key={v}
                type="button"
                role="menuitemradio"
                aria-checked={view3d === v}
                className={`ctx-item tb-dd-item${view3d === v ? " is-active" : ""}`}
                onClick={() => select(v)}
                title={t(`view3d.${v}.hint`)}
              >
                <span className="tb-dd-check-slot">{view3d === v && <IsoCheck />}</span>
                <span className="ctx-item-label">{t(`view3d.${v}`)}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Parst eine Massstab-Eingabe „1:35" ODER „35" zum Nenner N (gerundet, > 0).
 * Liefert null bei ungültiger/leerer Eingabe. Exportiert — `ExportPdfDialog.tsx`
 * nutzt dieselbe Funktion für seinen eigenen Freitext-Massstab.
 */
export function parseScaleInput(input: string | null): number | null {
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
      // Kardinal-Quartett (front/back/side/left): Quadrat + kleiner Steg an der
      // Aussenkante zeigt, von welcher Seite die Kamera blickt (Vorne = unten).
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
          <line x1="8" y1="12.5" x2="8" y2="14.3" />
        </svg>
      );
    case "back":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
          <line x1="8" y1="1.7" x2="8" y2="3.5" />
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
          <line x1="12.5" y1="8" x2="14.3" y2="8" />
        </svg>
      );
    case "left":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="9" height="9" />
          <line x1="1.7" y1="8" x2="3.5" y2="8" />
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

/** Symbol für die „Ansichten" (Elevations): eine Fassade — Rechteck mit Tür +
 *  Bodenlinie (statt des unklaren Quadrat-mit-Steg-Icons). */
function ElevationIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="2.5" width="9" height="10.5" />
      <rect x="6.4" y="8" width="3.2" height="5" />
      <line x1="1.5" y1="13" x2="14.5" y2="13" />
    </svg>
  );
}

/** Eine Zelle einer Segmentpille. */
interface SegmentCell {
  /** Stabiler Schlüssel. */
  key: string;
  /** Material-Symbols-Icon-Name. */
  icon: string;
  /** Tooltip/aria-label (Klartext). */
  title: string;
  /** Aktiver Zustand (Akzentfüllung). */
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Segmentpille (DOSSIER-Look): ein Aussencontainer (radius 999, overflow hidden)
 * mit gleich hohen Zellen; interne Trenner über `border-left`. Aktive Zelle in
 * Akzentfarbe. Genutzt für Zoom-Aktionen, B/I/U und L/C/R. `accent` setzt einen
 * Akzent-Rand am Container (Auswahl-Bewusstsein der Text-Gruppe).
 */
function Segment({
  cells,
  ariaLabel,
  accent,
  style,
}: {
  cells: SegmentCell[];
  ariaLabel: string;
  accent?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`tb-seg${accent ? " tb-seg-accent" : ""}`}
      role="group"
      aria-label={ariaLabel}
      style={style}
    >
      {cells.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`tb-seg-cell${c.active ? " active" : ""}`}
          onClick={c.onClick}
          disabled={c.disabled}
          aria-pressed={c.active}
          title={c.title}
          aria-label={c.title}
        >
          <span className="material-symbols-outlined tb-ico" aria-hidden="true">
            {c.icon}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Schriftauswahl der Text-Gruppe: 15 kuratierte, lokal gebuendelte
 * Open-Source-Schriften (SIL Open Font License, siehe `src/text/fonts.css`
 * und `public/fonts/<slug>/OFL.txt`). Bewusst KEINE Systemfonts mehr — die
 * Darstellung soll unabhaengig vom Betriebssystem und der PDF-Export
 * deterministisch sein. Ein spaeterer Einstellungen-Dialog kann weitere
 * Schriften nachladen; das hier ist die Standardliste.
 */
export const TEXT_FONTS: string[] = [
  "Inter",
  "Work Sans",
  "IBM Plex Sans",
  "IBM Plex Mono",
  "Source Sans 3",
  "Space Grotesk",
  "Manrope",
  "Outfit",
  "DM Sans",
  "Public Sans",
  "Karla",
  "Rubik",
  "Jost",
  "Archivo",
  "Source Serif 4",
];

/** Grössen-Presets (pt) der Text-Gruppe. */
const TEXT_SIZES: number[] = [8, 9, 10, 11, 12, 14, 18, 24, 36, 48];

/**
 * Text-Gruppe der Oberleiste (immer sichtbar, 3×2-Raster). Setzt Defaults für
 * neuen Text (lokaler State) UND formatiert das aktuelle `textTarget` live. Ist
 * `textTarget` gesetzt, tragen die Zeile-2-Pillen einen Akzent-Rand und alle
 * Aktionen wirken auf `textTarget.doc` via `textTarget.apply`.
 */
export function TextGroup({
  textTarget,
  textStyles,
}: {
  textTarget: TextTarget | null;
  /** Projekteigene Textstil-Bibliothek (Fallback: `DEFAULT_PRESETS`), s. ResourceManager-Tab „Textstile". */
  textStyles: TextStylePreset[];
}) {
  // Defaults für neuen Text, solange nichts Text-artiges selektiert ist. Bei
  // aktivem Ziel spiegeln die Controls die gemeinsamen Werte des Ziels wider.
  const [defFont, setDefFont] = useState<string>("Inter");
  const [defSize, setDefSize] = useState<number>(12);
  const [defAlign, setDefAlign] = useState<Align>("left");
  const [defLineHeight, setDefLineHeight] = useState<number>(DEFAULT_LINE_HEIGHT);
  const [defBold, setDefBold] = useState(false);
  const [defItalic, setDefItalic] = useState(false);
  const [defUnderline, setDefUnderline] = useState(false);
  // Freie Grösse über PromptDialog statt window.prompt (Tauri-WKWebView).
  const [sizePromptOpen, setSizePromptOpen] = useState(false);

  // Effektiver Bereich am Ziel: expliziter Bereich oder — ohne Bereich — das
  // ganze Dokument (mind. 1 Zeichen, damit isMarkActive/applyMark greifen).
  const targetRange = (doc: RichTextDoc, range: TextRange | null): TextRange =>
    range && range.start !== range.end
      ? range
      : { start: 0, end: Math.max(1, docLength(doc)) };

  const active = textTarget !== null;

  // Aktueller Anzeige-Zustand: vom Ziel abgeleitet, sonst aus den Defaults.
  const rng = textTarget ? targetRange(textTarget.doc, textTarget.range) : null;
  const isBold = textTarget && rng ? isMarkActive(textTarget.doc, rng, "bold") : defBold;
  const isItalic = textTarget && rng ? isMarkActive(textTarget.doc, rng, "italic") : defItalic;
  const isUnderline =
    textTarget && rng ? isMarkActive(textTarget.doc, rng, "underline") : defUnderline;
  const curFont =
    textTarget && rng ? commonMarkValue(textTarget.doc, rng, "font") ?? "" : defFont;
  const curSize =
    textTarget && rng ? commonMarkValue(textTarget.doc, rng, "sizePt") ?? 0 : defSize;
  // Ausrichtung: gemeinsamer Wert der berührten Absätze, sonst Default.
  const curAlign: Align = textTarget
    ? commonAlign(textTarget.doc, rng) ?? "left"
    : defAlign;
  // Zeilenhöhe: gemeinsamer Wert der berührten Absätze, sonst Default.
  const curLineHeight: number = textTarget
    ? commonLineHeight(textTarget.doc, rng) ?? DEFAULT_LINE_HEIGHT
    : defLineHeight;

  // ── Aktions-Helfer (wirken auf das Ziel oder setzen Defaults) ──────────────
  const toggle = (mark: BoolMark, setDefault: (v: boolean) => void, cur: boolean) => {
    if (textTarget) {
      const r = targetRange(textTarget.doc, textTarget.range);
      textTarget.apply(toggleMark(textTarget.doc, r, mark));
    } else {
      setDefault(!cur);
    }
  };

  const setFontValue = (font: string) => {
    if (textTarget) {
      const r = targetRange(textTarget.doc, textTarget.range);
      textTarget.apply(applyMark(textTarget.doc, r, "font", font));
    } else {
      setDefFont(font);
    }
  };

  const setSizeValue = (size: number) => {
    if (!Number.isFinite(size) || size <= 0) return;
    if (textTarget) {
      const r = targetRange(textTarget.doc, textTarget.range);
      textTarget.apply(applyMark(textTarget.doc, r, "sizePt", size));
    } else {
      setDefSize(size);
    }
  };

  const setAlignValue = (align: Align) => {
    if (textTarget) {
      textTarget.apply(applyAlign(textTarget.doc, textTarget.range, align));
    } else {
      setDefAlign(align);
    }
  };

  const setLineHeightValue = (lh: number) => {
    const clamped = Math.round(Math.min(3, Math.max(0.8, lh)) * 10) / 10;
    if (textTarget) {
      textTarget.apply(applyLineHeight(textTarget.doc, textTarget.range, clamped));
    } else {
      setDefLineHeight(clamped);
    }
  };

  const applyPresetValue = (id: string) => {
    const preset = textStyles.find((p) => p.id === id);
    if (!preset) return;
    if (textTarget) {
      const r = textTarget.range ?? { start: 0, end: 0 };
      textTarget.apply(applyPreset(textTarget.doc, r, preset));
    } else {
      // Ohne Ziel: Preset-Defaults übernehmen (Font bleibt, Marks spiegeln).
      if (preset.marks.sizePt != null) setDefSize(preset.marks.sizePt);
      setDefBold(!!preset.marks.bold);
      setDefItalic(!!preset.marks.italic);
    }
  };

  // ── Options-Listen ─────────────────────────────────────────────────────────
  const styleOptions: DropdownOption[] = [
    { value: "__none__", label: t("text.style.none") },
    ...textStyles.map((p) => ({ value: p.id, label: p.label })),
  ];
  const fontOptions: DropdownOption[] = TEXT_FONTS.map((f) => ({
    value: f,
    label: f,
  }));
  const sizeInPresets = TEXT_SIZES.includes(curSize);
  const sizeOptions: DropdownOption[] = [
    ...(sizeInPresets || curSize <= 0
      ? []
      : [{ value: "__current__", label: `${curSize} pt` }]),
    ...TEXT_SIZES.map((n) => ({ value: String(n), label: `${n} pt` })),
    { value: "__custom__", label: t("text.size.custom") },
  ];

  const onSizeChange = (value: string) => {
    if (value === "__custom__") {
      setSizePromptOpen(true);
      return;
    }
    if (value === "__current__") return;
    setSizeValue(Number(value));
  };
  const onSizePromptConfirm = (input: string) => {
    const n = Math.round(Number(input.trim()));
    if (Number.isFinite(n) && n > 0) setSizeValue(n);
    setSizePromptOpen(false);
  };

  return (
    <div className="tb-group tb-textgroup" role="group" aria-label={t("text.group")}>
      {/* Zeile 1: Stil-Preset · Schrift · Grösse. */}
      <div className="tb-textgroup-row">
        <Dropdown
          value="__none__"
          onChange={applyPresetValue}
          title={t("text.style")}
          width={110}
          options={styleOptions}
        />
        <Dropdown
          value={curFont || "__none__"}
          onChange={setFontValue}
          title={t("text.font")}
          width={130}
          options={
            curFont && !TEXT_FONTS.includes(curFont)
              ? [{ value: curFont, label: curFont }, ...fontOptions]
              : fontOptions
          }
        />
        <Dropdown
          value={
            curSize <= 0
              ? "__custom__"
              : sizeInPresets
                ? String(curSize)
                : "__current__"
          }
          onChange={onSizeChange}
          title={t("text.size")}
          width={80}
          triggerClassName="tb-dd-mono"
          options={sizeOptions}
        />
      </div>

      {/* Zeile 2: B/I/U · L/C/R · „+ Text". */}
      <div className="tb-textgroup-row">
        <Segment
          ariaLabel={t("text.group")}
          accent={active}
          style={{ width: 110 }}
          cells={[
            {
              key: "bold",
              icon: "format_bold",
              title: t("text.bold"),
              active: !!isBold,
              onClick: () => toggle("bold", setDefBold, defBold),
            },
            {
              key: "italic",
              icon: "format_italic",
              title: t("text.italic"),
              active: !!isItalic,
              onClick: () => toggle("italic", setDefItalic, defItalic),
            },
            {
              key: "underline",
              icon: "format_underlined",
              title: t("text.underline"),
              active: !!isUnderline,
              onClick: () => toggle("underline", setDefUnderline, defUnderline),
            },
          ]}
        />
        <Segment
          ariaLabel={t("text.group")}
          accent={active}
          style={{ width: 130 }}
          cells={[
            {
              key: "left",
              icon: "format_align_left",
              title: t("text.align.left"),
              active: curAlign === "left",
              onClick: () => setAlignValue("left"),
            },
            {
              key: "center",
              icon: "format_align_center",
              title: t("text.align.center"),
              active: curAlign === "center",
              onClick: () => setAlignValue("center"),
            },
            {
              key: "right",
              icon: "format_align_right",
              title: t("text.align.right"),
              active: curAlign === "right",
              onClick: () => setAlignValue("right"),
            },
          ]}
        />
        <div
          className="tb-lineheight"
          role="group"
          aria-label={t("text.lineHeight")}
          title={t("text.lineHeight.hint")}
        >
          <button
            type="button"
            className="tb-lineheight-btn"
            onClick={() => setLineHeightValue(curLineHeight - 0.1)}
            title={t("text.lineHeight.decrease")}
            aria-label={t("text.lineHeight.decrease")}
          >
            <span className="material-symbols-outlined tb-ico" aria-hidden="true">
              remove
            </span>
          </button>
          <span className="tb-lineheight-value">{curLineHeight.toFixed(1)}×</span>
          <button
            type="button"
            className="tb-lineheight-btn"
            onClick={() => setLineHeightValue(curLineHeight + 0.1)}
            title={t("text.lineHeight.increase")}
            aria-label={t("text.lineHeight.increase")}
          >
            <span className="material-symbols-outlined tb-ico" aria-hidden="true">
              add
            </span>
          </button>
        </div>
      </div>
      {sizePromptOpen && (
        <PromptDialog
          title={t("text.size.custom")}
          label={t("text.size.customPrompt")}
          defaultValue={String(curSize > 0 ? curSize : 12)}
          type="number"
          onConfirm={onSizePromptConfirm}
          onClose={() => setSizePromptOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Gemeinsame Absatz-Ausrichtung der vom Bereich berührten Absätze; `undefined`
 * bei uneinheitlicher/leerer Auswahl. Ohne Bereich → Ausrichtung des ersten
 * Absatzes (das ganze Doc als Ziel).
 */
function commonAlign(doc: RichTextDoc, range: TextRange | null): Align | undefined {
  const paras = touchedParagraphs(doc, range);
  if (paras.length === 0) return doc.paragraphs[0]?.align ?? "left";
  let value: Align | undefined;
  let first = true;
  for (const idx of paras) {
    const a = doc.paragraphs[idx]?.align ?? "left";
    if (first) {
      value = a;
      first = false;
    } else if (a !== value) {
      return undefined;
    }
  }
  return value;
}

/**
 * Setzt die Absatz-Ausrichtung auf alle vom Bereich berührten Absätze. Ohne
 * Bereich (null) auf ALLE Absätze des Dokuments.
 */
function applyAlign(doc: RichTextDoc, range: TextRange | null, align: Align): RichTextDoc {
  const touched = new Set(touchedParagraphs(doc, range));
  const all = range == null;
  return {
    version: 1,
    paragraphs: doc.paragraphs.map((p, i) =>
      all || touched.has(i) ? { ...p, align } : p,
    ),
  };
}

/**
 * Gemeinsame Zeilenhöhe der vom Bereich berührten Absätze (Vielfaches der
 * Basisgrösse); `undefined` bei uneinheitlicher Auswahl.
 */
function commonLineHeight(doc: RichTextDoc, range: TextRange | null): number | undefined {
  const paras = touchedParagraphs(doc, range);
  if (paras.length === 0) return doc.paragraphs[0]?.lineHeight ?? DEFAULT_LINE_HEIGHT;
  let value: number | undefined;
  let first = true;
  for (const idx of paras) {
    const lh = doc.paragraphs[idx]?.lineHeight ?? DEFAULT_LINE_HEIGHT;
    if (first) {
      value = lh;
      first = false;
    } else if (lh !== value) {
      return undefined;
    }
  }
  return value;
}

/**
 * Setzt die Zeilenhöhe auf alle vom Bereich berührten Absätze. Ohne Bereich
 * (null) auf ALLE Absätze des Dokuments.
 */
function applyLineHeight(doc: RichTextDoc, range: TextRange | null, lineHeight: number): RichTextDoc {
  const touched = new Set(touchedParagraphs(doc, range));
  const all = range == null;
  return {
    version: 1,
    paragraphs: doc.paragraphs.map((p, i) =>
      all || touched.has(i) ? { ...p, lineHeight } : p,
    ),
  };
}

/** Indizes der Absätze, die der Bereich [start,end) berührt. */
function touchedParagraphs(doc: RichTextDoc, range: TextRange | null): number[] {
  if (range == null || range.start === range.end) {
    return doc.paragraphs.map((_, i) => i);
  }
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const out: number[] = [];
  let cursor = 0;
  doc.paragraphs.forEach((p, i) => {
    const len = p.runs.reduce((n, r) => n + r.text.length, 0);
    const pStart = cursor;
    const pEnd = cursor + len;
    if (!(pEnd < start || pStart > end)) out.push(i);
    cursor += len + 1;
  });
  return out;
}

/** App-Version (spiegelt src-tauri/tauri.conf.json). Exportiert für appMenu.ts
 * (native macOS-Menüleiste, „Über Dossier"), damit die Versionsnummer nur an
 * dieser einen Stelle gepflegt wird. */
export const APP_VERSION = "0.1.0";

/**
 * „Über"-Dialog (In-App, dunkel) — App-Marke, Version, Kurzbeschreibung und die
 * Lizenzen der wichtigsten Open-Source-Bausteine. Öffnet per Klick auf die
 * Wortmarke. Klick ausserhalb / Esc schliesst.
 */
function AboutDialog({ onClose }: { onClose: () => void }) {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  useEffect(() => {
    void getRunningVersion().then(setRunningVersion);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Per Portal an document.body statt als DOM-Kind der .topbar rendern: die
  // .topbar bildet (position:relative + z-index) einen eigenen Stacking-
  // Context, der das hohe z-index:1000 von .about-overlay einsperrt — andere
  // z-index:2-Elemente ausserhalb (z. B. das Lineal-Overlay im Grundriss)
  // konnten dadurch trotzdem durch den abgedunkelten Hintergrund "durch-
  // scheinen". Als Portal-Kind von body liegt der Dialog in keinem fremden
  // Stacking-Context mehr.
  return createPortal(
    <div className="about-overlay" onMouseDown={onClose}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("about.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="about-brand">
          dossier<span className="brand-dot">.</span>
        </div>
        <div className="about-version">
          {t("about.version")} {runningVersion ?? APP_VERSION}
        </div>
        <p className="about-desc">{t("about.desc")}</p>
        <div className="about-meta">
          <div>{t("about.copyright")}</div>
          <div>{t("about.license")}</div>
          <div>{t("about.suite")}</div>
        </div>
        <div className="about-sec-label">{t("about.licenses")}</div>
        <ul className="about-licenses">
          <li>React · Vite — MIT</li>
          <li>Tauri — MIT / Apache-2.0</li>
          <li>wgpu (render3d) — MIT / Apache-2.0</li>
          <li>truck · csgrs — Apache-2.0</li>
          <li>OpenCascade.js — LGPL-2.1</li>
          <li>LibreDWG — GPL-3.0</li>
          <li>acadrust — MPL-2.0</li>
        </ul>
        <div className="about-actions">
          <button
            type="button"
            className="about-check-update"
            disabled={checkingUpdate}
            onClick={async () => {
              setCheckingUpdate(true);
              try {
                await checkForUpdate(false);
              } finally {
                setCheckingUpdate(false);
              }
            }}
          >
            {checkingUpdate ? t("about.checkingUpdate") : t("about.checkUpdate")}
          </button>
          <button type="button" className="about-close" onClick={onClose}>
            {t("about.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Props des „Ansichten"-Tabs — die Ansichts-/Zoom-/Darstellungs-Steuerung, die
 * früher in der Mitte der TopBar sass. Eine Teilmenge von {@link TopBarProps}.
 */
export interface ViewRibbonTabProps {
  viewToggleEnabled: boolean;
  viewType: ViewType;
  onViewType: (v: ViewType) => void;
  view3d: View3d;
  onView3d: (v: View3d) => void;
  detail: DetailLevel;
  onDetail: (d: DetailLevel) => void;
  detailEnabled: boolean;
  scaleDenominator: number;
  onApplyScale: (n: number) => void;
  liveScale: number | null;
  zoomPercent: number;
  zoomEnabled: boolean;
  onFit: () => void;
  onFitSelection: () => void;
  onZoom100: () => void;
  renderMode: RenderMode;
  onRenderMode: (m: RenderMode) => void;
  renderModeEnabled: boolean;
  planColorMode: PlanColorMode;
  onPlanColorMode: (m: PlanColorMode) => void;
  /** Ob die aktive Ebene eine Ansicht (kind "elevation") ist — nur dann ist der
   *  Schatten-Umschalter sichtbar/aktiv. */
  shadowsAvailable: boolean;
  /** Schlagschatten der aktiven Ansicht ein/aus (DrawingLevel.shadows). */
  shadows: boolean;
  onShadows: (v: boolean) => void;
  combos: ComboMenuHandlers;
  /** Text-/Font-Formatierung auf DERSELBEN Leiste (Raumstempel-Ziel; `null` =
   *  nur Defaults). Liegt bewusst im „Ansichten"-Tab (Nutzer-Wunsch). */
  textTarget: TextTarget | null;
  /** Projekteigene Textstil-Bibliothek (Fallback: `DEFAULT_PRESETS`), s. ResourceManager-Tab „Textstile". */
  textStyles: TextStylePreset[];
}

/**
 * „Ansichten"-Tab des Ribbons — trägt die aus der TopBar gemergten Mittelcluster:
 * 2D/3D-Ansichts-Raster (+ Kamera-FOV), Sichtbarkeits-Kombinationen, Detailgrad,
 * Massstab/Zoom-Cluster und Darstellungsart. EIN Ribbon für alles; Handler/Setter
 * kommen unverändert von App (gleiche Props wie zuvor an die TopBar).
 */
export function ViewRibbonTab({
  viewToggleEnabled,
  viewType,
  onViewType,
  view3d,
  onView3d,
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
  shadowsAvailable,
  shadows,
  onShadows,
  combos,
  textTarget,
  textStyles,
}: ViewRibbonTabProps) {
  // „frei" wird über einen In-App-Dialog erfasst (window.prompt ist im Tauri-
  // WKWebView deaktiviert); akzeptiert „1:35" ODER „35".
  const [scalePromptOpen, setScalePromptOpen] = useState(false);
  const onScaleChange = (value: string) => {
    if (value === "__custom__") {
      setScalePromptOpen(true);
      return;
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) onApplyScale(n);
  };
  const onScalePromptConfirm = (input: string) => {
    const n = parseScaleInput(input);
    if (n != null) onApplyScale(n);
    setScalePromptOpen(false);
  };
  const inPresets = SCALE_PRESETS.includes(scaleDenominator);
  const scaleOptions: DropdownOption[] = [
    ...(inPresets
      ? []
      : [{ value: "__current__", label: `1:${scaleDenominator}` }]),
    ...SCALE_PRESETS.map((n) => ({ value: String(n), label: `1:${n}` })),
    { value: "__custom__", label: t("topbar.scale.custom") },
  ];

  return (
    <div className="ribbon-views">
      {/* Reihenfolge: Grundriss · Ansichten · Iso · Axo — ohne Trennstriche
          (eine zusammenhängende Symbol-Zeile, Nutzer-Wunsch). */}
      <span className="tb-viewtoggle" role="group" aria-label={t("topbar.viewGroup")}>
        <button
          type="button"
          className={`tb-vt-btn${
            viewToggleEnabled && viewType === "grundriss" ? " active" : ""
          }`}
          onClick={() => onViewType("grundriss")}
          disabled={!viewToggleEnabled}
          title={viewToggleEnabled ? t("topbar.grundriss") : t("topbar.viewGroup.disabled")}
          aria-label={t("topbar.grundriss")}
        >
          <ViewIcon name="grundriss" />
        </button>
        <ViewSplitMenu
          view3d={view3d}
          onView3d={onView3d}
          viewType={viewType}
          onViewType={onViewType}
          disabled={!viewToggleEnabled}
          variants={ELEVATION_VIEWS}
          fallback="front"
          icon={<ElevationIcon />}
          menuLabel={t("topbar.views")}
        />
        <ViewSplitMenu
          view3d={view3d}
          onView3d={onView3d}
          viewType={viewType}
          onViewType={onViewType}
          disabled={!viewToggleEnabled}
          variants={ISO_VARIANTS}
          fallback="iso"
          icon={<ViewIcon name="iso" />}
          menuLabel={t("view3d.iso.menu")}
        />
        <button
          type="button"
          className={`tb-vt-btn${
            viewToggleEnabled && viewType === "perspektive" && view3d === "perspective"
              ? " active"
              : ""
          }`}
          onClick={() => {
            onView3d("perspective");
            if (viewType !== "perspektive") onViewType("perspektive");
          }}
          disabled={!viewToggleEnabled}
          title={viewToggleEnabled ? `${t("topbar.axo")} — ${t("topbar.axo.hint")}` : t("topbar.viewGroup.disabled")}
          aria-label={t("topbar.axo")}
        >
          <ViewIcon name="perspective" />
        </button>
      </span>
      <Sep />

      {/* Sichtbarkeits-Kombinationen (Ebenen-/Zeichnungskombinationen). */}
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

      {/* Detailgrad (grob/mittel/fein) + Darstellungsart übereinander gestapelt
          (Nutzer-Wunsch) — gleiches Stapel-Muster wie die Kombinationen. */}
      <div className="tb-group tb-stack" role="group" aria-label={t("topbar.detailGroup")}>
        <label className="tb-field tb-field-row">
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
        <label className="tb-field tb-field-row">
          <span className="tb-label">{t("display.style")}</span>
          {viewType === "perspektive" ? (
            <Dropdown
              value={renderMode}
              disabled={!renderModeEnabled}
              onChange={(v) => onRenderMode(v as RenderMode)}
              title={t("display.style.hint")}
              options={[
                { value: "shaded", label: t("display.style.shaded") },
                { value: "shaded-edges", label: t("display.style.shadedEdges") },
                { value: "white", label: t("display.style.white") },
                { value: "contour", label: t("display.style.contour") },
                { value: "textured", label: t("display.style.textured") },
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

      {/* Massstab/Zoom + Text-Formatierung OHNE Trennstriche, gleich gross wie
          die Dropdowns (Mockup). */}
      <div className="tb-group tb-zoomcluster" role="group" aria-label={t("topbar.scaleGroup")}>
        <div
          className={`tb-stat${
            zoomEnabled && liveScale != null && Math.round(liveScale) === scaleDenominator
              ? " tb-stat-atscale"
              : ""
          }`}
          title={`${t("topbar.scale.live")} · ${t("topbar.zoom.current")}`}
        >
          <span className="tb-stat-scale">
            {zoomEnabled && liveScale != null ? `1:${Math.round(liveScale)}` : "—"}
          </span>
          <span className="tb-stat-zoom">
            {zoomEnabled ? `${Math.round(zoomPercent)}%` : "—"}
          </span>
        </div>
        <div className="tb-zoomcluster-right">
          <Dropdown
            value={inPresets ? String(scaleDenominator) : "__current__"}
            disabled={!zoomEnabled}
            onChange={onScaleChange}
            title={t("topbar.scale.apply")}
            triggerClassName="tb-dd-mono"
            width={ZOOM_CLUSTER_WIDTH}
            options={scaleOptions}
          />
          <Segment
            ariaLabel={t("topbar.scaleGroup")}
            style={{ width: ZOOM_CLUSTER_WIDTH }}
            cells={[
              {
                key: "zoom100",
                icon: "straighten",
                title: t("topbar.zoom100.hint", { n: scaleDenominator }),
                onClick: onZoom100,
                disabled: !zoomEnabled,
              },
              {
                key: "fit",
                icon: "fit_screen",
                title: t("topbar.fit.hint"),
                onClick: onFit,
                disabled: !zoomEnabled,
              },
              {
                key: "fitSelection",
                icon: "center_focus_strong",
                title: t("topbar.fitSelection.hint"),
                onClick: onFitSelection,
                disabled: !zoomEnabled,
              },
            ]}
          />
        </div>
      </div>

      {/* Schatten ein/aus — NUR für eine aktive Ansicht (kind "elevation").
          Schreibt DrawingLevel.shadows; der Ansichts-Generator (toElevation)
          zeichnet dann den 45°-Schlagschatten auskragender Bauteile. */}
      {shadowsAvailable && (
        <>
          <div className="tb-group" role="group" aria-label={t("elevation.shadows")}>
            <button
              className={`tb-toggle${shadows ? " active" : ""}`}
              onClick={() => onShadows(!shadows)}
              title={t("elevation.shadows.hint")}
              aria-pressed={shadows}
            >
              {t("elevation.shadows")}
            </button>
          </div>
          <Sep />
        </>
      )}

      {/* Text-/Font-Formatierung auf DERSELBEN Leiste (Nutzer-Wunsch: Text und
          Ansichten zusammen) — Stil/Schrift/Grösse + B/I/U · L/C/R + Zeilenhöhe,
          formatiert das aktuelle Text-Ziel (Raumstempel) live. */}
      <TextGroup textTarget={textTarget} textStyles={textStyles} />
      {scalePromptOpen && (
        <PromptDialog
          title={t("topbar.scale.custom")}
          label={t("topbar.scale.prompt")}
          defaultValue={`1:${scaleDenominator}`}
          onConfirm={onScalePromptConfirm}
          onClose={() => setScalePromptOpen(false)}
        />
      )}
    </div>
  );
}

export function TopBar({
  project,
  menuBar,
  viewControls,
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

  // Unter Tauri (native macOS-Ampeln oben links via titleBarStyle "Overlay")
  // braucht die Zeile links Platz, damit `dossier.` nicht darunter liegt.
  const [aboutOpen, setAboutOpen] = useState(false);

  const tauriNativeTitlebar =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  return (
    // `data-tauri-drag-region`: die Titelleiste ist selbst der Fenster-Ziehbereich
    // (macOS titleBarStyle "Overlay"). Kind-Buttons/Dropdowns bleiben klickbar;
    // nur die leeren Zonen ziehen das Fenster. Unter Tauri bekommt die Zeile links
    // einen Inset, damit `dossier.` nicht unter den nativen macOS-Ampeln liegt.
    <header
      className={`topbar${tauriNativeTitlebar ? " topbar-native-inset" : ""}`}
      ref={headerRef}
      data-tauri-drag-region
    >
      {/* Fensterknöpfe NUR unter Electron (randloses frame:false-Fenster) — unter
          Tauri liefern die NATIVEN macOS-Ampeln Schliessen/Minimieren/Maximieren,
          daher rendert WindowControls dort null. */}
      <WindowControls />

      {/* Kleine Wortmarke „dossier" (OCS-Stil, klein/kleingeschrieben) + Quick-
          Access-Leiste: alle Datei-/Export-Aktionen + Ressourcen/Einstellungen
          als kleine Icons direkt in der Zeile (ersetzt das Burger-Menü). */}
      <div className="tb-brandgroup">
        <button
          type="button"
          className="brand-word"
          onClick={() => setAboutOpen(true)}
          title={t("about.title")}
          aria-label={t("about.title")}
        >
          dossier<span className="brand-dot">.</span>
        </button>
      </div>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {menuBar}

      {/* Ansichts-/Zoom-/Darstellungs-Steuerung direkt in DERSELBEN Zeile
          (Mockup: EINE schmale Leiste, kein eigenes Band mehr). */}
      {viewControls && <Sep />}
      {viewControls}

      {/* Rechte Gruppe: Datei-/Export-Aktionen (Quick-Access) + Projektname —
          per margin-left:auto an den rechten Rand geschoben (Mockup: ⤓ ⤒
          Projektname ganz rechts). Die Fensterknöpfe sitzen ganz links
          (macOS-Titelleisten-Konvention). */}
      <div className="topbar-right">
        <span className="project-name">{project.name}</span>
      </div>
    </header>
  );
}

// Hinweis: Die früheren Helfer SNAP_TOGGLES + SnapMenu (Fang-Optionen) und die
// Zeichenwerkzeug-Buttons wurden aus der Oberleiste entfernt; sie leben jetzt
// in der Werkzeug-Palette (src/panels/ToolsPanel.tsx).
