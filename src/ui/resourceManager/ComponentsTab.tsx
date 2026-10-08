// Tab „Bauteile" (Components) — Poché-/3D-Farbe, Verschneidungs-Rang, Schraffur,
// Material. Master-Detail-Layout wie die übrigen Ressourcen-Tabs: Liste links,
// Detail-Editor rechts (siehe {@link ComponentDetail}).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Component, ComponentMaterial, Project } from "../../model/types";
import { MATERIAL_LIBRARY } from "../../materials/library";
import type { MaterialAsset } from "../../materials/library";
import { materialFromAsset, DEFAULT_TILE_SIZE_M } from "../../materials/runtime";
import {
  searchMaterials,
  fetchMaterialMaps,
  revokeMaterialUrls,
  AMBIENT_CATEGORIES,
  type AmbientMaterial,
  type AmbientResolution,
} from "../../materials/ambientcg";
import { requestMaterialPreview, cancelMaterialPreview } from "../../materials/spherePreview";
import { Dropdown } from "../Dropdown";
import { HatchSwatch } from "../hatchPreview";
import { t } from "../../i18n";
import { activePenSet, resolvePenColor } from "../../model/penSets";
import { PenColorField } from "../PenColorField";
import {
  DeleteButton,
  FieldRow,
  ImagePickButton,
  TextField,
  NumberField,
  SelectField,
} from "./fields";

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
            // Vorheriges Material ersetzt: dessen Blob-URLs (Download/Upload)
            // sind ab jetzt unerreichbar — sonst leckt jeder Material-Wechsel.
            revokeMaterialUrls(material);
            onAssign(m);
          }}
          onClear={() => {
            revokeMaterialUrls(material);
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
  project,
  onPatch,
  onDelete,
  onSaveColor,
}: {
  component: Component;
  hatches: Project["hatches"];
  /** Für die Stift-Kopplung (`PenColorField`): `project.pens` + aktiver Stiftsatz. */
  project: Project;
  onPatch: (patch: Partial<Component>) => void;
  onDelete: () => void;
  /** Aktuelle Farbe in einer eigenen Palette ablegen (s. `FreeColorPicker`). */
  onSaveColor?: (paletteId: string, hex: string) => void;
}) {
  const pens = project.pens ?? [];
  const activeStyles = activePenSet(project)?.pens;
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
        <FieldRow label={t("resources.col.color")} hint={t("resources.col.color.hint")}>
          {/* Grundfarbe = 3D-Diffusfarbe + Fallback für Vorder-/Hintergrund. */}
          <PenColorField
            color={component.colorPenId ? resolvePenColor(project, component.colorPenId) : component.color}
            penId={component.colorPenId}
            pens={pens}
            activeStyles={activeStyles}
            customPalettes={project.customPalettes}
            builtinBanks={project.builtinPaletteBanks}
            onSaveColor={onSaveColor}
            onColorChange={(color) => onPatch({ color, colorPenId: undefined })}
            onPenChange={(colorPenId) =>
              onPatch(
                colorPenId
                  ? { colorPenId, color: resolvePenColor(project, colorPenId) }
                  : { colorPenId: undefined },
              )
            }
          />
        </FieldRow>
        <FieldRow
          label={t("resources.col.foreground")}
          hint={t("resources.col.foreground.hint")}
        >
          {/* Vordergrund = Farbe der Muster-/Schraffurlinien. Fehlt sie, greift
              als Anzeige-Fallback `color`; das Setzen definiert `foreground`. */}
          <PenColorField
            color={
              component.foregroundPenId
                ? resolvePenColor(project, component.foregroundPenId)
                : component.foreground ?? component.color
            }
            penId={component.foregroundPenId}
            pens={pens}
            activeStyles={activeStyles}
            customPalettes={project.customPalettes}
            builtinBanks={project.builtinPaletteBanks}
            onSaveColor={onSaveColor}
            onColorChange={(foreground) => onPatch({ foreground, foregroundPenId: undefined })}
            onPenChange={(foregroundPenId) =>
              onPatch(
                foregroundPenId
                  ? { foregroundPenId, foreground: resolvePenColor(project, foregroundPenId) }
                  : { foregroundPenId: undefined },
              )
            }
          />
        </FieldRow>
        <FieldRow
          label={t("resources.col.background")}
          hint={t("resources.col.background.hint")}
        >
          {/* Hintergrund = Füllung (Poché). Fehlt sie, gilt `color` als Fallback. */}
          <PenColorField
            color={
              component.backgroundPenId
                ? resolvePenColor(project, component.backgroundPenId)
                : component.background ?? component.color
            }
            penId={component.backgroundPenId}
            pens={pens}
            activeStyles={activeStyles}
            customPalettes={project.customPalettes}
            builtinBanks={project.builtinPaletteBanks}
            onSaveColor={onSaveColor}
            onColorChange={(background) => onPatch({ background, backgroundPenId: undefined })}
            onPenChange={(backgroundPenId) =>
              onPatch(
                backgroundPenId
                  ? { backgroundPenId, background: resolvePenColor(project, backgroundPenId) }
                  : { backgroundPenId: undefined },
              )
            }
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

export function ComponentsTab({
  project,
  onPatchComponent,
  onAddComponent,
  onDeleteComponent,
  onAddColorToCustomPalette,
}: {
  project: Project;
  onPatchComponent: (id: string, patch: Partial<Component>) => void;
  onAddComponent: () => void;
  onDeleteComponent: (id: string) => void;
  onAddColorToCustomPalette?: (paletteId: string | undefined, hex: string) => void;
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
              project={project}
              onSaveColor={onAddColorToCustomPalette}
              onPatch={(patch) => onPatchComponent(selected.id, patch)}
              onDelete={() => {
                revokeMaterialUrls(selected.material);
                onDeleteComponent(selected.id);
              }}
            />
          ) : (
            <div className="res-md-empty">{t("resources.components.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
