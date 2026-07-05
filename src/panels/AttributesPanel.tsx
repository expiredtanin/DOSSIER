// Inhalts-Panel „Attribute" — die Attribut-Palette (Vectorworks-Stil) für die
// aktuelle Auswahl. Zeigt die EFFEKTIV aufgelösten Stift-/Füll-Eigenschaften des
// ersten selektierten Elements und erlaubt das direkte Bearbeiten (Farbe,
// Strichstärke, Füllschraffur).
//
// Vordergrund/Hintergrund/Strichstärke/Schraffur tragen je einen 3-Optionen-
// Quellen-Dropdown: „Nach Ebene" (die LayerCategory erzwingt den Wert), „Nach
// Bauteil" (erbt vom Component-Manager, heutiges Default-Verhalten) oder
// „eigener Wert" (expliziter Override, gewinnt immer). Das Eingabe-Element
// (Farb-Swatch/mm-Zahlenfeld/Schraffur-Dropdown) erscheint NUR bei „eigener
// Wert"; ein Wechsel auf „Nach Ebene"/„Nach Bauteil" löscht den Wert wieder
// (siehe host.ts: onSetSelection{Foreground,Background,StrokeWeight,Hatch}Source).
//
// Daten/Handler kommen ausschließlich über usePanelHost (kein Prop-Drilling).
// Es werden NUR Eigenschaften angeboten, die der Host-Kontrakt tatsächlich
// setzen kann — keine Stubs/Fake-Setter (Konvention wire-dont-stub). Felder ohne
// echten Setter (Linienstil) werden read-only/informativ gezeigt; Felder, die
// das Modell gar nicht trägt (Deckkraft, Caps, Schlagschatten), werden bewusst
// weggelassen, um die Palette ehrlich und schlank zu halten.
//
// DOSSIER-Tabellen-Look: KEINE wiederholten Feld-Labels pro Zeile — ein kompaktes
// Label→Wert-Grid. Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).
// Alle sichtbaren Texte über t(...).

import type { ReactNode } from "react";
import { t } from "../i18n";
import { formatM } from "../model/types";
import { PEN_WEIGHTS } from "../model/types";
import type { AttributeSource } from "../model/types";
import { usePanelHost } from "./host";
import { Dropdown } from "../ui/Dropdown";
import { ColorHexField } from "../ui/ColorHexField";

/** UI-Zustand des 3-Optionen-Quellen-Dropdowns (nicht 1:1 das Modell-Feld:
 *  „custom" ist abgeleitet aus „ist ein expliziter Wert gesetzt?", nicht
 *  selbst gespeichert). */
type UiSource = "layer" | "object" | "custom";

/** Leitet den UI-Quellen-Zustand ab: ein gesetzter Wert gewinnt immer („eigener
 *  Wert"), sonst das rohe Source-Feld (`undefined` ⇒ „Nach Bauteil", Default). */
function uiSourceOf(hasValue: boolean, raw: AttributeSource | undefined): UiSource {
  return hasValue ? "custom" : raw ?? "object";
}

export function AttributesPanel() {
  const host = usePanelHost();
  const sel = host.selection;
  const { project } = host;

  // Wandtyp-/Deckentyp-Wahl für das NEUE Bauteil (was gezeichnet wird) — früher
  // in der Werkzeug-Sidebar (ToolsPanel), seit deren Entfernung hier. Erscheint
  // nur bei aktivem Wand-/Decken-Werkzeug (unabhängig von einer Auswahl); Wand und
  // Decke teilen sich denselben Aufbau-Typ (WallType) + Host-State.
  const drawingComponent =
    host.activeTool === "wall" || host.activeTool === "ceiling";
  const typeSection = drawingComponent ? (
    <>
      <div className="attr-section-label">{t("attr.newComponent")}</div>
      <div className="attr-grid">
        <span className="attr-key">
          {t(host.activeTool === "wall" ? "tool.wallType" : "tool.ceilingType")}
        </span>
        <span className="attr-val">
          <Dropdown
            value={host.activeWallTypeId}
            disabled={!host.toolsEnabled}
            onChange={(v) => host.onActiveWallTypeId(v)}
            options={project.wallTypes.map((wt) => ({ value: wt.id, label: wt.name }))}
          />
        </span>
      </div>
    </>
  ) : null;

  // Leerzustand: der Typ-Picker (falls ein Bauteil-Werkzeug aktiv ist), sonst ein
  // kompakter Hinweis.
  if (sel === null) {
    return (
      <div className="attr-panel">
        {typeSection}
        {!typeSection && <div className="attr-empty">{t("attr.empty")}</div>}
      </div>
    );
  }

  const isDrawing = sel.kind === "drawing2d";
  // Strichstärke: Wand/Decke/Drawing2D tragen einen eigenen Override
  // (`strokeWeight`/`weightMm`) + Quellen-Dropdown; andere Elementarten erben
  // stets aus der Kategorie (kein Setter im Kontrakt → nicht editierbar).
  const weightEditable = sel.kind === "wall" || sel.kind === "ceiling" || isDrawing;
  // Schraffur: Wand/Decke (Schnitt-/Ansichts-Schraffur) oder geschlossene 2D-Form.
  const fillEditable =
    sel.kind === "wall" || sel.kind === "ceiling" || (isDrawing && sel.closed === true);
  // Vordergrund/Hintergrund (Muster-/Füllfarbe) tragen Wand, Decke und
  // geschlossene 2D-Formen als Override; `undefined` = „Nach System".
  const pocheEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    (isDrawing && sel.closed === true);

  // Der 3-Optionen-Quellen-Dropdown, gemeinsam für alle vier Felder. Deaktiviert,
  // wenn das Feld für diese Elementart gar nicht gilt (z. B. Strichstärke bei
  // einer Treppe).
  const sourceSelect = (
    editable: boolean,
    ui: UiSource,
    onChange: (next: UiSource) => void,
  ) => (
    <Dropdown
      value={ui}
      disabled={!editable}
      onChange={(v) => onChange(v as UiSource)}
      options={[
        { value: "layer", label: t("attr.source.layer") },
        { value: "object", label: t("attr.source.object") },
        { value: "custom", label: t("attr.source.custom") },
      ]}
    />
  );

  // Farb-Swatch-Eingabe für „eigener Wert" (Vordergrund/Hintergrund). Erscheint
  // nur, wenn die Quelle „custom" ist — sonst zeigt allein der Dropdown den
  // Zustand.
  const colorValue = (value: string | undefined, onSet: (color: string) => void) => (
    <ColorHexField value={value ?? "#808080"} onChange={onSet} />
  );

  // Eine Attribut-Zeile: Label + Quellen-Dropdown + (nur bei „eigener Wert")
  // das passende Eingabe-Element.
  const sourceRow = (
    labelKey: string,
    editable: boolean,
    ui: UiSource,
    onSource: (next: UiSource) => void,
    valueEditor: ReactNode,
  ) => (
    <>
      <span className="attr-key">{t(labelKey)}</span>
      <span className="attr-val">
        {ui === "custom" && valueEditor}
        {sourceSelect(editable, ui, onSource)}
      </span>
    </>
  );

  // Vordergrund/Hintergrund: „eigener Wert" ⇒ auf Quelle "object" (Nach
  // Bauteil, Default) zurückfallen; „Nach Ebene"/„Nach Bauteil" schreiben die
  // Quelle direkt (der Host löscht dabei den expliziten Wert).
  const fgUi = uiSourceOf(sel.foreground !== undefined, sel.foregroundSource);
  const bgUi = uiSourceOf(sel.background !== undefined, sel.backgroundSource);
  const weightUi = uiSourceOf(sel.strokeWeightOverride !== undefined, sel.strokeWeightSource);
  const hatchUi = uiSourceOf(
    sel.fillHatchId !== undefined && sel.fillHatchId !== null,
    sel.hatchSource,
  );

  const onForegroundSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionForeground(sel.foreground ?? sel.color);
    else host.onSetSelectionForegroundSource(next);
  };
  const onBackgroundSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionBackground(sel.background ?? sel.color);
    else host.onSetSelectionBackgroundSource(next);
  };
  const onWeightSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionWeight(sel.weightMm);
    else host.onSetSelectionStrokeWeightSource(next);
  };
  const onHatchSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionFill(project.hatches[0]?.id ?? null);
    else host.onSetSelectionHatchSource(next);
  };

  // Effektiver Linienstil rein informativ (kein Setter im Kontrakt → kein Fake).
  // Wir leiten ihn aus dem Modell-Element ab, wenn explizit gesetzt; sonst „—".
  const drawing = isDrawing
    ? project.drawings2d.find((d) => d.id === sel.id)
    : undefined;
  const lineStyle = drawing?.lineStyleId
    ? project.lineStyles.find((l) => l.id === drawing.lineStyleId)
    : undefined;

  const bboxW = sel.bbox.maxX - sel.bbox.minX;
  const bboxH = sel.bbox.maxY - sel.bbox.minY;

  return (
    <div className="attr-panel">
      {/* Typ-Picker für das neue Bauteil (nur bei aktivem Wand-/Decken-Werkzeug). */}
      {typeSection}
      {/* EIN durchgehendes Grid über alle Sektionen — dieselben zwei Spalten
          (Label | Wert) für Stift/Füllung/Maße, damit die Wertfelder überall
          bündig in EINER Spalte stehen. Sektion-Balken spannen beide Spalten. */}
      <div className="attr-grid">
        {/* ── Stift/Strich ──────────────────────────────────────────── */}
        <div className="attr-section-label">{t("attr.stroke")}</div>

        {/* Farbe — gilt für Wand UND Drawing2D (Kontrakt setzt beide). */}
        <span className="attr-key">{t("attr.color")}</span>
        <span className="attr-val">
          <ColorHexField value={sel.color} onChange={host.onSetSelectionColor} />
        </span>

        {/* Strichstärke (mm) — Wand/Decke/Drawing2D, mit Nach-Ebene/Nach-Bauteil/
            eigener-Wert-Quelle; andere Elementarten erben stets aus der Kategorie. */}
        {sourceRow(
          "attr.weight",
          weightEditable,
          weightUi,
          onWeightSourceChange,
          <>
            <input
              className="attr-num"
              style={{ width: 72 }}
              type="number"
              step={0.01}
              min={0}
              list="attr-pen-weights"
              value={sel.weightMm}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) host.onSetSelectionWeight(v);
              }}
            />
            <datalist id="attr-pen-weights">
              {PEN_WEIGHTS.map((w) => (
                <option key={w} value={w} />
              ))}
            </datalist>
          </>,
        )}

        {/* Linienstil — nur Drawing2D trägt ihn (Wand/Decke/etc. read-only). */}
        <span className="attr-key">{t("attr.lineStyle")}</span>
        <span className="attr-val">
          {isDrawing ? (
            <Dropdown
              value={drawing?.lineStyleId ?? "__none__"}
              onChange={(v) =>
                host.onSetSelectionLineStyle(v === "__none__" ? undefined : v)
              }
              options={[
                { value: "__none__", label: t("attr.lineStyle.none") },
                ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          ) : (
            <span className="attr-readonly">{lineStyle ? lineStyle.name : "—"}</span>
          )}
        </span>

        {/* ── Füllung (Vordergrund/Hintergrund + Schraffur) ─────────── */}
        {/* Vordergrund = Muster-/Schraffurfarbe, Hintergrund = Füllfarbe/
            Poché. Jedes Feld: Nach Ebene (LayerCategory erzwingt den Wert) /
            Nach Bauteil (erbt vom Component-Manager, Default) / eigener Wert. */}
        <div className="attr-section-label">{t("attr.fill")}</div>

        {sourceRow(
          "attr.foreground",
          pocheEditable,
          fgUi,
          onForegroundSourceChange,
          colorValue(sel.foreground, host.onSetSelectionForeground),
        )}

        {sourceRow(
          "attr.background",
          pocheEditable,
          bgUi,
          onBackgroundSourceChange,
          colorValue(sel.background, host.onSetSelectionBackground),
        )}

        {sourceRow(
          "attr.hatch",
          fillEditable,
          hatchUi,
          onHatchSourceChange,
          <Dropdown
            value={sel.fillHatchId ?? ""}
            onChange={(v) => host.onSetSelectionFill(v || null)}
            options={[
              { value: "", label: t("attr.none") },
              ...project.hatches.map((h) => ({ value: h.id, label: h.name })),
            ]}
          />,
        )}

        {/* ── Maße (informativ, aus der bbox) ───────────────────────── */}
        <div className="attr-section-label">{t("attr.size")}</div>
        <span className="attr-key">{t("attr.width")}</span>
        <span className="attr-val attr-readonly">{formatM(bboxW)}</span>
        <span className="attr-key">{t("attr.height")}</span>
        <span className="attr-val attr-readonly">{formatM(bboxH)}</span>
      </div>
    </div>
  );
}
