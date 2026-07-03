// Ressourcen-Manager — verwaltete Stil-Bibliotheken nach DOSSIER-Vorbild
// (Vectorworks-Stil). Drei Sektionen in einer rechten Schublade (Drawer):
//   • Bauteile (Components) — Poché-/3D-Farbe, Verschneidungs-Rang, Schraffur.
//   • Schraffuren (Hatches)  — Muster/Maßstab/Winkel/Farbe + Linienstil.
//   • Linien (Line Styles)   — Strichstärke/Farbe/Strichmuster.
//
// Darstellung als saubere Tabelle (CONVENTIONS.md): pro Tab EINE sticky Kopfzeile
// mit Spaltentiteln, darunter kompakte Datenzeilen mit Inline-Edit pro Zelle —
// keine wiederholten Feld-Beschriftungen je Zeile. Umgesetzt als CSS-Grid, das
// Kopf- und Datenzeilen dieselben Spalten teilen (`grid-template-columns` je
// Tab), damit die Spalten exakt fluchten.
//
// Reine Darstellung + Callbacks: alle Mutationen laufen immutabel über die
// vom App gereichten Handler (setProject). Plan & 3D leiten aus demselben
// Projekt ab und aktualisieren dadurch live — diese Komponente kennt weder
// Rendering noch Persistenz. Bezeichner englisch, UI-Text deutsch
// (CONVENTIONS.md).

import { useEffect, useRef, useState } from "react";
import type {
  CeilingType,
  Component,
  ComponentMaterial,
  HatchPattern,
  HatchStyle,
  LineStyle,
  Project,
  WallType,
} from "../model/types";
import { PEN_WEIGHTS } from "../model/types";
import { parseLin } from "../io/linParser";
import { parsePat } from "../io/patParser";
import { MATERIAL_LIBRARY } from "../materials/library";
import type { MaterialAsset } from "../materials/library";
import { materialFromAsset, DEFAULT_TILE_SIZE_M } from "../materials/runtime";
import {
  searchMaterials,
  fetchMaterialMaps,
  AMBIENT_CATEGORIES,
  type AmbientMaterial,
  type AmbientResolution,
} from "../materials/ambientcg";
import { requestMaterialPreview, cancelMaterialPreview } from "../materials/spherePreview";
import { EyeIcon } from "./EyeIcon";
import { HatchSwatch, LineSwatch } from "./hatchPreview";
import { t } from "../i18n";

// ── Auswahl-Optionen (UI-Beschriftung übersetzt, Werte englisch) ───────────

/** Schraffur-Muster mit i18n-Key für die Beschriftung. */
const PATTERN_OPTIONS: { value: HatchPattern; labelKey: string }[] = [
  { value: "none", labelKey: "pattern.none" },
  { value: "solid", labelKey: "pattern.solid" },
  { value: "insulation", labelKey: "pattern.insulation" },
  { value: "diagonal", labelKey: "pattern.diagonal" },
  { value: "crosshatch", labelKey: "pattern.crosshatch" },
];

/**
 * Benannte Strichmuster (mm). `null` = durchgezogen. Werte als Schlüssel
 * serialisiert, damit das Dropdown den aktuellen Stil wiedererkennt.
 */
const DASH_OPTIONS: { key: string; labelKey: string; dash: number[] | null }[] = [
  { key: "solid", labelKey: "dash.solid", dash: null },
  { key: "dashed", labelKey: "dash.dashed", dash: [6, 4] },
  { key: "dotted", labelKey: "dash.dotted", dash: [1, 3] },
];

/** Findet den Dash-Schlüssel, der zu einem Strichmuster passt (sonst custom). */
function dashKey(dash: number[] | null): string {
  const hit = DASH_OPTIONS.find(
    (o) =>
      (o.dash === null && dash === null) ||
      (o.dash !== null &&
        dash !== null &&
        o.dash.length === dash.length &&
        o.dash.every((v, i) => v === dash[i])),
  );
  return hit ? hit.key : "custom";
}

// ── Wiederverwendbare Feld-Bausteine (DOSSIER-Look) ────────────────────────
// Alle Steuerelemente füllen ihre Tabellenzelle (width:100%) und werden über
// die Spaltenbreite des Grids dimensioniert; Zahlenfelder sind rechtsbündig.

/** Kompaktes Textfeld (Pill) für Namen/Platzhalter. */
function TextField({
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      className={`res-input${mono ? " mono" : ""}`}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Zahlenfeld (Pill, rechtsbündig, monospace) mit Live-Commit. */
function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  list,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Optionale <datalist>-ID mit Vorschlagswerten (z. B. Stiftstärken). */
  list?: string;
}) {
  return (
    <input
      type="number"
      className="res-input mono num"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      list={list}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

/**
 * Farb-Swatch mit nativem Color-Picker. Das <label> umschließt einen
 * sichtbaren Swatch und den unsichtbaren color-input — Klick öffnet den
 * Picker, der Swatch zeigt die Farbe live (nach DOSSIER ColorBar).
 */
function ColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="res-color" title={color}>
      <span className="res-color-swatch" style={{ background: color }} />
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Pill-Dropdown (erbt das globale select-Styling). */
function SelectField<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      className="res-select"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Runder Löschen-Knopf (Mülleimer-Icon) in der letzten Spalte. */
function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button className="res-delete" title={title} onClick={onClick}>
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

// ── Master-Detail-Bausteine (DOSSIER-Stil: Liste links, Detail rechts) ──────

/**
 * Segmentierter Umschalter (Pillen-Gruppe) für kleine, sich ausschließende
 * Auswahlen — z. B. Schraffur-Typ Vektor/Bild oder Linien-Typ Strich/Zickzack.
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="res-seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`res-seg-btn${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Eine beschriftete Detail-Zeile (Label links, Steuerelement rechts). Bewusst
 * ein <div> (kein <label>): Zeilen enthalten teils mehrere interaktive Elemente
 * (Segmented-Buttons), und ein umschließendes <label> würde den Klick an das
 * ERSTE labelbare Kind umleiten — das würde einen Segment-Klick sofort wieder
 * zurücksetzen. Die Steuerelemente sind selbst klickbar; ein Label ist unnötig.
 */
function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="res-field" title={hint}>
      <span className="res-field-label">{label}</span>
      <span className="res-field-control">{children}</span>
    </div>
  );
}

// ── Tabellen-Gerüst ────────────────────────────────────────────────────────

/** Eine Spaltendefinition: Titel-Key + optionale rechtsbündige Ausrichtung. */
interface ResColumn {
  /** i18n-Key des Spaltentitels (leerer String = titellose Spalte). */
  titleKey: string;
  /** Zahlen-Spalten rechtsbündig ausrichten (Titel + Zellen). */
  align?: "right";
  /** Optionaler i18n-Key für den Tooltip auf dem Spaltentitel. */
  hintKey?: string;
}

/**
 * Tabelle als CSS-Grid: eine sticky Kopfzeile mit Spaltentiteln, darunter eine
 * Datenzeile je Item. Kopf und Zeilen erben `gridTemplateColumns` vom äußeren
 * Grid, damit die Spalten exakt fluchten. Datenzeilen werden als Kinder
 * übergeben (jede Zeile = `ResRow`).
 */
function ResTable({
  columns,
  template,
  children,
}: {
  columns: ResColumn[];
  template: string;
  children: React.ReactNode;
}) {
  return (
    <div className="res-table" style={{ gridTemplateColumns: template }}>
      <div className="res-thead">
        {columns.map((c, i) => (
          <div
            key={i}
            className={`res-th${c.align === "right" ? " num" : ""}`}
            title={c.hintKey ? t(c.hintKey) : undefined}
          >
            {c.titleKey ? t(c.titleKey) : ""}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

/** Eine Datenzeile der Tabelle (Zellen als Kinder, eine je Spalte). */
function ResRow({ children }: { children: React.ReactNode }) {
  return <div className="res-tr">{children}</div>;
}

/** Eine Tabellenzelle; optional rechtsbündig (für Zahlen). */
function ResCell({
  children,
  align,
  emphasis = false,
}: {
  children: React.ReactNode;
  align?: "right";
  emphasis?: boolean;
}) {
  return (
    <div
      className={`res-td${align === "right" ? " num" : ""}${
        emphasis ? " emphasis" : ""
      }`}
    >
      {children}
    </div>
  );
}

// ── Bauteile (Components) ──────────────────────────────────────────────────

// Spalten: Name | Vordergrund | Hintergrund | Schnittschraffur | Ansichtsschraffur | Prio | Textur | Material | (löschen).
const COMPONENT_COLUMNS: ResColumn[] = [
  { titleKey: "resources.col.name" },
  { titleKey: "resources.col.foreground", hintKey: "resources.col.foreground.hint" },
  { titleKey: "resources.col.background", hintKey: "resources.col.background.hint" },
  { titleKey: "resources.col.hatch" },
  { titleKey: "resources.col.viewHatch" },
  {
    titleKey: "resources.col.prio",
    align: "right",
    hintKey: "resources.col.prio.hint",
  },
  { titleKey: "resources.col.texture" },
  { titleKey: "resources.col.material" },
  { titleKey: "" },
];
const COMPONENT_TEMPLATE =
  "minmax(120px, 1fr) auto auto minmax(120px, 0.8fr) minmax(120px, 0.8fr) 64px minmax(90px, 0.7fr) minmax(130px, 0.9fr) 36px";

/**
 * Material-Zelle der Bauteil-Tabelle: ein Button, der den aktuellen Material-
 * Namen zeigt (oder „ohne") und ein Auswahl-Modal öffnet. Die Zuweisung läuft
 * über `onAssign`/`onClear` (immutabel via onPatchComponent).
 */
function MaterialCell({
  material,
  onAssign,
  onClear,
}: {
  material: ComponentMaterial | undefined;
  onAssign: (m: ComponentMaterial) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = materialLabel(material);
  return (
    <>
      <button
        className="res-select res-material-btn"
        onClick={() => setOpen(true)}
        title={t("material.assign")}
      >
        {material?.color && (
          <span
            className="res-material-swatch"
            style={{ backgroundImage: `url(${material.color})` }}
          />
        )}
        <span className="res-material-name">{label}</span>
      </button>
      {open && (
        <MaterialPicker
          material={material}
          onAssign={(m) => {
            onAssign(m);
          }}
          onClear={() => {
            onClear();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Anzeigename eines zugewiesenen Materials (Bibliothek → Name, sonst Upload). */
function materialLabel(m: ComponentMaterial | undefined): string {
  if (!m) return t("material.none");
  if (m.libraryId) {
    const asset = MATERIAL_LIBRARY.find((a) => a.id === m.libraryId);
    if (asset) return asset.name;
  }
  return t("material.uploaded");
}

/**
 * Material-Auswahl-Modal: oben die eingebaute Bibliothek als Vorschau-Grid
 * (Farb-Karte als Thumbnail) — Klick weist sofort zu; darunter ein Upload-
 * Bereich (Farbe/Normal/Rauheit/Höhe/AO als Bild-Dateien → ObjectURL) plus die
 * physische Kachelgröße. „Zuweisen" übernimmt den Upload; „Material entfernen"
 * setzt das Bauteil auf kein Material zurück.
 */
function MaterialPicker({
  material,
  onAssign,
  onClear,
  onClose,
}: {
  material: ComponentMaterial | undefined;
  onAssign: (m: ComponentMaterial) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  // Upload-Zustand: gewählte Karten als ObjectURLs + Kachelgröße. Startwert aus
  // einem bereits zugewiesenen Upload-Material (damit Größe/Karten sichtbar sind).
  const [upload, setUpload] = useState<ComponentMaterial>(() =>
    material && !material.libraryId ? { ...material } : { sizeM: DEFAULT_TILE_SIZE_M },
  );
  const [sizeM, setSizeM] = useState<number>(material?.sizeM ?? DEFAULT_TILE_SIZE_M);
  // Modus des Pickers: Schnellauswahl (lokaler Starter, offline), Live-Browse
  // der kompletten ambientCG-Bibliothek, oder Upload eigener Karten.
  const [mode, setMode] = useState<"starter" | "browse" | "upload">("starter");

  const pickFile = (kind: keyof ComponentMaterial) => (file: File | null) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setUpload((u) => ({ ...u, [kind]: url }));
  };

  const uploadFields: { kind: keyof ComponentMaterial; labelKey: string }[] = [
    { kind: "color", labelKey: "material.upload.color" },
    { kind: "normal", labelKey: "material.upload.normal" },
    { kind: "roughness", labelKey: "material.upload.roughness" },
    { kind: "displacement", labelKey: "material.upload.displacement" },
    { kind: "ao", labelKey: "material.upload.ao" },
  ];

  const applyUpload = () => {
    if (!upload.color && !upload.normal && !upload.roughness && !upload.ao && !upload.displacement) {
      return;
    }
    onAssign({ ...upload, libraryId: undefined, sizeM });
    onClose();
  };

  return (
    <div className="res-overlay mat-overlay" onClick={onClose}>
      <div
        className="mat-dialog"
        role="dialog"
        aria-label={t("material.dialog.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mat-head">
          <span className="mat-title">{t("material.dialog.title")}</span>
          <button className="res-close" onClick={onClose} aria-label={t("material.close")}>
            ×
          </button>
        </header>
        <div className="mat-hint">{t("material.dialog.hint")}</div>

        {/* Modus-Umschalter: Schnellauswahl / Bibliothek durchsuchen / Upload. */}
        <nav className="mat-modes" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "starter"}
            className={`mat-mode-btn${mode === "starter" ? " active" : ""}`}
            onClick={() => setMode("starter")}
          >
            {t("material.browse.starter")}
          </button>
          <button
            role="tab"
            aria-selected={mode === "browse"}
            className={`mat-mode-btn${mode === "browse" ? " active" : ""}`}
            onClick={() => setMode("browse")}
          >
            {t("material.browse")}
          </button>
          <button
            role="tab"
            aria-selected={mode === "upload"}
            className={`mat-mode-btn${mode === "upload" ? " active" : ""}`}
            onClick={() => setMode("upload")}
          >
            {t("material.upload")}
          </button>
        </nav>

        {/* Schnellauswahl: lokaler 12er-Starter (offline verfügbar). */}
        {mode === "starter" && (
          <div className="mat-grid">
            {MATERIAL_LIBRARY.map((asset) => (
              <button
                key={asset.id}
                className={`mat-tile${material?.libraryId === asset.id ? " active" : ""}`}
                title={asset.name}
                onClick={() => {
                  onAssign(materialFromAsset(asset, sizeM));
                  onClose();
                }}
              >
                <span
                  className="mat-thumb"
                  style={{ backgroundImage: `url(${asset.maps.color})` }}
                />
                <span className="mat-tile-name">{asset.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Live-Browse der kompletten ambientCG-Bibliothek. */}
        {mode === "browse" && (
          <AmbientBrowser
            sizeM={sizeM}
            activeId={material?.libraryId}
            onAssign={(m) => {
              onAssign(m);
              onClose();
            }}
          />
        )}

        {/* Upload eigener Karten. */}
        {mode === "upload" && (
          <>
            <div className="mat-hint">{t("material.upload.hint")}</div>
            <div className="mat-upload-grid">
              {uploadFields.map((f) => (
                <label key={f.kind} className="mat-upload-row">
                  <span className="mat-upload-label">{t(f.labelKey)}</span>
                  <ImagePickButton onFile={pickFile(f.kind)} />
                  {upload[f.kind] && <span className="mat-upload-ok">✓</span>}
                </label>
              ))}
              <label className="mat-upload-row">
                <span className="mat-upload-label">{t("material.size")}</span>
                <input
                  type="number"
                  className="res-input mono num"
                  value={sizeM}
                  step={0.1}
                  min={0.05}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v > 0) setSizeM(v);
                  }}
                />
              </label>
            </div>
            <div className="mat-actions">
              <button className="res-add" onClick={applyUpload}>
                {t("material.upload.apply")}
              </button>
            </div>
          </>
        )}

        {/* Kachelgröße (m) für Schnellauswahl + Browse, plus Material entfernen. */}
        {mode !== "upload" && (
          <div className="mat-actions mat-actions-browse">
            <label className="mat-size-inline">
              <span className="mat-upload-label">{t("material.size")}</span>
              <input
                type="number"
                className="res-input mono num"
                value={sizeM}
                step={0.1}
                min={0.05}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v > 0) setSizeM(v);
                }}
              />
            </label>
            <button
              className="res-add mat-danger"
              onClick={() => {
                onClear();
                onClose();
              }}
            >
              {t("material.clear")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Live-Browse der kompletten ambientCG-Bibliothek: Suchfeld + Kategorie-Filter
 * + Auflösungswahl über der Trefferliste, Thumbnail-Grid (aus der API, direkt
 * geladen — CORS `*`) mit Pagination („mehr laden"). Ein Klick lädt die Textur-
 * Karten des Materials herunter (`fetchMaterialMaps`, über den Proxy), entpackt
 * sie und weist das entstehende `ComponentMaterial` zu. Lade-/Fehlerzustände
 * sauber (Spinner, Offline-/CORS-Hinweis).
 */
function AmbientBrowser({
  sizeM,
  activeId,
  onAssign,
}: {
  sizeM: number;
  activeId: string | undefined;
  onAssign: (m: ComponentMaterial) => void;
}) {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [category, setCategory] = useState("");
  const [resolution, setResolution] = useState<AmbientResolution>("1K");
  const [items, setItems] = useState<AmbientMaterial[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ID des gerade herunterladenden Materials (Spinner auf der Kachel).
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const LIMIT = 24;

  // Suche (bei committedQuery/category-Wechsel neu laden — Seite 0).
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    searchMaterials({
      query: committedQuery,
      category,
      limit: LIMIT,
      offset: 0,
      signal: ctrl.signal,
    })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
        setOffset(0);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setError(t("material.browse.error"));
        setItems([]);
        setTotal(0);
        console.error("[ambientcg] search failed:", e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [committedQuery, category]);

  const loadMore = () => {
    const nextOffset = offset + LIMIT;
    setLoading(true);
    searchMaterials({ query: committedQuery, category, limit: LIMIT, offset: nextOffset })
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setTotal(res.total);
        setOffset(nextOffset);
      })
      .catch((e) => {
        setError(t("material.browse.error"));
        console.error("[ambientcg] load more failed:", e);
      })
      .finally(() => setLoading(false));
  };

  const pick = async (id: string) => {
    setDownloadingId(id);
    setError(null);
    try {
      const { material } = await fetchMaterialMaps(id, resolution, sizeM);
      onAssign(material);
    } catch (e) {
      setError(t("material.browse.downloadError"));
      console.error("[ambientcg] download failed:", e);
    } finally {
      setDownloadingId(null);
    }
  };

  const submitSearch = () => setCommittedQuery(query);

  return (
    <div className="mat-browse">
      <div className="mat-hint">{t("material.browse.hint")}</div>
      <div className="mat-browse-bar">
        <input
          type="text"
          className="res-input mat-search"
          value={query}
          placeholder={t("material.browse.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitSearch();
          }}
        />
        <button className="res-add" onClick={submitSearch}>
          {t("material.browse.search")}
        </button>
        <select
          className="res-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t("material.browse.category.all")}</option>
          {AMBIENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="res-select"
          value={resolution}
          title={t("material.browse.resolution")}
          onChange={(e) => setResolution(e.target.value as AmbientResolution)}
        >
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
      </div>

      {error && <div className="mat-browse-error">{error}</div>}

      <div className="mat-grid mat-browse-grid">
        {items.map((it) => (
          <button
            key={it.id}
            className={`mat-tile${activeId === it.id ? " active" : ""}${
              downloadingId === it.id ? " loading" : ""
            }`}
            title={`${it.name}${it.category ? ` — ${it.category}` : ""}`}
            disabled={downloadingId !== null}
            onClick={() => pick(it.id)}
          >
            <span
              className="mat-thumb"
              style={{ backgroundImage: it.thumbUrl ? `url(${it.thumbUrl})` : undefined }}
            />
            {downloadingId === it.id && <span className="mat-tile-spinner" />}
            <span className="mat-tile-name">{it.name}</span>
          </button>
        ))}
      </div>

      {!loading && items.length === 0 && !error && (
        <div className="res-empty">{t("material.browse.empty")}</div>
      )}

      <div className="mat-browse-foot">
        {loading && <span className="mat-browse-status">{t("material.browse.loading")}</span>}
        {!loading && items.length > 0 && (
          <span className="mat-browse-status">
            {t("material.browse.count", { shown: items.length, total })}
          </span>
        )}
        {!loading && items.length < total && (
          <button className="res-add" onClick={loadMore}>
            {t("material.browse.more")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Versteckter Bild-Datei-Picker mit sichtbarem Button. */
function ImagePickButton({ onFile }: { onFile: (file: File | null) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button className="res-add mat-pick" onClick={() => ref.current?.click()}>
        {t("material.upload.choose")}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
    </>
  );
}

function ComponentRow({
  component,
  hatches,
  onPatch,
  onDelete,
}: {
  component: Component;
  hatches: HatchStyle[];
  onPatch: (patch: Partial<Component>) => void;
  onDelete: () => void;
}) {
  const hatchOptions = hatches.map((h) => ({ value: h.id, label: h.name }));
  // Ansichts-Schraffur ist optional; Leer-Eintrag = keine Schraffur (weiss).
  const viewHatchOptions = [
    { value: "", label: t("resources.viewHatch.none") },
    ...hatchOptions,
  ];
  return (
    <ResRow>
      <ResCell>
        <TextField
          value={component.name}
          onChange={(name) => onPatch({ name })}
          placeholder={t("resources.components.placeholder")}
        />
      </ResCell>
      <ResCell>
        {/* Vordergrund = Farbe der Muster-/Schraffurlinien. Fehlt sie, greift
            als Anzeige-Fallback `color`; das Setzen definiert `foreground`. */}
        <ColorField
          color={component.foreground ?? component.color}
          onChange={(foreground) => onPatch({ foreground })}
        />
      </ResCell>
      <ResCell>
        {/* Hintergrund = Füllung (Poché). Fehlt sie, gilt `color` als Fallback. */}
        <ColorField
          color={component.background ?? component.color}
          onChange={(background) => onPatch({ background })}
        />
      </ResCell>
      <ResCell>
        <SelectField
          value={component.hatchId}
          onChange={(hatchId) => onPatch({ hatchId })}
          options={hatchOptions}
        />
      </ResCell>
      <ResCell>
        <SelectField
          value={component.viewHatchId ?? ""}
          onChange={(viewHatchId) => onPatch({ viewHatchId: viewHatchId || undefined })}
          options={viewHatchOptions}
        />
      </ResCell>
      <ResCell align="right" emphasis>
        <NumberField
          value={component.joinPriority}
          onChange={(joinPriority) => onPatch({ joinPriority })}
          step={10}
          min={0}
        />
      </ResCell>
      <ResCell>
        <TextField
          value={component.texture3d ?? ""}
          onChange={(v) => onPatch({ texture3d: v || undefined })}
          placeholder={t("resources.texture.empty")}
          mono
        />
      </ResCell>
      <ResCell>
        <MaterialCell
          material={component.material}
          onAssign={(material) => onPatch({ material })}
          onClear={() => onPatch({ material: undefined })}
        />
      </ResCell>
      <ResCell>
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.component", { name: component.name })}
        />
      </ResCell>
    </ResRow>
  );
}

function ComponentsTab({
  project,
  onPatchComponent,
  onAddComponent,
  onDeleteComponent,
}: {
  project: Project;
  onPatchComponent: (id: string, patch: Partial<Component>) => void;
  onAddComponent: () => void;
  onDeleteComponent: (id: string) => void;
}) {
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.components.hint")}</div>
      <ResTable columns={COMPONENT_COLUMNS} template={COMPONENT_TEMPLATE}>
        {project.components.map((c) => (
          <ComponentRow
            key={c.id}
            component={c}
            hatches={project.hatches}
            onPatch={(patch) => onPatchComponent(c.id, patch)}
            onDelete={() => onDeleteComponent(c.id)}
          />
        ))}
        {project.components.length === 0 && (
          <EmptyState text={t("resources.components.empty")} />
        )}
      </ResTable>
      <AddButton label={t("resources.add")} onClick={onAddComponent} />
    </div>
  );
}

// ── Schraffuren (Hatches) ──────────────────────────────────────────────────

/** Detail-Panel EINER Schraffur (rechte Seite des Master-Detail-Layouts). */
function HatchDetail({
  hatch,
  lineStyles,
  onPatch,
  onDelete,
}: {
  hatch: HatchStyle;
  lineStyles: LineStyle[];
  onPatch: (patch: Partial<HatchStyle>) => void;
  onDelete: () => void;
}) {
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.lineStyle.none") },
    ...lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const kind = hatch.kind ?? "vector";
  const lines = hatch.lines ?? "parallel";

  /** Wechselt den Typ; beim Umschalten auf „Bild" Default-Bildparameter setzen. */
  const setKind = (k: "vector" | "image") => {
    if (k === "image" && !hatch.image) {
      onPatch({ kind: k, image: { src: "", scaleX: 1, scaleY: 1, rotation: 0 } });
    } else {
      onPatch({ kind: k });
    }
  };

  /** Merge-Patch für die Bild-Parameter (behält bestehende Werte). */
  const patchImage = (part: Partial<NonNullable<HatchStyle["image"]>>) => {
    const cur = hatch.image ?? { src: "", scaleX: 1, scaleY: 1, rotation: 0 };
    onPatch({ image: { ...cur, ...part } });
  };

  /** Datei → Data-URL (readAsDataURL) → image.src. */
  const loadImage = (file: File | null) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => patchImage({ src: String(r.result ?? "") });
    r.readAsDataURL(file);
  };

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={hatch.name}
          placeholder={t("resources.hatches.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.hatch", { name: hatch.name })}
        />
      </div>

      <div className="res-md-preview">
        <HatchSwatch hatch={hatch} size={128} />
      </div>

      <div className="res-fields">
        <FieldRow label={t("resources.field.type")}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "vector", label: t("resources.hatchKind.vector") },
              { value: "image", label: t("resources.hatchKind.image") },
            ]}
          />
        </FieldRow>

        {kind === "vector" ? (
          <>
            <FieldRow label={t("resources.field.lines")}>
              <Segmented
                value={lines}
                onChange={(v) => onPatch({ lines: v })}
                options={[
                  { value: "parallel", label: t("resources.lines.parallel") },
                  { value: "random", label: t("resources.lines.random") },
                ]}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.pattern")}>
              <SelectField
                value={hatch.pattern}
                onChange={(pattern) => onPatch({ pattern })}
                options={PATTERN_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.labelKey),
                }))}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.scale")}>
              <NumberField
                value={hatch.scale}
                onChange={(scale) => onPatch({ scale })}
                step={0.1}
                min={0.01}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.angle")}>
              <NumberField
                value={hatch.angle}
                onChange={(angle) => onPatch({ angle })}
                step={5}
              />
            </FieldRow>
            <FieldRow
              label={t("resources.col.relativeToWall")}
              hint={t("resources.col.relativeToWall.hint")}
            >
              <input
                type="checkbox"
                checked={!!hatch.relativeToWall}
                onChange={(e) => onPatch({ relativeToWall: e.target.checked })}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.lineStyle")}>
              <SelectField
                value={hatch.lineStyleId ?? NONE}
                onChange={(v) => onPatch({ lineStyleId: v === NONE ? undefined : v })}
                options={lineOptions}
              />
            </FieldRow>
          </>
        ) : (
          <>
            <FieldRow label={t("resources.field.image")}>
              <ImagePickButton onFile={loadImage} />
            </FieldRow>
            <FieldRow label={t("resources.field.scaleX")}>
              <NumberField
                value={hatch.image?.scaleX ?? 1}
                onChange={(scaleX) => patchImage({ scaleX })}
                step={0.1}
                min={0.05}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.scaleY")}>
              <NumberField
                value={hatch.image?.scaleY ?? 1}
                onChange={(scaleY) => patchImage({ scaleY })}
                step={0.1}
                min={0.05}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.rotation")}>
              <NumberField
                value={hatch.image?.rotation ?? 0}
                onChange={(rotation) => patchImage({ rotation })}
                step={5}
              />
            </FieldRow>
          </>
        )}
      </div>
    </div>
  );
}

function HatchesTab({
  project,
  onPatchHatch,
  onAddHatch,
  onDeleteHatch,
  onImportHatches,
}: {
  project: Project;
  onPatchHatch: (id: string, patch: Partial<HatchStyle>) => void;
  onAddHatch: () => void;
  onDeleteHatch: (id: string) => void;
  onImportHatches: (hatches: Omit<HatchStyle, "id">[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hatches = project.hatches;
  // Auswahl gegen die Liste validieren (nach Delete/Add stabil bleiben).
  const selected = hatches.find((h) => h.id === selectedId) ?? hatches[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.hatches.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {hatches.map((h) => (
            <button
              key={h.id}
              className={`res-md-row${selected?.id === h.id ? " active" : ""}`}
              onClick={() => setSelectedId(h.id)}
            >
              <span className="res-md-row-thumb">
                <HatchSwatch hatch={h} size={30} />
              </span>
              <span className="res-md-row-name">{h.name}</span>
            </button>
          ))}
          {hatches.length === 0 && (
            <div className="res-md-empty">{t("resources.hatches.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={onAddHatch}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
            <FileImportButton
              accept=".pat,text/plain"
              label={t("resources.import.pat")}
              onText={(text) => onImportHatches(patToHatches(text))}
            />
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <HatchDetail
              key={selected.id}
              hatch={selected}
              lineStyles={project.lineStyles}
              onPatch={(patch) => onPatchHatch(selected.id, patch)}
              onDelete={() => onDeleteHatch(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.hatches.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Linien (Line Styles) ───────────────────────────────────────────────────

/** Detail-Panel EINES Linienstils (rechte Seite des Master-Detail-Layouts). */
function LineStyleDetail({
  style,
  onPatch,
  onDelete,
}: {
  style: LineStyle;
  onPatch: (patch: Partial<LineStyle>) => void;
  onDelete: () => void;
}) {
  const kind = style.kind ?? "dash";

  /** Wechselt den Typ; beim Umschalten auf „Zickzack" Default-Parameter setzen. */
  const setKind = (k: "dash" | "zigzag") => {
    if (k === "zigzag" && !style.zigzag) {
      onPatch({ kind: k, zigzag: { amplitude: 1, wavelength: 4 } });
    } else {
      onPatch({ kind: k });
    }
  };

  /** Merge-Patch für die Zickzack-Parameter. */
  const patchZig = (part: Partial<NonNullable<LineStyle["zigzag"]>>) => {
    const cur = style.zigzag ?? { amplitude: 1, wavelength: 4 };
    onPatch({ zigzag: { ...cur, ...part } });
  };

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={style.name}
          placeholder={t("resources.lines.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.lineStyle", { name: style.name })}
        />
      </div>

      <div className="res-md-preview">
        <LineSwatch style={style} width={220} height={40} />
      </div>

      <div className="res-fields">
        <FieldRow label={t("resources.field.type")}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "dash", label: t("resources.lineKind.dash") },
              { value: "zigzag", label: t("resources.lineKind.zigzag") },
            ]}
          />
        </FieldRow>
        <FieldRow label={t("resources.col.weight")}>
          <NumberField
            value={style.weight}
            onChange={(weight) => onPatch({ weight })}
            step={0.05}
            min={0.01}
            max={2}
            list="pen-weights"
          />
        </FieldRow>
        <FieldRow label={t("resources.col.color")}>
          <ColorField color={style.color} onChange={(color) => onPatch({ color })} />
        </FieldRow>
        {kind === "zigzag" ? (
          <>
            <FieldRow label={t("resources.field.amplitude")}>
              <NumberField
                value={style.zigzag?.amplitude ?? 1}
                onChange={(amplitude) => patchZig({ amplitude })}
                step={0.1}
                min={0.05}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.wavelength")}>
              <NumberField
                value={style.zigzag?.wavelength ?? 4}
                onChange={(wavelength) => patchZig({ wavelength })}
                step={0.5}
                min={0.5}
              />
            </FieldRow>
          </>
        ) : (
          <FieldRow label={t("resources.col.stroke")}>
            <SelectField
              value={dashKey(style.dash)}
              onChange={(key) => {
                const opt = DASH_OPTIONS.find((o) => o.key === key);
                if (opt) onPatch({ dash: opt.dash });
              }}
              options={DASH_OPTIONS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
            />
          </FieldRow>
        )}
      </div>
    </div>
  );
}

function LinesTab({
  project,
  onPatchLineStyle,
  onAddLineStyle,
  onDeleteLineStyle,
  onImportLineStyles,
}: {
  project: Project;
  onPatchLineStyle: (id: string, patch: Partial<LineStyle>) => void;
  onAddLineStyle: () => void;
  onDeleteLineStyle: (id: string) => void;
  onImportLineStyles: (styles: Omit<LineStyle, "id">[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const styles = project.lineStyles;
  const selected = styles.find((l) => l.id === selectedId) ?? styles[0];

  return (
    <div className="res-tab">
      {/* Vorschlagswerte für die Strichstärke (Standard-Stiftbreiten in mm). */}
      <datalist id="pen-weights">
        {PEN_WEIGHTS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <div className="res-hint">{t("resources.lines.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {styles.map((l) => (
            <button
              key={l.id}
              className={`res-md-row res-md-row-line${
                selected?.id === l.id ? " active" : ""
              }`}
              onClick={() => setSelectedId(l.id)}
            >
              <span className="res-md-row-name">{l.name}</span>
              <LineSwatch style={l} width={150} height={14} />
            </button>
          ))}
          {styles.length === 0 && (
            <div className="res-md-empty">{t("resources.lines.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={onAddLineStyle}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
            <FileImportButton
              accept=".lin,text/plain"
              label={t("resources.import.lin")}
              onText={(text) => onImportLineStyles(linToStyles(text))}
            />
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <LineStyleDetail
              key={selected.id}
              style={selected}
              onPatch={(patch) => onPatchLineStyle(selected.id, patch)}
              onDelete={() => onDeleteLineStyle(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.lines.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Wandstile (Wall Styles) ────────────────────────────────────────────────
// Pro Wandtyp die geordneten Schichten (Bauteil + Dicke) und je INNERER Fuge
// (zwischen zwei aufeinanderfolgenden Schichten) ein LineStyle-Dropdown, das an
// layer[i].jointLineStyleId hängt (i = Schicht, deren innere Kante die Fuge ist).
// Die innerste Schicht hat keine innere Fuge (ihre Kante ist der Wand-Innenumriss).

// Spalten: Schicht | Dicke (mm) | Fuge (innere).
const WALLSTYLE_COLUMNS: ResColumn[] = [
  { titleKey: "resources.col.layer" },
  { titleKey: "resources.col.thickness", align: "right" },
  { titleKey: "resources.col.joint" },
];
const WALLSTYLE_TEMPLATE = "minmax(120px, 1fr) 72px minmax(140px, 1.2fr)";

function WallStylesTab({
  project,
  onPatchWallType,
}: {
  project: Project;
  onPatchWallType: (id: string, patch: Partial<WallType>) => void;
}) {
  // Sentinel „— (Haarlinie)": kein Feld gesetzt → Standard-Haarlinie 0.02 mm.
  const DEFAULT = "__default__";
  const jointOptions = [
    { value: DEFAULT, label: t("resources.joint.default") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const setJoint = (wt: WallType, li: number, styleId: string | undefined) => {
    const layers = wt.layers.map((l, i) =>
      i === li ? { ...l, jointLineStyleId: styleId } : l,
    );
    onPatchWallType(wt.id, { layers });
  };
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.wallStyles.hint")}</div>
      {project.wallTypes.map((wt) => (
        <div key={wt.id} className="res-wallstyle">
          <div className="res-wallstyle-head">{wt.name}</div>
          <ResTable columns={WALLSTYLE_COLUMNS} template={WALLSTYLE_TEMPLATE}>
            {wt.layers.map((layer, li) => {
              const comp = project.components.find((c) => c.id === layer.componentId);
              const isInner = li === wt.layers.length - 1;
              return (
                <ResRow key={li}>
                  <ResCell emphasis>{comp ? comp.name : layer.componentId}</ResCell>
                  <ResCell align="right">{Math.round(layer.thickness * 1000)}</ResCell>
                  <ResCell>
                    {isInner ? (
                      <span className="res-joint-none">–</span>
                    ) : (
                      <SelectField
                        value={layer.jointLineStyleId ?? DEFAULT}
                        onChange={(v) => setJoint(wt, li, v === DEFAULT ? undefined : v)}
                        options={jointOptions}
                      />
                    )}
                  </ResCell>
                </ResRow>
              );
            })}
          </ResTable>
        </div>
      ))}
      {project.wallTypes.length === 0 && (
        <EmptyState text={t("resources.wallStyles.empty")} />
      )}
    </div>
  );
}

/**
 * Tab „Deckenstile" — das liegende Gegenstück zu {@link WallStylesTab}: pro
 * Deckentyp (`project.ceilingTypes`) die Schichten mit Dicke + einem per-Fuge
 * wählbaren Linienstil (Line Manager). Gleiche Tabelle/Sentinel-Logik wie bei
 * den Wandstilen — nur die Ressource (`ceilingTypes` statt `wallTypes`) und der
 * Handler (`onPatchCeilingType`) unterscheiden sich.
 */
function CeilingStylesTab({
  project,
  onPatchCeilingType,
}: {
  project: Project;
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
}) {
  const DEFAULT = "__default__";
  const jointOptions = [
    { value: DEFAULT, label: t("resources.joint.default") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const setJoint = (ct: CeilingType, li: number, styleId: string | undefined) => {
    const layers = ct.layers.map((l, i) =>
      i === li ? { ...l, jointLineStyleId: styleId } : l,
    );
    onPatchCeilingType(ct.id, { layers });
  };
  const ceilingTypes = project.ceilingTypes ?? [];
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.ceilingStyles.hint")}</div>
      {ceilingTypes.map((ct) => (
        <div key={ct.id} className="res-wallstyle">
          <div className="res-wallstyle-head">{ct.name}</div>
          <ResTable columns={WALLSTYLE_COLUMNS} template={WALLSTYLE_TEMPLATE}>
            {ct.layers.map((layer, li) => {
              const comp = project.components.find((c) => c.id === layer.componentId);
              const isInner = li === ct.layers.length - 1;
              return (
                <ResRow key={li}>
                  <ResCell emphasis>{comp ? comp.name : layer.componentId}</ResCell>
                  <ResCell align="right">{Math.round(layer.thickness * 1000)}</ResCell>
                  <ResCell>
                    {isInner ? (
                      <span className="res-joint-none">–</span>
                    ) : (
                      <SelectField
                        value={layer.jointLineStyleId ?? DEFAULT}
                        onChange={(v) => setJoint(ct, li, v === DEFAULT ? undefined : v)}
                        options={jointOptions}
                      />
                    )}
                  </ResCell>
                </ResRow>
              );
            })}
          </ResTable>
        </div>
      ))}
      {ceilingTypes.length === 0 && (
        <EmptyState text={t("resources.ceilingStyles.empty")} />
      )}
    </div>
  );
}

/**
 * Datei-Import-Schaltfläche (verstecktes <input type=file>). Liest die gewählte
 * Datei als Text und reicht ihn nach oben. Für .lin/.pat-Import.
 */
function FileImportButton({
  accept,
  label,
  onText,
}: {
  accept: string;
  label: string;
  onText: (text: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button className="res-add" onClick={() => ref.current?.click()}>
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            const r = new FileReader();
            r.onload = () => onText(String(r.result ?? ""));
            r.readAsText(f);
          }
          e.target.value = "";
        }}
      />
    </>
  );
}

/** .lin-Text → id-lose Linienstile (schwarze Haarlinie 0.18 als Default). */
function linToStyles(text: string): Omit<LineStyle, "id">[] {
  return parseLin(text).map((p) => ({
    name: p.name,
    weight: 0.18,
    color: "#1a1a1a",
    dash: p.dash,
  }));
}

/**
 * .pat-Text → id-lose Schraffuren. Unser Modell kennt nur feste Muster; daher
 * approximieren wir: ≥2 Linienfamilien → Kreuzschraffur, sonst Diagonal, mit dem
 * Winkel der ersten Familie. (Vollwertiges custom-Pattern später.)
 */
function patToHatches(text: string): Omit<HatchStyle, "id">[] {
  return parsePat(text).map((p) => ({
    name: p.name,
    pattern: (p.families.length >= 2 ? "crosshatch" : "diagonal") as HatchPattern,
    scale: 1,
    angle: p.families[0]?.angle ?? 45,
    color: "#1a1a1a",
    lineStyleId: "hatch-line",
  }));
}

// ── Materialien (PBR-Bibliothek durchsuchen) ───────────────────────────────
// Eigenständiger Tab, der die eingebaute Materialbibliothek (MATERIAL_LIBRARY)
// als Kachel-Grid mit gerenderter PBR-Kugel-Vorschau zeigt — Name/Kategorie
// als Badge, Suche + Kategorie-Chips kombinierbar. Die Zuweisung an ein
// konkretes Bauteil bleibt der bestehende Weg (Spalte „Material" der Bauteil-
// Tabelle → MaterialPicker); dieser Tab dient dem Durchsuchen/Vergleichen der
// Bibliothek, Klick auf eine Kachel markiert sie (aktiv, wie `mat-tile.active`
// im Picker) und zeigt Name/Kategorie in der Statuszeile.

/**
 * Alle in der Bibliothek vorkommenden Kategorien, alphabetisch. Das Manifest
 * schreibt Kategorien uneinheitlich („PavingStones" neben „Paving Stones") —
 * für Chips und Filter zählt der normalisierte Schlüssel (ohne Leerzeichen,
 * case-insensitiv); angezeigt wird die zuerst gesehene Schreibweise.
 */
const categoryKey = (c: string) => c.replace(/\s+/g, "").toLowerCase();
const MATERIAL_CATEGORIES: string[] = (() => {
  const byKey = new Map<string, string>();
  for (const a of MATERIAL_LIBRARY) {
    const k = categoryKey(a.category);
    if (!byKey.has(k)) byKey.set(k, a.category);
  }
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
})();

/**
 * Eine Bibliotheks-Kachel: rendert erst eine PBR-Kugel-Vorschau, sobald sie
 * tatsächlich sichtbar ist (IntersectionObserver) — bei ~90 Materialien sonst
 * unnötige GPU-Arbeit für Kacheln außerhalb des Sichtfensters. Der eigentliche
 * Render läuft ohnehin seriell über einen einzigen geteilten WebGL-Kontext
 * (spherePreview.ts), die Sichtbarkeitsprüfung drosselt zusätzlich die
 * Warteschlange auf das gerade Interessante.
 */
function MaterialLibraryTile({
  asset,
  active,
  onSelect,
}: {
  asset: MaterialAsset;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handleReady = (url: string) => setPreviewUrl(url);
    const cached = requestMaterialPreview(asset, handleReady);
    if (cached) setPreviewUrl(cached);
    return () => cancelMaterialPreview(asset, handleReady);
  }, [visible, asset]);

  return (
    <button
      ref={ref}
      className={`mat-tile${active ? " active" : ""}`}
      title={`${asset.name} — ${asset.category}`}
      onClick={onSelect}
    >
      <span className="mat-sphere">
        {previewUrl && <img src={previewUrl} alt="" draggable={false} />}
      </span>
      <span className="mat-tile-name">{asset.name}</span>
      <span className="mat-tile-badge">{asset.category}</span>
    </button>
  );
}

function MaterialsTab() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = MATERIAL_LIBRARY.filter((asset) => {
    if (category && categoryKey(asset.category) !== categoryKey(category)) return false;
    const q = query.trim().toLowerCase();
    if (q && !asset.name.toLowerCase().includes(q) && !asset.id.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
  const selected = MATERIAL_LIBRARY.find((a) => a.id === selectedId);

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.materials.hint")}</div>

      <div className="mat-lib-filterbar">
        <input
          type="text"
          className="res-input mat-search"
          value={query}
          placeholder={t("resources.materials.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          className="mat-lib-chips"
          role="group"
          aria-label={t("resources.materials.categoryLabel")}
        >
          <button
            className={`mat-chip${category === null ? " active" : ""}`}
            onClick={() => setCategory(null)}
          >
            {t("resources.materials.categoryAll")}
          </button>
          {MATERIAL_CATEGORIES.map((c) => (
            <button
              key={c}
              className={`mat-chip${category === c ? " active" : ""}`}
              onClick={() => setCategory((cur) => (cur === c ? null : c))}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="mat-lib-selected">
          {t("resources.materials.selected", {
            name: selected.name,
            category: selected.category,
          })}
        </div>
      )}

      <div className="mat-grid mat-lib-grid">
        {filtered.map((asset) => (
          <MaterialLibraryTile
            key={asset.id}
            asset={asset}
            active={selectedId === asset.id}
            onSelect={() => setSelectedId((cur) => (cur === asset.id ? null : asset.id))}
          />
        ))}
      </div>
      {filtered.length === 0 && <EmptyState text={t("resources.materials.empty")} />}

      <div className="mat-browse-foot">
        <span className="mat-browse-status">
          {t("resources.materials.count", {
            shown: filtered.length,
            total: MATERIAL_LIBRARY.length,
          })}
        </span>
      </div>
    </div>
  );
}

// ── Gemeinsame kleine Bausteine ────────────────────────────────────────────

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="res-add-row">
      <button className="res-add" onClick={onClick}>
        <span className="res-add-plus">+</span> {label}
      </button>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="res-empty">{text}</div>;
}

// ── Manager-Schublade ──────────────────────────────────────────────────────

type TabId =
  | "components"
  | "hatches"
  | "lines"
  | "wallStyles"
  | "ceilingStyles"
  | "materials";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "components", labelKey: "resources.tab.components" },
  { id: "hatches", labelKey: "resources.tab.hatches" },
  { id: "lines", labelKey: "resources.tab.lines" },
  { id: "wallStyles", labelKey: "resources.tab.wallStyles" },
  { id: "ceilingStyles", labelKey: "resources.tab.ceilingStyles" },
  { id: "materials", labelKey: "resources.tab.materials" },
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
  /** Deckenstile: immutable Änderung eines Deckentyps (z. B. Schichtfugen-Stile). */
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
  /** Import: fügt fertige (id-lose) Linienstile/Schraffuren hinzu (.lin/.pat). */
  onImportLineStyles: (styles: Omit<LineStyle, "id">[]) => void;
  onImportHatches: (hatches: Omit<HatchStyle, "id">[]) => void;
}

/**
 * Rechte Schublade mit drei Tabs (Bauteile / Schraffuren / Linien). Wird über
 * den „Ressourcen"-Eintrag der Oberleiste geöffnet und mutiert das Projekt
 * live über die gereichten Handler.
 */
export function ResourceManager({
  project,
  onClose,
  handlers,
}: {
  project: Project;
  onClose: () => void;
  handlers: ResourceManagerHandlers;
}) {
  const [tab, setTab] = useState<TabId>("components");

  return (
    <div className="res-overlay" onClick={onClose}>
      <aside
        className="res-drawer"
        role="dialog"
        aria-label={t("resources.label")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="res-head">
          <div className="res-head-title">
            <span className="res-head-icon">
              <EyeIcon open />
            </span>
            {t("resources.title")}
          </div>
          <button
            className="res-close"
            onClick={onClose}
            aria-label={t("resources.close")}
          >
            ×
          </button>
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
            />
          )}
          {tab === "ceilingStyles" && (
            <CeilingStylesTab
              project={project}
              onPatchCeilingType={handlers.onPatchCeilingType}
            />
          )}
          {tab === "materials" && <MaterialsTab />}
        </div>
      </aside>
    </div>
  );
}
