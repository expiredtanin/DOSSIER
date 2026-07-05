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
import { WindowControls } from "./WindowControls";
import {
  applyMark,
  applyPreset,
  commonMarkValue,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_PRESETS,
  docLength,
  isMarkActive,
  toggleMark,
} from "../text/richText";
import type {
  Align,
  BoolMark,
  RichTextDoc,
  TextRange,
} from "../text/richText";

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
 * texturiert (echte PBR-Materialien je Bauteil), Drahtgitter, Verdeckte Kanten
 * (Hidden-Line). Wirkt nur in der Perspektive. Der Slot „section" (Schnitt-
 * schraffur, Welle B) ist bewusst freigelassen.
 */
export type RenderMode =
  | "shaded"
  | "white"
  | "textured"
  | "wireframe"
  | "hidden";

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

/**
 * Gemeinsame Breite (px) von Massstab-Dropdown und Zoom-Segmentpille im
 * Zoom-Cluster — beide sollen exakt gleich breit sein (Nutzer-Wunsch).
 */
const ZOOM_CLUSTER_WIDTH = 140;

export interface TopBarProps {
  project: Project;

  // Ansichts-/Zoom-/Darstellungs-Steuerung ist in den „Ansichten"-Ribbon-Tab
  // gewandert (siehe ViewRibbonTab). Die TopBar ist nur noch die schmale globale
  // Leiste: Marke/Ressourcen · Text-Formatierung · Datei/Export/Einstellungen.

  /** Ob Zoom/Plan aktiv ist — steuert nur noch, ob Export im Datei-Menü geht. */
  zoomEnabled: boolean;
  /** Öffnet den PDF-Export-Dialog (nur im Grundriss sinnvoll). */
  onExportPdf: () => void;
  /** Öffnet den DXF-Export-Dialog (nur im Grundriss sinnvoll). */
  onExportDxf: () => void;
  /** Lädt die Bauteilliste des Projekts als CSV herunter. */
  onExportSchedule: () => void;

  // Ressourcen-Fenster.
  resourcesOpen: boolean;
  onToggleResources: () => void;

  /** Öffnet das Einstellungs-Fenster (Darstellungsfarben, Projekt-Felder). */
  onOpenSettings: () => void;

  /** Layout-Menü (von App geliefert, damit dessen Logik dort bleibt). */
  layoutMenu: ReactNode;

  // ── Datei-Menü (Burger, ganz rechts) ───────────────────────────────────────
  /** Öffnet den DXF/DWG-Import-Datei-Dialog. */
  onImport: () => void;
  /** Projekt als Datei speichern (JSON-Export des gesamten Projekts). */
  onSaveProject: () => void;
  /** Projekt aus einer Datei laden. */
  onOpenProject: () => void;

  // ── Text-Gruppe (Stempel-/Text-Formatierung) ───────────────────────────────
  /**
   * Ziel der Text-Formatierung: `null` = nichts Text-artiges selektiert (die
   * Controls setzen nur Defaults für neuen Text). Sonst das aktuell selektierte
   * Rich-Text-Dokument (z. B. Raumstempel) samt optionalem Bereich und einem
   * Setter. Ist `range` `null`, wirken Aktionen auf das GANZE Doc.
   */
  textTarget: TextTarget | null;
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
 * Material-Symbols-Icon für die Oberleiste (gleiche Icon-Font wie ContextMenu/
 * MenuIcon). Rein dekorativ — der sprechende Text steckt im `title`/aria-label
 * des umgebenden Buttons.
 */
function TbIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-outlined tb-ico" aria-hidden="true">
      {name}
    </span>
  );
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
const TEXT_FONTS: string[] = [
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
function TextGroup({
  textTarget,
}: {
  textTarget: TextTarget | null;
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
    const preset = DEFAULT_PRESETS.find((p) => p.id === id);
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
    ...DEFAULT_PRESETS.map((p) => ({ value: p.id, label: p.label })),
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
      const input = window.prompt(
        t("text.size.customPrompt"),
        String(curSize > 0 ? curSize : 12),
      );
      const n = input == null ? NaN : Math.round(Number(input.trim()));
      if (Number.isFinite(n) && n > 0) setSizeValue(n);
      return;
    }
    if (value === "__current__") return;
    setSizeValue(Number(value));
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

/**
 * Datei-Menü der Oberleiste (Burger, ganz rechts): Speichern/Öffnen des
 * Projekts sowie Import (DXF/DWG) und Export (PDF/DXF) — vorher eigene
 * Icon-Pillen im Zoom-Bereich, jetzt gebündelt hinter einem Menü, damit die
 * Leiste ruhiger bleibt (GTK-Burger-Stil).
 */
function AppMenu({
  onImport,
  onExportPdf,
  onExportDxf,
  onExportSchedule,
  onSaveProject,
  onOpenProject,
  onOpenSettings,
  exportEnabled,
}: {
  onImport: () => void;
  onExportPdf: () => void;
  onExportDxf: () => void;
  onExportSchedule: () => void;
  onSaveProject: () => void;
  onOpenProject: () => void;
  onOpenSettings: () => void;
  exportEnabled: boolean;
}) {
  const items: DropdownItem[] = [
    { label: t("file.save"), onSelect: onSaveProject },
    { label: t("file.open"), onSelect: onOpenProject },
    { divider: true },
    { label: t("file.import"), onSelect: onImport },
    { divider: true },
    { label: t("file.exportPdf"), onSelect: onExportPdf, disabled: !exportEnabled },
    { label: t("file.exportDxf"), onSelect: onExportDxf, disabled: !exportEnabled },
    { label: t("file.exportSchedule"), onSelect: onExportSchedule },
    { divider: true },
    { label: t("topbar.settings"), onSelect: onOpenSettings },
  ];
  return (
    <Dropdown
      items={items}
      placeholder=""
      title={t("file.menu")}
      triggerClassName="tb-burger"
      triggerSuffix={<TbIcon name="menu" />}
    />
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
  fov: number;
  onFov: (n: number) => void;
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
  combos: ComboMenuHandlers;
}

/**
 * „Ansichten"-Tab des Ribbons — trägt die aus der TopBar gemergten Mittelcluster:
 * 2D/3D-Ansichts-Raster (+ Kamera-FOV), Sichtbarkeits-Kombinationen, Detailgrad,
 * Massstab/Zoom-Cluster und Darstellungsart. EIN Ribbon für alles; Handler/Setter
 * kommen unverändert von App (gleiche Props wie zuvor an die TopBar). Wird von
 * `RibbonBar` als Inhalt des „Ansichten"-Tabs gerendert.
 */
export function ViewRibbonTab({
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
  combos,
}: ViewRibbonTabProps) {
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
      {/* Ansichten als EIN kompaktes Icon-Grid (2D-Grundriss + 3D-Blicke). */}
      <div className="tb-group" role="group" aria-label={t("topbar.viewGroup")}>
        <div className="view-grid view-grid-4">
          <button
            className={`view-icon${
              viewToggleEnabled && viewType === "grundriss" ? " active" : ""
            }`}
            onClick={() => onViewType("grundriss")}
            disabled={!viewToggleEnabled}
            title={
              viewToggleEnabled
                ? t("topbar.grundriss")
                : t("topbar.viewGroup.disabled")
            }
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
                viewToggleEnabled && viewType === "perspektive" && view3d === key
                  ? " active"
                  : ""
              }`}
              onClick={() => {
                onView3d(key);
                if (viewType !== "perspektive") onViewType("perspektive");
              }}
              disabled={!viewToggleEnabled}
              title={
                viewToggleEnabled
                  ? `${label} — ${t(`view3d.${key}.hint`)}`
                  : t("topbar.viewGroup.disabled")
              }
              aria-label={label}
            >
              <ViewIcon name={key} />
            </button>
          ))}
          <CameraMenu
            fov={fov}
            onFov={onFov}
            disabled={!viewToggleEnabled || viewType !== "perspektive"}
          />
        </div>
      </div>
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

      {/* Detailgrad (grob/mittel/fein) — wirkt im Grundriss. */}
      <div className="tb-group" role="group" aria-label={t("topbar.detailGroup")}>
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
      </div>
      <Sep />

      {/* Massstab/Zoom-Cluster (2×2). */}
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
      <Sep />

      {/* Darstellungsart — Grundriss: Farbig/SW; Perspektive: Render-Modus. */}
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
    </div>
  );
}

export function TopBar({
  project,
  zoomEnabled,
  onExportPdf,
  onExportDxf,
  onExportSchedule,
  resourcesOpen,
  onToggleResources,
  onOpenSettings,
  layoutMenu,
  onImport,
  onSaveProject,
  onOpenProject,
  textTarget,
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

  return (
    <header className="topbar" ref={headerRef}>
      {/* Marke (DOSSIER-Wortmarke) + Settings/Ressourcen-Icons daneben,
          gestapelt wie im Rhino-Plugin (ToolbarApp.jsx: Wortmarke links,
          rechts daneben ein schmaler Icon-Stapel). */}
      <div className="tb-brandgroup">
        <div className="brand">
          <span className="brand-word">
            DOSSIER<span className="brand-dot">.</span>
          </span>
          <span className="tag">{t("brand.tag")}</span>
        </div>
        <div className="tb-brandicons">
          <button
            type="button"
            className={`tb-brandicon${resourcesOpen ? " active" : ""}`}
            onClick={onToggleResources}
            aria-pressed={resourcesOpen}
            aria-label={t("topbar.resources")}
            title={`${t("topbar.resources")} — ${t("topbar.resources.hint")}`}
          >
            <TbIcon name="widgets" />
          </button>
        </div>
      </div>

      <Sep />

      {/* Text-Gruppe (kontextabhängig) — Stil/Schrift/Grösse + B/I/U · L/C/R +
          Zeilenhöhe. Formatiert das aktuelle Text-Ziel (Raumstempel) live. Bleibt
          in der schmalen globalen Leiste, weil sie eine kontextuelle Formatier-
          Steuerung ist (kein Ansichts-/Ausgabe-Element). */}
      <TextGroup textTarget={textTarget} />

      {/* Rechte Gruppe: Layout-Menü · Projektname · Datei-Burger (ganz rechts,
          GTK-Stil) — Ressourcen sitzt jetzt bei der Marke (s. o.). */}
      <div className="topbar-right">
        {layoutMenu}
        <span className="project-name">{project.name}</span>
        <AppMenu
          onImport={onImport}
          onExportPdf={onExportPdf}
          onExportDxf={onExportDxf}
          onExportSchedule={onExportSchedule}
          onSaveProject={onSaveProject}
          onOpenProject={onOpenProject}
          onOpenSettings={onOpenSettings}
          exportEnabled={zoomEnabled}
        />
        <WindowControls />
      </div>
    </header>
  );
}

// Hinweis: Die früheren Helfer SNAP_TOGGLES + SnapMenu (Fang-Optionen) und die
// Zeichenwerkzeug-Buttons wurden aus der Oberleiste entfernt; sie leben jetzt
// in der Werkzeug-Palette (src/panels/ToolsPanel.tsx).
