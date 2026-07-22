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

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  CeilingType,
  RoofType,
  Component,
  ComponentMaterial,
  DoorType,
  HatchPattern,
  HatchStyle,
  Layer,
  LineStyle,
  OverrideConditionType,
  OverrideOperator,
  OverrideRule,
  Project,
  StairType,
  WallType,
  WindowType,
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
import { Dropdown } from "./Dropdown";
import { EyeIcon } from "./EyeIcon";
import { HatchSwatch, LineSwatch, WallTypeSwatch } from "./hatchPreview";
import type { SwatchLayer } from "./hatchPreview";
import {
  segmentsToDash,
  dashToSegments,
  presetOfDash,
  LINE_PRESETS,
  type LineSegment,
  type LineSegmentType,
  type LinePresetKey,
} from "./lineSegments";
import { MotifEditor } from "./MotifEditor";
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

/** Pill-Dropdown (nutzt die gemeinsame Dropdown-Komponente statt <select>). */
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
    <Dropdown
      value={value}
      onChange={(v) => onChange(v as T)}
      options={options}
    />
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

// ── Bauteile (Components) ──────────────────────────────────────────────────

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
        <Dropdown
          value={category}
          onChange={(v) => setCategory(v)}
          options={[
            { value: "", label: t("material.browse.category.all") },
            ...AMBIENT_CATEGORIES.map((c) => ({ value: c, label: c })),
          ]}
        />
        <Dropdown
          value={resolution}
          title={t("material.browse.resolution")}
          onChange={(v) => setResolution(v as AmbientResolution)}
          options={[
            { value: "1K", label: "1K" },
            { value: "2K", label: "2K" },
            { value: "4K", label: "4K" },
          ]}
        />
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

/** Kleiner Farb-Swatch als Listen-Thumbnail für Bauteile ohne Schraffur. */
function ColorSwatch({ color, size = 30 }: { color: string; size?: number }) {
  return (
    <span
      className="res-swatch"
      style={{
        display: "block",
        width: size,
        height: size,
        background: color,
        border: "1px solid var(--border)",
      }}
    />
  );
}

/**
 * Baut aus einem zugewiesenen Bauteil-Material ein `MaterialAsset` für die
 * PBR-Kugel-Vorschau (`requestMaterialPreview`): verweist es auf die
 * Bibliothek (`libraryId`), wird deren Asset wiederverwendet (Name/Kategorie
 * fürs Tooltip); sonst entsteht aus den hochgeladenen Karten ein Ad-hoc-Asset.
 */
function materialAssetOf(material: ComponentMaterial): MaterialAsset {
  if (material.libraryId) {
    const asset = MATERIAL_LIBRARY.find((a) => a.id === material.libraryId);
    if (asset) return asset;
  }
  return {
    id: material.libraryId ?? "custom",
    name: t("material.uploaded"),
    category: "",
    maps: {
      color: material.color,
      normal: material.normal,
      roughness: material.roughness,
      metalness: material.metalness,
      displacement: material.displacement,
      ao: material.ao,
    },
  };
}

/**
 * PBR-Kugel-Vorschau eines zugewiesenen Bauteil-Materials — dieselbe
 * Lazy-Render-Logik wie `MaterialLibraryTile` (IntersectionObserver +
 * `requestMaterialPreview`, geteilter Renderer), nur ohne Klick-Interaktion,
 * als Thumbnail-Ersatz für `ColorSwatch`/`HatchSwatch` sobald ein Bauteil ein
 * Material trägt.
 */
function ComponentMaterialSphere({
  material,
  size = 30,
}: {
  material: ComponentMaterial;
  size?: number;
}) {
  const asset = useMemo(
    () => materialAssetOf(material),
    [
      material.libraryId,
      material.color,
      material.normal,
      material.roughness,
      material.metalness,
      material.displacement,
      material.ao,
    ],
  );
  const ref = useRef<HTMLSpanElement | null>(null);
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
    <span
      ref={ref}
      className="mat-sphere"
      title={asset.name || undefined}
      style={{ width: size, height: size, flex: "0 0 auto" }}
    >
      {previewUrl && <img src={previewUrl} alt="" draggable={false} />}
    </span>
  );
}

/** Detail-Panel EINES Bauteils (rechte Seite des Master-Detail-Layouts). */
function ComponentDetail({
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
  const previewHatch = hatches.find((h) => h.id === component.hatchId);
  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={component.name}
          placeholder={t("resources.components.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.component", { name: component.name })}
        />
      </div>

      <div className="res-md-preview">
        {component.material ? (
          <ComponentMaterialSphere material={component.material} size={128} />
        ) : previewHatch ? (
          <HatchSwatch hatch={previewHatch} size={128} />
        ) : (
          <ColorSwatch color={component.foreground ?? component.color} size={128} />
        )}
      </div>

      <div className="res-fields">
        <FieldRow label={t("resources.col.abbrev")} hint={t("resources.col.abbrev.hint")}>
          <TextField
            value={component.abbrev ?? ""}
            onChange={(v) => onPatch({ abbrev: v || undefined })}
            placeholder={t("resources.col.abbrev.placeholder")}
          />
        </FieldRow>
        <FieldRow
          label={t("resources.col.foreground")}
          hint={t("resources.col.foreground.hint")}
        >
          {/* Vordergrund = Farbe der Muster-/Schraffurlinien. Fehlt sie, greift
              als Anzeige-Fallback `color`; das Setzen definiert `foreground`. */}
          <ColorField
            color={component.foreground ?? component.color}
            onChange={(foreground) => onPatch({ foreground })}
          />
        </FieldRow>
        <FieldRow
          label={t("resources.col.background")}
          hint={t("resources.col.background.hint")}
        >
          {/* Hintergrund = Füllung (Poché). Fehlt sie, gilt `color` als Fallback. */}
          <ColorField
            color={component.background ?? component.color}
            onChange={(background) => onPatch({ background })}
          />
        </FieldRow>
        <FieldRow label={t("resources.col.hatch")}>
          <SelectField
            value={component.hatchId}
            onChange={(hatchId) => onPatch({ hatchId })}
            options={hatchOptions}
          />
        </FieldRow>
        <FieldRow label={t("resources.col.viewHatch")}>
          <SelectField
            value={component.viewHatchId ?? ""}
            onChange={(viewHatchId) => onPatch({ viewHatchId: viewHatchId || undefined })}
            options={viewHatchOptions}
          />
        </FieldRow>
        <FieldRow label={t("resources.col.prio")} hint={t("resources.col.prio.hint")}>
          <NumberField
            value={component.joinPriority}
            onChange={(joinPriority) => onPatch({ joinPriority })}
            step={10}
            min={0}
          />
        </FieldRow>
        <FieldRow label={t("resources.col.texture")}>
          <TextField
            value={component.texture3d ?? ""}
            onChange={(v) => onPatch({ texture3d: v || undefined })}
            placeholder={t("resources.texture.empty")}
            mono
          />
        </FieldRow>
        <FieldRow label={t("resources.col.material")}>
          <MaterialCell
            material={component.material}
            onAssign={(material) => onPatch({ material })}
            onClear={() => onPatch({ material: undefined })}
          />
        </FieldRow>
      </div>
    </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const components = project.components;
  // Auswahl gegen die Liste validieren (nach Delete/Add stabil bleiben).
  const selected = components.find((c) => c.id === selectedId) ?? components[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.components.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {components.map((c) => {
            const hatch = project.hatches.find((h) => h.id === c.hatchId);
            return (
              <button
                key={c.id}
                className={`res-md-row${selected?.id === c.id ? " active" : ""}`}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="res-md-row-thumb">
                  {c.material ? (
                    <ComponentMaterialSphere material={c.material} size={30} />
                  ) : hatch ? (
                    <HatchSwatch hatch={hatch} size={30} />
                  ) : (
                    <ColorSwatch color={c.foreground ?? c.color} />
                  )}
                </span>
                <span className="res-md-row-name">{c.name}</span>
              </button>
            );
          })}
          {components.length === 0 && (
            <div className="res-md-empty">{t("resources.components.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAddComponent()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <ComponentDetail
              key={selected.id}
              component={selected}
              hatches={project.hatches}
              onPatch={(patch) => onPatchComponent(selected.id, patch)}
              onDelete={() => onDeleteComponent(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.components.empty")}</div>
          )}
        </div>
      </div>
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

  // ── Random-Vektor-Schraffur (Kies/Splitt) ───────────────────────────────────
  // Dichte + Längenspanne + „Neu würfeln". Der Seed wird beim Klick gesetzt (KEIN
  // Math.random() zur Renderzeit — die Streuung selbst ist deterministisch per
  // Seed). Länge min/max in mm; bis der Nutzer sie berührt, bleibt der Default.
  const lenMin = hatch.lengthMin ?? 1;
  const lenMax = hatch.lengthMax ?? 3;
  const reroll = () => onPatch({ seed: Math.floor(Math.random() * 0x7fffffff) });

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
            {lines === "random" && (
              <>
                <FieldRow label={t("resources.field.density")}>
                  <NumberField
                    value={hatch.density ?? 1}
                    onChange={(density) => onPatch({ density })}
                    step={0.1}
                    min={0.1}
                  />
                </FieldRow>
                <FieldRow label={t("resources.field.lengthMin")}>
                  <NumberField
                    value={lenMin}
                    onChange={(v) => onPatch({ lengthMin: v, lengthMax: hatch.lengthMax ?? lenMax })}
                    step={0.5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.field.lengthMax")}>
                  <NumberField
                    value={lenMax}
                    onChange={(v) => onPatch({ lengthMax: v, lengthMin: hatch.lengthMin ?? lenMin })}
                    step={0.5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.random.reroll")}>
                  <button type="button" className="res-seg-btn" onClick={reroll}>
                    {t("resources.random.reroll")}
                  </button>
                </FieldRow>
              </>
            )}
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
            <button className="res-add" onClick={() => onAddHatch()}>
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
/**
 * Default-Motiv beim Umschalten auf „Custom": eine Dreieckszelle (0..4 mm entlang,
 * ±1.5 mm quer), die entlang der Linie loopt. Der Nutzer passt sie im MotifEditor an.
 */
const DEFAULT_MOTIF: NonNullable<LineStyle["motif"]> = {
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1.5 },
    { x: 2, y: 0 },
    { x: 3, y: -1.5 },
    { x: 4, y: 0 },
  ],
  length: 4,
};

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

  /**
   * Wechselt den Typ; beim Umschalten auf „Zickzack"/„Custom" Default-Parameter
   * setzen, falls noch keine vorhanden.
   */
  const setKind = (k: "dash" | "zigzag" | "custom") => {
    if (k === "zigzag" && !style.zigzag) {
      onPatch({ kind: k, zigzag: { amplitude: 1, wavelength: 4 } });
    } else if (k === "custom" && !style.motif) {
      onPatch({ kind: k, motif: DEFAULT_MOTIF });
    } else {
      onPatch({ kind: k });
    }
  };

  /** Merge-Patch für die Zickzack-Parameter. */
  const patchZig = (part: Partial<NonNullable<LineStyle["zigzag"]>>) => {
    const cur = style.zigzag ?? { amplitude: 1, wavelength: 4 };
    onPatch({ zigzag: { ...cur, ...part } });
  };

  // ── Modulares Segment-System (dash) ─────────────────────────────────────────
  // Eine musterbasierte Linie ist eine geordnete, loopende Folge aus Segmenten
  // (Strich / Punkt / Lücke). Die Folge wird aus `dash` abgeleitet und beim
  // Editieren via `segmentsToDash` wieder nach `dash` geschrieben — `dash` bleibt
  // die einzige Datenbasis. „Volllinie" = `dash: null`. Die Dicke gehört NICHT
  // mehr hierher (sie wird per Element-Attribut aufgelöst; By-Object/By-Layer folgt).
  const dash = style.dash;
  const isSolid = dash === null;
  const segments = dashToSegments(dash);
  const preset = presetOfDash(dash);
  const applyPreset = (p: LinePresetKey) => {
    if (p === "custom") return;
    onPatch({ dash: LINE_PRESETS[p] });
  };
  const commitSegments = (next: LineSegment[]) => onPatch({ dash: segmentsToDash(next) });
  const setSegType = (i: number, type: LineSegmentType) => {
    const next = segments.slice();
    const cur = next[i];
    next[i] = { type, length: type === "dot" ? 0 : cur.length > 0 ? cur.length : 2 };
    commitSegments(next);
  };
  const setSegLen = (i: number, v: number) => {
    const next = segments.slice();
    next[i] = { ...next[i], length: Math.max(0, v) };
    commitSegments(next);
  };
  const addSegOf = (type: LineSegmentType) =>
    commitSegments([...segments, { type, length: type === "dot" ? 0 : 2 }]);
  const removeSeg = (i: number) => commitSegments(segments.filter((_, k) => k !== i));

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
              { value: "custom", label: t("resources.lineKind.custom") },
            ]}
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
        ) : kind === "custom" ? (
          <FieldRow label={t("resources.field.motif")}>
            <MotifEditor
              points={style.motif?.points ?? DEFAULT_MOTIF.points}
              length={style.motif?.length ?? DEFAULT_MOTIF.length}
              onChange={(points, length) => onPatch({ motif: { points, length } })}
            />
          </FieldRow>
        ) : (
          <>
            {/* Schnell-Presets: Volllinie / Strichlinie / Punktlinie / Strich-Punkt. */}
            <FieldRow label={t("resources.linePreset.label")}>
              <Segmented<string>
                value={preset}
                onChange={(p) => applyPreset(p as LinePresetKey)}
                options={[
                  { value: "solid", label: t("resources.linePreset.solid") },
                  { value: "dash", label: t("resources.linePreset.dash") },
                  { value: "dot", label: t("resources.linePreset.dot") },
                  { value: "dashDot", label: t("resources.linePreset.dashDot") },
                ]}
              />
            </FieldRow>
            {!isSolid && (
              <FieldRow
                label={t("resources.dash.segments")}
                hint={t("resources.dash.hint")}
              >
                <div className="line-seg-editor">
                  {segments.map((seg, i) => (
                    <div className="line-seg-row" key={i}>
                      <SelectField
                        value={seg.type}
                        onChange={(type) => setSegType(i, type)}
                        options={[
                          { value: "dash", label: t("resources.seg.dash") },
                          { value: "dot", label: t("resources.seg.dot") },
                          { value: "gap", label: t("resources.seg.gap") },
                        ]}
                      />
                      <span className="line-seg-num">
                        {seg.type === "dot" ? (
                          <span className="line-seg-dotlabel">0</span>
                        ) : (
                          <NumberField
                            value={seg.length}
                            onChange={(x) => setSegLen(i, x)}
                            step={0.5}
                            min={0}
                          />
                        )}
                      </span>
                      <button
                        type="button"
                        className="res-seg-btn"
                        title={t("resources.dash.remove")}
                        onClick={() => removeSeg(i)}
                        style={{ padding: "2px 6px", lineHeight: 1 }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="line-seg-add">
                    <button
                      type="button"
                      className="res-seg-btn"
                      onClick={() => addSegOf("dash")}
                      style={{ padding: "2px 8px", lineHeight: 1 }}
                    >
                      {t("resources.seg.addDash")}
                    </button>
                    <button
                      type="button"
                      className="res-seg-btn"
                      onClick={() => addSegOf("dot")}
                      style={{ padding: "2px 8px", lineHeight: 1 }}
                    >
                      {t("resources.seg.addDot")}
                    </button>
                    <button
                      type="button"
                      className="res-seg-btn"
                      onClick={() => addSegOf("gap")}
                      style={{ padding: "2px 8px", lineHeight: 1 }}
                    >
                      {t("resources.seg.addGap")}
                    </button>
                  </div>
                </div>
              </FieldRow>
            )}
          </>
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
            <button className="res-add" onClick={() => onAddLineStyle()}>
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

// ── Wandstile & Deckenstile (geschichteter Aufbau) ─────────────────────────
// Beide Ressourcen teilen Struktur (WallType/CeilingType = {id,name,layers[]})
// und Editor: ein Master-Detail-Layout wie bei Schraffuren/Linien. Liste links
// = je Typ eine Zeile mit kleiner Querschnitt-Vorschau + Name; Detail rechts =
// Aufbau-Editor (Schichten stapeln: Bauteil/Dicke/Fugenlinie, hinzufügen/
// entfernen/umordnen) + großer Live-Querschnitt. Ein gemeinsames Detail-Panel
// {@link LayeredStyleDetail}, parametrisiert über die Orientierung (Wand:
// Bänder nebeneinander / Decke: liegend gestapelt) und die jeweiligen Handler.
//
// Fugen: `layer[i].jointLineStyleId` ist der Linienstil der INNEREN Kante der
// Schicht i (Fuge zur nächst-inneren Schicht). Die innerste Schicht hat keine
// innere Fuge (ihre Kante ist der Innenumriss) → dort kein Dropdown.

/** Wand- und Deckentyp teilen dieselbe Form (`{id,name,layers}`). */
type LayeredStyle = WallType | CeilingType;

/**
 * Baut die Querschnitt-Bänder (eine je Schicht) aus den Bauteil-Schnitt-
 * schraffuren: Schicht → Bauteil → dessen `hatchId` → HatchStyle. Fehlt das
 * Bauteil/die Schraffur, bleibt das Band leer (weiß).
 */
function swatchLayersOf(style: LayeredStyle, project: Project): SwatchLayer[] {
  return style.layers.map((l) => {
    const comp = project.components.find((c) => c.id === l.componentId);
    const hatch = comp
      ? project.hatches.find((hh) => hh.id === comp.hatchId)
      : undefined;
    return { hatch, thickness: l.thickness };
  });
}

/** Detail-Panel EINES Wand-/Deckentyps (rechte Seite des Master-Detail-Layouts). */
function LayeredStyleDetail({
  style,
  project,
  orientation,
  onPatch,
  onDelete,
  deleteTitle,
  namePlaceholder,
}: {
  style: LayeredStyle;
  project: Project;
  orientation: "wall" | "ceiling";
  onPatch: (patch: Partial<LayeredStyle>) => void;
  onDelete: () => void;
  deleteTitle: string;
  namePlaceholder: string;
}) {
  // Sentinel „— (Haarlinie)": kein Feld gesetzt → Standard-Haarlinie 0.02 mm.
  const DEFAULT = "__default__";
  const jointOptions = [
    { value: DEFAULT, label: t("resources.joint.default") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const compOptions =
    project.components.length > 0
      ? project.components.map((c) => ({ value: c.id, label: c.name }))
      : [{ value: "", label: "—" }];

  const layers = style.layers;
  const setLayers = (next: Layer[]) => onPatch({ layers: next });
  const patchLayer = (i: number, patch: Partial<Layer>) =>
    setLayers(layers.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLayer = () =>
    setLayers([
      ...layers,
      { componentId: project.components[0]?.id ?? "", thickness: 0.1 },
    ]);
  const removeLayer = (i: number) => {
    if (layers.length <= 1) return;
    setLayers(layers.filter((_, k) => k !== i));
  };
  const moveLayer = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setLayers(next);
  };

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={style.name}
          placeholder={namePlaceholder}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton onClick={onDelete} title={deleteTitle} />
      </div>

      <div className="res-md-preview">
        <WallTypeSwatch
          layers={swatchLayersOf(style, project)}
          width={orientation === "wall" ? 240 : 132}
          height={orientation === "wall" ? 96 : 132}
          orientation={orientation}
        />
      </div>

      <div className="res-layers">
        {layers.map((layer, i) => {
          const isInner = i === layers.length - 1;
          return (
            <div key={i} className="res-layer">
              <div className="res-layer-move">
                <button
                  type="button"
                  className="res-layer-btn"
                  title={t("resources.layer.moveUp")}
                  disabled={i === 0}
                  onClick={() => moveLayer(i, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="res-layer-btn"
                  title={t("resources.layer.moveDown")}
                  disabled={isInner}
                  onClick={() => moveLayer(i, 1)}
                >
                  ▼
                </button>
              </div>
              <div className="res-layer-fields">
                <FieldRow label={t("resources.col.component")}>
                  <SelectField
                    value={layer.componentId}
                    onChange={(componentId) => patchLayer(i, { componentId })}
                    options={compOptions}
                  />
                </FieldRow>
                <FieldRow label={t("resources.col.thickness")}>
                  <NumberField
                    value={Math.round(layer.thickness * 1000)}
                    onChange={(mm) =>
                      patchLayer(i, { thickness: Math.max(0, mm) / 1000 })
                    }
                    step={5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.col.joint")}>
                  {isInner ? (
                    <span className="res-joint-none">–</span>
                  ) : (
                    <SelectField
                      value={layer.jointLineStyleId ?? DEFAULT}
                      onChange={(v) =>
                        patchLayer(i, {
                          jointLineStyleId: v === DEFAULT ? undefined : v,
                        })
                      }
                      options={jointOptions}
                    />
                  )}
                </FieldRow>
              </div>
              <DeleteButton
                onClick={() => removeLayer(i)}
                title={t("resources.layer.remove")}
              />
            </div>
          );
        })}
        <button type="button" className="res-add" onClick={addLayer}>
          <span className="res-add-plus">+</span> {t("resources.layer.add")}
        </button>
      </div>
    </div>
  );
}

/**
 * Gemeinsamer Master-Detail-Tab-Rumpf für Wand-/Deckenstile: Liste links
 * (Querschnitt-Vorschau + Name, ＋-Neu in der Fusszeile), Detail rechts über
 * {@link LayeredStyleDetail}. Parametrisiert über die Ressource + Orientierung.
 */
function LayeredStylesTab({
  project,
  types,
  orientation,
  hintKey,
  emptyKey,
  placeholderKey,
  deleteKeyPrefix,
  onPatch,
  onAdd,
  onDelete,
}: {
  project: Project;
  types: LayeredStyle[];
  orientation: "wall" | "ceiling";
  hintKey: string;
  emptyKey: string;
  placeholderKey: string;
  deleteKeyPrefix: string;
  onPatch: (id: string, patch: Partial<LayeredStyle>) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = types.find((s) => s.id === selectedId) ?? types[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t(hintKey)}</div>
      <div className="res-md">
        <div className="res-md-list">
          {types.map((s) => (
            <button
              key={s.id}
              className={`res-md-row${selected?.id === s.id ? " active" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <span className="res-md-row-thumb">
                <WallTypeSwatch
                  layers={swatchLayersOf(s, project)}
                  width={46}
                  height={28}
                  orientation={orientation}
                />
              </span>
              <span className="res-md-row-name">{s.name}</span>
            </button>
          ))}
          {types.length === 0 && (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAdd()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <LayeredStyleDetail
              key={selected.id}
              style={selected}
              project={project}
              orientation={orientation}
              onPatch={(patch) => onPatch(selected.id, patch)}
              onDelete={() => onDelete(selected.id)}
              deleteTitle={t(deleteKeyPrefix, { name: selected.name })}
              namePlaceholder={t(placeholderKey)}
            />
          ) : (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WallStylesTab({
  project,
  onPatchWallType,
  onAddWallType,
  onDeleteWallType,
}: {
  project: Project;
  onPatchWallType: (id: string, patch: Partial<WallType>) => void;
  onAddWallType: () => void;
  onDeleteWallType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.wallTypes}
      orientation="wall"
      hintKey="resources.wallStyles.hint"
      emptyKey="resources.wallStyles.empty"
      placeholderKey="resources.wallStyles.placeholder"
      deleteKeyPrefix="resources.delete.wallType"
      onPatch={onPatchWallType}
      onAdd={onAddWallType}
      onDelete={onDeleteWallType}
    />
  );
}

/**
 * Tab „Deckenstile" — das liegende Gegenstück zu {@link WallStylesTab}: nutzt
 * denselben {@link LayeredStylesTab}-Rumpf, nur die Ressource (`ceilingTypes`),
 * die Orientierung (gestapelt) und die Handler unterscheiden sich.
 */
function CeilingStylesTab({
  project,
  onPatchCeilingType,
  onAddCeilingType,
  onDeleteCeilingType,
}: {
  project: Project;
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
  onAddCeilingType: () => void;
  onDeleteCeilingType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.ceilingTypes ?? []}
      orientation="ceiling"
      hintKey="resources.ceilingStyles.hint"
      emptyKey="resources.ceilingStyles.empty"
      placeholderKey="resources.ceilingStyles.placeholder"
      deleteKeyPrefix="resources.delete.ceilingType"
      onPatch={onPatchCeilingType}
      onAdd={onAddCeilingType}
      onDelete={onDeleteCeilingType}
    />
  );
}

/**
 * Tab „Dachtypen" — das geneigte Gegenstück zu {@link CeilingStylesTab}: gleicher
 * {@link LayeredStylesTab}-Rumpf (Schichtaufbau aussen/Eindeckung → innen/
 * Verkleidung), Ressource `roofTypes`. Vorschau in Decken-Orientierung
 * (gestapelt) — für die Schichtreihenfolge/-dicken ausreichend.
 */
function RoofStylesTab({
  project,
  onPatchRoofType,
  onAddRoofType,
  onDeleteRoofType,
}: {
  project: Project;
  onPatchRoofType: (id: string, patch: Partial<RoofType>) => void;
  onAddRoofType: () => void;
  onDeleteRoofType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.roofTypes ?? []}
      orientation="ceiling"
      hintKey="resources.roofStyles.hint"
      emptyKey="resources.roofStyles.empty"
      placeholderKey="resources.roofStyles.placeholder"
      deleteKeyPrefix="resources.delete.roofType"
      onPatch={onPatchRoofType}
      onAdd={onAddRoofType}
      onDelete={onDeleteRoofType}
    />
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
    // Kanonische Volllinie 0.13 (früher "hatch-line", zusammengeführt auf "thin").
    lineStyleId: "thin",
  }));
}

// ── Bauteil-Typen (Tür/Fenster/Treppe) ─────────────────────────────────────
// Formular-basierte Bibliotheken (im Gegensatz zu Wand-/Deckenstilen, die
// schichtbasiert über LayeredStylesTab laufen): jeder Typ ist ein flaches
// Feld-Bündel (Bauart, Maße, …), daher genügt ein generischer Master-Detail-
// Rumpf ({@link TypeLibraryTab}), der die konkreten Felder je Typ als Render-
// Funktion einreicht — analog zum Bauteile-Tab (Liste links, Editor rechts).

const DOOR_KIND_OPTIONS: { value: DoorType["kind"]; labelKey: string }[] = [
  { value: "dreh", labelKey: "resources.doorKind.dreh" },
  { value: "schiebe", labelKey: "resources.doorKind.schiebe" },
  { value: "wandoeffnung", labelKey: "resources.doorKind.wandoeffnung" },
];

const DOOR_LEAF_STYLE_OPTIONS: { value: DoorType["leafStyle"]; labelKey: string }[] = [
  { value: "glatt", labelKey: "resources.leafStyle.glatt" },
  { value: "kassette", labelKey: "resources.leafStyle.kassette" },
  { value: "glas", labelKey: "resources.leafStyle.glas" },
];

const DOOR_FRAME_KIND_OPTIONS: { value: NonNullable<DoorType["frameKind"]>; labelKey: string }[] = [
  { value: "zarge", labelKey: "resources.frameKind.zarge" },
  { value: "blockrahmen", labelKey: "resources.frameKind.blockrahmen" },
];

// Bezugsfläche des Schichteinzugs — von aussen oder innen gemessen. Für Tür UND
// Fenster genutzt (gleiche Semantik).
const INSET_FACE_OPTIONS: { value: "aussen" | "innen"; labelKey: string }[] = [
  { value: "aussen", labelKey: "resources.insetFace.aussen" },
  { value: "innen", labelKey: "resources.insetFace.innen" },
];

const WINDOW_KIND_OPTIONS: { value: WindowType["kind"]; labelKey: string }[] = [
  { value: "dreh", labelKey: "resources.windowKind.dreh" },
  { value: "kipp", labelKey: "resources.windowKind.kipp" },
  { value: "drehkipp", labelKey: "resources.windowKind.drehkipp" },
  { value: "fest", labelKey: "resources.windowKind.fest" },
  { value: "schiebe", labelKey: "resources.windowKind.schiebe" },
];

const WINDOW_GLAZING_OPTIONS: { value: WindowType["glazing"]; labelKey: string }[] = [
  { value: "einfach", labelKey: "resources.glazing.einfach" },
  { value: "zweifach", labelKey: "resources.glazing.zweifach" },
  { value: "dreifach", labelKey: "resources.glazing.dreifach" },
];

const WINDOW_SILL_BOARD_OPTIONS: { value: NonNullable<WindowType["sillBoard"]>; labelKey: string }[] = [
  { value: "keine", labelKey: "resources.sillBoard.keine" },
  { value: "innen", labelKey: "resources.sillBoard.innen" },
  { value: "aussen", labelKey: "resources.sillBoard.aussen" },
  { value: "beide", labelKey: "resources.sillBoard.beide" },
];

const STAIR_STRUCTURE_OPTIONS: { value: StairType["structure"]; labelKey: string }[] = [
  { value: "massiv", labelKey: "resources.structure.massiv" },
  { value: "beton", labelKey: "resources.structure.beton" },
  { value: "wange", labelKey: "resources.structure.wange" },
  { value: "aufgesattelt", labelKey: "resources.structure.aufgesattelt" },
  { value: "spindel", labelKey: "resources.structure.spindel" },
];

const STAIR_RAILING_OPTIONS: { value: NonNullable<StairType["railing"]>; labelKey: string }[] = [
  { value: "keine", labelKey: "resources.railing.keine" },
  { value: "links", labelKey: "resources.railing.links" },
  { value: "rechts", labelKey: "resources.railing.rechts" },
  { value: "beide", labelKey: "resources.railing.beide" },
];

/**
 * Generischer Rumpf für formular-basierte Typ-Bibliotheken (Tür-/Fenster-/
 * Treppentypen): Liste links (Name je Zeile, „+ Neu" im Fuß), Editor rechts
 * (Umbenennen-Feld + Löschen-Knopf im Kopf, darunter die typspezifischen
 * Felder aus `renderFields`). Handler sind optional (nur gesetzt, wenn die
 * einbettende App sie bereitstellt) — Aufrufe laufen daher über `?.()`.
 */
function TypeLibraryTab<T extends { id: string; name: string }>({
  types,
  hintKey,
  emptyKey,
  placeholderKey,
  deleteKeyPrefix,
  onAdd,
  onPatch,
  onDelete,
  renderFields,
}: {
  types: T[];
  hintKey: string;
  emptyKey: string;
  placeholderKey: string;
  deleteKeyPrefix: string;
  onAdd?: () => void;
  onPatch?: (id: string, patch: Partial<T>) => void;
  onDelete?: (id: string) => void;
  renderFields: (item: T, onPatch: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = types.find((x) => x.id === selectedId) ?? types[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t(hintKey)}</div>
      <div className="res-md">
        <div className="res-md-list">
          {types.map((item) => (
            <button
              key={item.id}
              className={`res-md-row${selected?.id === item.id ? " active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="res-md-row-name">{item.name}</span>
            </button>
          ))}
          {types.length === 0 && (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAdd?.()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <div className="res-md-detail-inner" key={selected.id}>
              <div className="res-md-head">
                <input
                  className="res-input res-md-rename"
                  value={selected.name}
                  placeholder={t(placeholderKey)}
                  onChange={(e) =>
                    onPatch?.(selected.id, { name: e.target.value } as Partial<T>)
                  }
                />
                <DeleteButton
                  onClick={() => onDelete?.(selected.id)}
                  title={t(deleteKeyPrefix, { name: selected.name })}
                />
              </div>
              <div className="res-fields">
                {renderFields(selected, (patch) => onPatch?.(selected.id, patch))}
              </div>
            </div>
          ) : (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tab „Türtypen" — Bauart, Blattausführung/-zahl, Zarge und Standardmaße. */
function DoorStylesTab({
  project,
  onAddDoorType,
  onPatchDoorType,
  onDeleteDoorType,
}: {
  project: Project;
  onAddDoorType?: () => void;
  onPatchDoorType?: (id: string, patch: Partial<DoorType>) => void;
  onDeleteDoorType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.doorTypes ?? []}
      hintKey="resources.doorTypes.hint"
      emptyKey="resources.doorTypes.empty"
      placeholderKey="resources.doorTypes.placeholder"
      deleteKeyPrefix="resources.delete.doorType"
      onAdd={onAddDoorType}
      onPatch={onPatchDoorType}
      onDelete={onDeleteDoorType}
      renderFields={(door, patch) => (
        <>
          <FieldRow label={t("resources.field.doorKind")}>
            <SelectField
              value={door.kind}
              onChange={(kind) => patch({ kind })}
              options={DOOR_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.leafCount")}>
            <Segmented
              value={String(door.leafCount)}
              onChange={(v) => patch({ leafCount: (v === "2" ? 2 : 1) as 1 | 2 })}
              options={[
                { value: "1", label: t("resources.leafCount.1") },
                { value: "2", label: t("resources.leafCount.2") },
              ]}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.leafStyle")}>
            <SelectField
              value={door.leafStyle}
              onChange={(leafStyle) => patch({ leafStyle })}
              options={DOOR_LEAF_STYLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          {door.leafStyle === "glas" && (
            <FieldRow label={t("resources.field.glazingRatio")}>
              <NumberField
                value={door.glazingRatio ?? 0.6}
                onChange={(glazingRatio) => patch({ glazingRatio })}
                step={0.01}
                min={0}
                max={1}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.frameThickness")}>
            <NumberField
              value={door.frameThickness}
              onChange={(frameThickness) => patch({ frameThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameDepth")}>
            <NumberField
              value={door.frameDepth ?? 0}
              onChange={(frameDepth) => patch({ frameDepth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameKind")}>
            <SelectField
              value={door.frameKind ?? "zarge"}
              onChange={(frameKind) => patch({ frameKind })}
              options={DOOR_FRAME_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameWidth")}>
            <NumberField
              value={door.frameWidth ?? 0.06}
              onChange={(frameWidth) => patch({ frameWidth })}
              step={0.005}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.insetFromFace")}>
            <NumberField
              value={door.insetFromFace ?? 0}
              onChange={(insetFromFace) => patch({ insetFromFace })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          {(door.insetFromFace ?? 0) > 0 && (
            <FieldRow label={t("resources.field.insetFace")}>
              <SelectField
                value={door.insetFace ?? "aussen"}
                onChange={(insetFace) => patch({ insetFace })}
                options={INSET_FACE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.transomHeight")}>
            <NumberField
              value={door.transomHeight ?? 0}
              onChange={(transomHeight) => patch({ transomHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultWidth")}>
            <NumberField
              value={door.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultHeight")}>
            <NumberField
              value={door.defaultHeight}
              onChange={(defaultHeight) => patch({ defaultHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.threshold")}>
            <input
              type="checkbox"
              checked={!!door.threshold}
              onChange={(e) => patch({ threshold: e.target.checked })}
            />
          </FieldRow>
        </>
      )}
    />
  );
}

/** Tab „Fenstertypen" — Öffnungsart, Flügelzahl, Verglasung, Zarge, Brüstung. */
function WindowStylesTab({
  project,
  onAddWindowType,
  onPatchWindowType,
  onDeleteWindowType,
}: {
  project: Project;
  onAddWindowType?: () => void;
  onPatchWindowType?: (id: string, patch: Partial<WindowType>) => void;
  onDeleteWindowType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.windowTypes ?? []}
      hintKey="resources.windowTypes.hint"
      emptyKey="resources.windowTypes.empty"
      placeholderKey="resources.windowTypes.placeholder"
      deleteKeyPrefix="resources.delete.windowType"
      onAdd={onAddWindowType}
      onPatch={onPatchWindowType}
      onDelete={onDeleteWindowType}
      renderFields={(win, patch) => (
        <>
          <FieldRow label={t("resources.field.windowKind")}>
            <SelectField
              value={win.kind}
              onChange={(kind) => patch({ kind })}
              options={WINDOW_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.wingCount")}>
            <NumberField
              value={win.wingCount}
              onChange={(wingCount) => patch({ wingCount: Math.round(wingCount) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.mullionRows")}>
            <NumberField
              value={win.mullionRows ?? 1}
              onChange={(mullionRows) => patch({ mullionRows: Math.max(1, Math.round(mullionRows)) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.mullionCols")}>
            <NumberField
              value={win.mullionCols ?? 1}
              onChange={(mullionCols) => patch({ mullionCols: Math.max(1, Math.round(mullionCols)) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.glazing")}>
            <SelectField
              value={win.glazing}
              onChange={(glazing) => patch({ glazing })}
              options={WINDOW_GLAZING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameThickness")}>
            <NumberField
              value={win.frameThickness}
              onChange={(frameThickness) => patch({ frameThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameDepth")}>
            <NumberField
              value={win.frameDepth ?? 0}
              onChange={(frameDepth) => patch({ frameDepth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameWidth")}>
            <NumberField
              value={win.frameWidth ?? 0.06}
              onChange={(frameWidth) => patch({ frameWidth })}
              step={0.005}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.insetFromFace")}>
            <NumberField
              value={win.insetFromFace ?? 0}
              onChange={(insetFromFace) => patch({ insetFromFace })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          {(win.insetFromFace ?? 0) > 0 && (
            <FieldRow label={t("resources.field.insetFace")}>
              <SelectField
                value={win.insetFace ?? "aussen"}
                onChange={(insetFace) => patch({ insetFace })}
                options={INSET_FACE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.innerLayerRecess")}>
            <input
              type="checkbox"
              checked={!!win.innerLayerRecess}
              onChange={(e) => patch({ innerLayerRecess: e.target.checked })}
              title={t("resources.field.innerLayerRecess.hint")}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.transomHeight")}>
            <NumberField
              value={win.transomHeight ?? 0}
              onChange={(transomHeight) => patch({ transomHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultSillHeight")}>
            <NumberField
              value={win.defaultSillHeight}
              onChange={(defaultSillHeight) => patch({ defaultSillHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultWidth")}>
            <NumberField
              value={win.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultHeight")}>
            <NumberField
              value={win.defaultHeight}
              onChange={(defaultHeight) => patch({ defaultHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.sillBoard")}>
            <SelectField
              value={win.sillBoard ?? "keine"}
              onChange={(sillBoard) => patch({ sillBoard })}
              options={WINDOW_SILL_BOARD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
        </>
      )}
    />
  );
}

/** Tab „Treppentypen" — Tragart, Stufenausbildung, Geländer und Laufbreite. */
function StairStylesTab({
  project,
  onAddStairType,
  onPatchStairType,
  onDeleteStairType,
}: {
  project: Project;
  onAddStairType?: () => void;
  onPatchStairType?: (id: string, patch: Partial<StairType>) => void;
  onDeleteStairType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.stairTypes ?? []}
      hintKey="resources.stairTypes.hint"
      emptyKey="resources.stairTypes.empty"
      placeholderKey="resources.stairTypes.placeholder"
      deleteKeyPrefix="resources.delete.stairType"
      onAdd={onAddStairType}
      onPatch={onPatchStairType}
      onDelete={onDeleteStairType}
      renderFields={(stair, patch) => (
        <>
          <FieldRow label={t("resources.field.structure")}>
            <SelectField
              value={stair.structure}
              onChange={(structure) => patch({ structure })}
              options={STAIR_STRUCTURE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.closedRisers")}>
            <input
              type="checkbox"
              checked={!!stair.closedRisers}
              onChange={(e) => patch({ closedRisers: e.target.checked })}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.treadThickness")}>
            <NumberField
              value={stair.treadThickness}
              onChange={(treadThickness) => patch({ treadThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.nosing")}>
            <NumberField
              value={stair.nosing ?? 0}
              onChange={(nosing) => patch({ nosing })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.railing")}>
            <SelectField
              value={stair.railing ?? "keine"}
              onChange={(railing) => patch({ railing })}
              options={STAIR_RAILING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.stairWidth")}>
            <NumberField
              value={stair.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
        </>
      )}
    />
  );
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

// ── Grafische Overrides (Regel-Engine, A1) ─────────────────────────────────
// Master-Detail wie Linien/Wandstile: Liste links = Regeln in PRIORITÄTS-
// Reihenfolge (oben gewinnt pro Aktions-Feld) mit Aktiv-Checkbox, Auf/Ab und
// Löschen; Detail rechts = Bedingung (Kriterium/Operator/Wert) + optionale
// Aktionen (Farbe/Strichstärke/Linienstil). Reines Rendering-Overlay — die
// Auswertung liegt in src/overrides/engine.ts, der Einhängepunkt in
// plan/generatePlan.ts; Elementdaten bleiben unverändert.

/** Bedingungs-Typen (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_TYPE_OPTIONS: { value: OverrideConditionType; labelKey: string }[] = [
  { value: "layer_name", labelKey: "resources.overrides.condType.layer" },
  { value: "object_name", labelKey: "resources.overrides.condType.object" },
];

/** Vergleichs-Operatoren (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_OP_OPTIONS: { value: OverrideOperator; labelKey: string }[] = [
  { value: "equals", labelKey: "resources.overrides.op.equals" },
  { value: "contains", labelKey: "resources.overrides.op.contains" },
  { value: "starts_with", labelKey: "resources.overrides.op.startsWith" },
  { value: "not_equals", labelKey: "resources.overrides.op.notEquals" },
];

/** Kompakte Bedingungs-Zusammenfassung für die Listenzeile. */
function overrideConditionSummary(rule: OverrideRule): string {
  const type = OVERRIDE_TYPE_OPTIONS.find((o) => o.value === rule.condition.type);
  const op = OVERRIDE_OP_OPTIONS.find((o) => o.value === rule.condition.operator);
  return `${type ? t(type.labelKey) : rule.condition.type} ${
    op ? t(op.labelKey) : rule.condition.operator
  } „${rule.condition.value}"`;
}

/** Optionale Aktion: Checkbox (an/aus) + Steuerelement, solange sie an ist. */
function OptionalAction({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  active: boolean;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="res-field">
      <span className="res-field-label">
        <label className="res-ov-action-toggle">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => onToggle(e.target.checked)}
          />{" "}
          {label}
        </label>
      </span>
      <span className="res-field-control">
        {active ? children : <span className="res-joint-none">–</span>}
      </span>
    </div>
  );
}

/** Detail-Panel EINER Override-Regel (rechte Seite des Master-Detail-Layouts). */
function OverrideRuleDetail({
  rule,
  project,
  onPatch,
  onDelete,
}: {
  rule: OverrideRule;
  project: Project;
  onPatch: (patch: Partial<OverrideRule>) => void;
  onDelete: () => void;
}) {
  const patchCondition = (patch: Partial<OverrideRule["condition"]>) =>
    onPatch({ condition: { ...rule.condition, ...patch } });
  const patchActions = (patch: Partial<OverrideRule["actions"]>) =>
    onPatch({ actions: { ...rule.actions, ...patch } });
  // Sentinel „—": kein Linienstil-Override.
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.overrides.linetype.none") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={rule.name}
          placeholder={t("resources.overrides.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton onClick={onDelete} title={t("resources.overrides.delete")} />
      </div>

      <div className="res-hint">{t("resources.overrides.condition")}</div>
      <FieldRow label={t("resources.overrides.condType")}>
        <SelectField
          value={rule.condition.type}
          onChange={(type) => patchCondition({ type })}
          options={OVERRIDE_TYPE_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.operator")}>
        <SelectField
          value={rule.condition.operator}
          onChange={(operator) => patchCondition({ operator })}
          options={OVERRIDE_OP_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.value")}>
        <TextField
          value={rule.condition.value}
          placeholder={t("resources.overrides.value.placeholder")}
          onChange={(value) => patchCondition({ value })}
        />
      </FieldRow>

      <div className="res-hint">{t("resources.overrides.actions")}</div>
      {/* Vorschlagswerte für die Strichstärke (Standard-Stiftbreiten in mm). */}
      <datalist id="ov-pen-weights">
        {PEN_WEIGHTS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <OptionalAction
        label={t("resources.overrides.action.color")}
        active={rule.actions.color !== undefined}
        onToggle={(on) => patchActions({ color: on ? "#808080" : undefined })}
      >
        <ColorField
          color={rule.actions.color ?? "#808080"}
          onChange={(color) => patchActions({ color })}
        />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.lineweight")}
        active={rule.actions.lineweight !== undefined}
        onToggle={(on) => patchActions({ lineweight: on ? 0.35 : undefined })}
      >
        <NumberField
          value={rule.actions.lineweight ?? 0.35}
          onChange={(lineweight) => patchActions({ lineweight: Math.max(0, lineweight) })}
          step={0.05}
          min={0}
          list="ov-pen-weights"
        />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.linetype")}
        active={rule.actions.linetypeId !== undefined}
        onToggle={(on) =>
          patchActions({
            linetypeId: on ? project.lineStyles[0]?.id : undefined,
          })
        }
      >
        <SelectField
          value={rule.actions.linetypeId ?? NONE}
          onChange={(v) =>
            patchActions({ linetypeId: v === NONE ? undefined : v })
          }
          options={lineOptions}
        />
      </OptionalAction>
    </div>
  );
}

/** Tab „Overrides": Regelliste (Priorität von oben nach unten) + Detail. */
function OverridesTab({
  project,
  onSetOverrideRules,
}: {
  project: Project;
  onSetOverrideRules?: (rules: OverrideRule[]) => void;
}) {
  const rules = project.overrideRules ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rules.find((r) => r.id === selectedId) ?? rules[0];

  const setRules = (next: OverrideRule[]) => onSetOverrideRules?.(next);
  const patchRule = (id: string, patch: Partial<OverrideRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRule = () => {
    const rule: OverrideRule = {
      id: `ov-${Date.now()}`,
      name: t("resources.overrides.defaultName"),
      enabled: true,
      condition: { type: "layer_name", operator: "contains", value: "" },
      actions: {},
    };
    setRules([...rules, rule]);
    setSelectedId(rule.id);
  };
  const deleteRule = (id: string) => setRules(rules.filter((r) => r.id !== id));
  const moveRule = (id: string, dir: -1 | 1) => {
    const i = rules.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rules.length) return;
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRules(next);
  };

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.overrides.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {rules.map((r) => (
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              className={`res-md-row res-ov-row${
                selected?.id === r.id ? " active" : ""
              }`}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => setSelectedId(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelectedId(r.id);
              }}
            >
              <input
                type="checkbox"
                checked={r.enabled}
                title={t("resources.overrides.enabled")}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => patchRule(r.id, { enabled: e.target.checked })}
              />
              <span
                className="res-md-row-name"
                style={{ flex: 1, opacity: r.enabled ? 1 : 0.5 }}
              >
                {r.name || t("resources.overrides.placeholder")}
                <span
                  style={{ display: "block", fontSize: "0.85em", opacity: 0.65 }}
                >
                  {overrideConditionSummary(r)}
                </span>
              </span>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.overrides.moveUp")}
                disabled={rules[0]?.id === r.id}
                onClick={(e) => {
                  e.stopPropagation();
                  moveRule(r.id, -1);
                }}
              >
                ▲
              </button>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.overrides.moveDown")}
                disabled={rules[rules.length - 1]?.id === r.id}
                onClick={(e) => {
                  e.stopPropagation();
                  moveRule(r.id, 1);
                }}
              >
                ▼
              </button>
            </div>
          ))}
          {rules.length === 0 && (
            <div className="res-md-empty">{t("resources.overrides.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button
              className="res-add"
              onClick={addRule}
              disabled={!onSetOverrideRules}
            >
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <OverrideRuleDetail
              key={selected.id}
              rule={selected}
              project={project}
              onPatch={(patch) => patchRule(selected.id, patch)}
              onDelete={() => deleteRule(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.overrides.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Gemeinsame kleine Bausteine ────────────────────────────────────────────

function EmptyState({ text }: { text: string }) {
  return <div className="res-empty">{text}</div>;
}

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
   * Priorität). Optional, damit bestehende Einbettungen (z. B. ResourcesPanel)
   * ohne Änderung weiter kompilieren — ohne Handler ist der Tab nur lesend.
   */
  onSetOverrideRules?: (rules: OverrideRule[]) => void;
  /**
   * Bauteil-Typen (Tür/Fenster/Treppe) — Bibliotheks-CRUD, analog Wand-/
   * Deckentypen. Optional, damit bestehende Einbettungen (z. B. ResourcesPanel)
   * ohne Änderung weiter kompilieren; ohne Handler bleiben die Tabs verborgen.
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
