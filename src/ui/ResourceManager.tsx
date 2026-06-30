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

import { useRef, useState } from "react";
import type {
  Component,
  HatchPattern,
  HatchStyle,
  LineStyle,
  Project,
} from "../model/types";
import { PEN_WEIGHTS } from "../model/types";
import { parseLin } from "../io/linParser";
import { parsePat } from "../io/patParser";
import { EyeIcon } from "./EyeIcon";
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

// Spalten: Name | Farbe | Schraffur | Prio | Textur | (löschen).
const COMPONENT_COLUMNS: ResColumn[] = [
  { titleKey: "resources.col.name" },
  { titleKey: "resources.col.color" },
  { titleKey: "resources.col.hatch" },
  {
    titleKey: "resources.col.prio",
    align: "right",
    hintKey: "resources.col.prio.hint",
  },
  { titleKey: "resources.col.texture" },
  { titleKey: "" },
];
const COMPONENT_TEMPLATE =
  "minmax(120px, 1fr) auto minmax(120px, 0.8fr) 64px minmax(100px, 0.8fr) 36px";

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
        <ColorField
          color={component.color}
          onChange={(color) => onPatch({ color })}
        />
      </ResCell>
      <ResCell>
        <SelectField
          value={component.hatchId}
          onChange={(hatchId) => onPatch({ hatchId })}
          options={hatchOptions}
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

// Spalten: Name | Muster | Maßstab | Winkel | Farbe | Linienstil | (löschen).
const HATCH_COLUMNS: ResColumn[] = [
  { titleKey: "resources.col.name" },
  { titleKey: "resources.col.pattern" },
  { titleKey: "resources.col.scale", align: "right" },
  { titleKey: "resources.col.angle", align: "right" },
  { titleKey: "resources.col.color" },
  { titleKey: "resources.col.lineStyle" },
  { titleKey: "" },
];
const HATCH_TEMPLATE =
  "minmax(110px, 1fr) minmax(120px, 0.9fr) 64px 60px auto minmax(120px, 0.9fr) 36px";

function HatchRow({
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
  // Sentinel-Eintrag „— ohne —", da lineStyleId optional ist.
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.lineStyle.none") },
    ...lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  return (
    <ResRow>
      <ResCell>
        <TextField
          value={hatch.name}
          onChange={(name) => onPatch({ name })}
          placeholder={t("resources.hatches.placeholder")}
        />
      </ResCell>
      <ResCell>
        <SelectField
          value={hatch.pattern}
          onChange={(pattern) => onPatch({ pattern })}
          options={PATTERN_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          }))}
        />
      </ResCell>
      <ResCell align="right">
        <NumberField
          value={hatch.scale}
          onChange={(scale) => onPatch({ scale })}
          step={0.1}
          min={0.01}
        />
      </ResCell>
      <ResCell align="right">
        <NumberField
          value={hatch.angle}
          onChange={(angle) => onPatch({ angle })}
          step={5}
        />
      </ResCell>
      <ResCell>
        <ColorField color={hatch.color} onChange={(color) => onPatch({ color })} />
      </ResCell>
      <ResCell>
        <SelectField
          value={hatch.lineStyleId ?? NONE}
          onChange={(v) => onPatch({ lineStyleId: v === NONE ? undefined : v })}
          options={lineOptions}
        />
      </ResCell>
      <ResCell>
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.hatch", { name: hatch.name })}
        />
      </ResCell>
    </ResRow>
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
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.hatches.hint")}</div>
      <ResTable columns={HATCH_COLUMNS} template={HATCH_TEMPLATE}>
        {project.hatches.map((h) => (
          <HatchRow
            key={h.id}
            hatch={h}
            lineStyles={project.lineStyles}
            onPatch={(patch) => onPatchHatch(h.id, patch)}
            onDelete={() => onDeleteHatch(h.id)}
          />
        ))}
        {project.hatches.length === 0 && (
          <EmptyState text={t("resources.hatches.empty")} />
        )}
      </ResTable>
      <div className="res-add-row">
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
  );
}

// ── Linien (Line Styles) ───────────────────────────────────────────────────

/** Kleine Vorschau eines Linienstils (Stärke + Strichmuster) als SVG. */
function LinePreview({ style }: { style: LineStyle }) {
  // Stärke (mm) optisch skaliert auf 1–6 px für die Vorschau.
  const px = Math.max(1, Math.min(6, style.weight * 6));
  const dasharray = style.dash ? style.dash.map((d) => d * 4).join(" ") : undefined;
  return (
    <svg className="res-line-preview" viewBox="0 0 120 12" preserveAspectRatio="none">
      <line
        x1={4}
        y1={6}
        x2={116}
        y2={6}
        stroke={style.color}
        strokeWidth={px}
        strokeDasharray={dasharray}
        strokeLinecap="butt"
      />
    </svg>
  );
}

// Spalten: Name | Stärke (mm) | Farbe | Strich | Vorschau | (löschen).
const LINE_COLUMNS: ResColumn[] = [
  { titleKey: "resources.col.name" },
  { titleKey: "resources.col.weight", align: "right" },
  { titleKey: "resources.col.color" },
  { titleKey: "resources.col.stroke" },
  { titleKey: "resources.col.preview" },
  { titleKey: "" },
];
const LINE_TEMPLATE =
  "minmax(110px, 1fr) 80px auto minmax(120px, 0.9fr) minmax(90px, 1fr) 36px";

function LineStyleRow({
  style,
  onPatch,
  onDelete,
}: {
  style: LineStyle;
  onPatch: (patch: Partial<LineStyle>) => void;
  onDelete: () => void;
}) {
  return (
    <ResRow>
      <ResCell>
        <TextField
          value={style.name}
          onChange={(name) => onPatch({ name })}
          placeholder={t("resources.lines.placeholder")}
        />
      </ResCell>
      <ResCell align="right">
        <NumberField
          value={style.weight}
          onChange={(weight) => onPatch({ weight })}
          step={0.05}
          min={0.01}
          max={2}
          list="pen-weights"
        />
      </ResCell>
      <ResCell>
        <ColorField color={style.color} onChange={(color) => onPatch({ color })} />
      </ResCell>
      <ResCell>
        <SelectField
          value={dashKey(style.dash)}
          onChange={(key) => {
            const opt = DASH_OPTIONS.find((o) => o.key === key);
            if (opt) onPatch({ dash: opt.dash });
          }}
          options={DASH_OPTIONS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
        />
      </ResCell>
      <ResCell>
        <LinePreview style={style} />
      </ResCell>
      <ResCell>
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.lineStyle", { name: style.name })}
        />
      </ResCell>
    </ResRow>
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
  return (
    <div className="res-tab">
      {/* Vorschlagswerte für die Strichstärke (Standard-Stiftbreiten in mm). */}
      <datalist id="pen-weights">
        {PEN_WEIGHTS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <div className="res-hint">{t("resources.lines.hint")}</div>
      <ResTable columns={LINE_COLUMNS} template={LINE_TEMPLATE}>
        {project.lineStyles.map((l) => (
          <LineStyleRow
            key={l.id}
            style={l}
            onPatch={(patch) => onPatchLineStyle(l.id, patch)}
            onDelete={() => onDeleteLineStyle(l.id)}
          />
        ))}
        {project.lineStyles.length === 0 && (
          <EmptyState text={t("resources.lines.empty")} />
        )}
      </ResTable>
      <div className="res-add-row">
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

type TabId = "components" | "hatches" | "lines";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "components", labelKey: "resources.tab.components" },
  { id: "hatches", labelKey: "resources.tab.hatches" },
  { id: "lines", labelKey: "resources.tab.lines" },
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
        </div>
      </aside>
    </div>
  );
}
