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
// das Modell gar nicht trägt (Caps, Schlagschatten), werden bewusst
// weggelassen, um die Palette ehrlich und schlank zu halten.
//
// DOSSIER-Tabellen-Look: KEINE wiederholten Feld-Labels pro Zeile — ein kompaktes
// Label→Wert-Grid. Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).
// Alle sichtbaren Texte über t(...).

import { Fragment } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n";
import { formatM, wallTypeLabel } from "../model/types";
import { fmtLength, unitsForLevel } from "../tools/displayUnits";
import { PEN_WEIGHTS } from "../model/types";
import type { AttributeSource } from "../model/types";
import { usePanelHost } from "./host";
import { Dropdown } from "../ui/Dropdown";
import { PenColorField } from "../ui/PenColorField";
import { activePenSet, resolvePenWeight } from "../model/penSets";
import { DIM_DEFAULTS_MM, END_MARK_DEFAULT_SIZE_MM } from "../model/dimension";
import type { EndMark } from "../model/types";

/** Auswahl der Linienenden (Reihenfolge = Anzeige im Dropdown). */
const END_MARK_OPTIONS: EndMark[] = ["none", "arrow", "arrowOpen", "dot", "tick", "square"];
// Element-spezifische Attribut-Abschnitte (Wand/Decke/Öffnung/Treppe/Raum) —
// aus ObjectInfoPanel hierher verschoben (Ribbon Phase 3: ObjectInfo trägt nur
// noch Bezugspunkt + Masse).
import {
  WallSection,
  CeilingSection,
  RoofSection,
  OpeningSection,
  StairSection,
  RoomSection,
  ExtrudedSolidSection,
  ColumnSection,
  SectionLineSection,
  DetailRefSection,
  DimRefsSection,
} from "./ObjectInfoPanel";
import { SurfacePatternPlacement } from "./SurfacePatternPlacement";

/** UI-Zustand des 3-Optionen-Quellen-Dropdowns (nicht 1:1 das Modell-Feld:
 *  „custom" ist abgeleitet aus „ist ein expliziter Wert gesetzt?", nicht
 *  selbst gespeichert). */
type UiSource = "layer" | "object" | "custom";

/**
 * Leitet den UI-Quellen-Zustand ab: ein gesetzter Wert gewinnt immer („eigener
 * Wert"), sonst das rohe Source-Feld — dessen DEFAULT unterscheidet sich nach
 * Elementart (s. AttributeSource in model/types.ts): Wand/Decke „Nach Bauteil"
 * (neutrale SIA-Poché), Drawing2D „Nach Ebene" (kein eigenes Bauteil, „Nach
 * Bauteil" wird dort im Dropdown gar nicht erst angeboten).
 */
function uiSourceOf(
  hasValue: boolean,
  raw: AttributeSource | undefined,
  isDrawing: boolean,
): UiSource {
  return hasValue ? "custom" : raw ?? (isDrawing ? "layer" : "object");
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
            options={project.wallTypes.map((wt) => ({
              value: wt.id,
              label: wallTypeLabel(wt, project.components),
              title: wt.name,
            }))}
          />
        </span>
      </div>
    </>
  ) : null;

  // Leerzustand: der Typ-Picker (falls ein Bauteil-Werkzeug aktiv ist), sonst ein
  // kompakter Hinweis.
  if (sel === null) {
    // Schnitt-/Ansichtslinie ist kein Projekt-Bauteil (kein `selection`) — sie
    // kommt über host.sectionLine und wird hier im „Leerzustand" bearbeitet.
    return (
      <div className="attr-panel">
        {typeSection}
        {host.sectionLine && <SectionLineSection level={host.sectionLine} host={host} />}
        {!typeSection && !host.sectionLine && (
          <div className="attr-empty">{t("attr.empty")}</div>
        )}
      </div>
    );
  }

  const isDrawing = sel.kind === "drawing2d";
  const sheetUnits = unitsForLevel(host.project.drawingLevels.find((z) => z.id === sel.floorId));
  const sizeText = (m: number): string => (sheetUnits.perMeter === 1 ? formatM(m) : `${fmtLength(sheetUnits, m).replace(/mm$/, "")} mm`);
  // Strichstärke: Wand/Decke/Stütze/Drawing2D tragen einen eigenen Override
  // (`strokeWeight`/`weightMm`) + Quellen-Dropdown; andere Elementarten erben
  // stets aus der Kategorie (kein Setter im Kontrakt → nicht editierbar).
  const weightEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    sel.kind === "column" ||
    isDrawing;
  // Schraffur: Wand/Decke/Stütze (Schnitt-/Ansichts-Schraffur) oder
  // geschlossene 2D-Form.
  const fillEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    sel.kind === "column" ||
    (isDrawing && sel.closed === true);
  // Vordergrund/Hintergrund (Muster-/Füllfarbe) tragen Wand, Decke, Stütze und
  // geschlossene 2D-Formen als Override; `undefined` = „Nach System".
  const pocheEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    sel.kind === "column" ||
    (isDrawing && sel.closed === true);

  // Ein Drawing2D hat KEIN eigenes Bauteil (Component) — „Nach Bauteil" wäre
  // dort bedeutungslos (resolveForeground & Co. fallen dann auf gar keinen
  // Wert zurück, s. selectionInfo.ts `noComponent`). Wand/Decke/Stütze haben
  // alle ein echtes Bauteil (Schicht-Component bzw. `Column.componentId`) und
  // bieten die Option daher an.
  const allowObjectSource = !isDrawing;

  // Der Quellen-Dropdown (Nach Ebene/Nach Bauteil/eigener Wert), gemeinsam für
  // alle vier Felder. Deaktiviert, wenn das Feld für diese Elementart gar
  // nicht gilt (z. B. Strichstärke bei einer Treppe); „Nach Bauteil" fehlt bei
  // Drawing2D (s. o.).
  const sourceSelect = (
    editable: boolean,
    ui: UiSource,
    onChange: (next: UiSource) => void,
    allowObject: boolean,
  ) => (
    <Dropdown
      value={ui}
      disabled={!editable}
      onChange={(v) => onChange(v as UiSource)}
      options={[
        { value: "layer", label: t("attr.source.layer") },
        ...(allowObject ? [{ value: "object", label: t("attr.source.object") }] : []),
        { value: "custom", label: t("attr.source.custom") },
      ]}
    />
  );

  // Eine Attribut-Zeile: Label + IMMER sichtbares Eingabe-Element (zeigt den
  // effektiven Wert) + Quellen-Dropdown.
  const sourceRow = (
    labelKey: string,
    editable: boolean,
    ui: UiSource,
    onSource: (next: UiSource) => void,
    valueEditor: ReactNode,
    allowObject: boolean = allowObjectSource,
  ) => (
    <>
      <span className="attr-key">{t(labelKey)}</span>
      <span className="attr-val">
        {valueEditor}
        {sourceSelect(editable, ui, onSource, allowObject)}
      </span>
    </>
  );

  // Vordergrund/Hintergrund: „eigener Wert" ⇒ auf den elementart-abhängigen
  // Default zurückfallen (Wand/Decke „Nach Bauteil", Drawing2D „Nach Ebene",
  // s. uiSourceOf); „Nach Ebene"/„Nach Bauteil" schreiben die Quelle direkt
  // (der Host löscht dabei den expliziten Wert).
  const fgUi = uiSourceOf(sel.foreground !== undefined, sel.foregroundSource, isDrawing);
  const bgUi = uiSourceOf(sel.background !== undefined, sel.backgroundSource, isDrawing);
  const weightUi = uiSourceOf(
    sel.strokeWeightOverride !== undefined,
    sel.strokeWeightSource,
    isDrawing,
  );
  const hatchUi = uiSourceOf(
    sel.fillHatchId !== undefined && sel.fillHatchId !== null,
    sel.hatchSource,
    isDrawing,
  );

  // Wechsel auf „eigener Wert" per Dropdown (nicht durchs Editieren des Felds
  // selbst, s. colorValue-Kommentar oben) sät den Override mit dem gerade
  // ANGEZEIGTEN effektiven Wert — sonst würde die Farbe beim Umschalten
  // unerwartet springen (z. B. auf sel.color statt der tatsächlich sichtbaren
  // Ebenen-/Bauteilfarbe).
  const onForegroundSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionForeground(sel.effectiveForeground ?? sel.color);
    else host.onSetSelectionForegroundSource(next);
  };
  const onBackgroundSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionBackground(sel.effectiveBackground ?? sel.color);
    else host.onSetSelectionBackgroundSource(next);
  };
  const onWeightSourceChange = (next: UiSource) => {
    if (next === "custom") host.onSetSelectionWeight(sel.weightMm);
    else host.onSetSelectionStrokeWeightSource(next);
  };
  // Die Ressource „Ohne" (Muster none) zeigt wie „Keine Schraffur" nichts an.
  const hatchPatternIsNone =
    project.hatches.find((h) => h.id === sel.effectiveHatchId)?.pattern === "none";
  const onHatchSourceChange = (next: UiSource) => {
    if (next === "custom") {
      host.onSetSelectionFill(sel.effectiveHatchId ?? project.hatches[0]?.id ?? null);
    } else {
      host.onSetSelectionHatchSource(next);
    }
  };

  // Effektiver Linienstil rein informativ (kein Setter im Kontrakt → kein Fake).
  // Wir leiten ihn aus dem Modell-Element ab, wenn explizit gesetzt; sonst „—".
  // Offene Formen tragen Linienenden; geschlossene (Rechteck/Kreis/Ellipse/
  // Ring) und die Bemassung (eigene SIA-Massstriche) bewusst nicht.
  const openEndsShape = (() => {
    const g = isDrawing ? project.drawings2d.find((x) => x.id === sel.id)?.geom : undefined;
    if (!g) return false;
    if (g.shape === "line" || g.shape === "arc" || g.shape === "bezier") return true;
    if (g.shape === "polyline" || g.shape === "spline") return !g.closed;
    if (g.shape === "text") return !!g.leaderTarget;
    return false;
  })();
  const drawing = isDrawing
    ? project.drawings2d.find((d) => d.id === sel.id)
    : undefined;
  const lineStyle = drawing?.lineStyleId
    ? project.lineStyles.find((l) => l.id === drawing.lineStyleId)
    : undefined;

  const bboxW = sel.bbox.maxX - sel.bbox.minX;
  const bboxH = sel.bbox.maxY - sel.bbox.minY;
  const isModelElement = !!(sel.wall || sel.ceiling || sel.roof || sel.stair || sel.room);

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

        {/* Farbe — gilt für Wand, Decke, Öffnung, Treppe, Raum UND Drawing2D
            (Kontrakt setzt sie alle). Ein Stift trägt Farbe UND Strichstärke
            zusammen (s. model/penSets.ts) — daher `showWeight`, wenn diese
            Elementart überhaupt ein eigenes Strichstärke-Feld hat
            (`weightEditable`, nicht bei reinen Annotationen ohne Bauteil-
            Bezug relevant, aber harmlos, falls doch angeklickt). */}
        <span className="attr-key">{t("attr.color")}</span>
        <span className="attr-val">
          <PenColorField
            color={sel.color}
            penId={sel.colorPenId}
            pens={project.pens ?? []}
            customPalettes={project.customPalettes}
            builtinBanks={project.builtinPaletteBanks}
            onSaveColor={host.onAddColorToCustomPalette}
            activeStyles={activePenSet(project)?.pens}
            showWeight={weightEditable}
            onColorChange={host.onSetSelectionColor}
            onPenChange={host.onSetSelectionColorPen}
          />
        </span>

        {/* Strichstärke (mm): Wand/Decke/Drawing2D mit Nach-Ebene/Nach-Bauteil/
            eigener-Wert-Quelle; eine Layout-Annotation kennt diese Vererbung
            nicht (kein Bauteil/keine Ebene) — dort ein schlichtes Zahlenfeld
            ohne Quellen-Dropdown, wenn die Art überhaupt eine Strichstärke
            trägt (Linie/Rechteck, nicht Text/Bild). Ist die Farbe oben an
            einen Stift gekoppelt (`sel.colorPenId`), ist dieses Feld
            GESPERRT und zeigt die Strichstärke DES STIFTS (ein Stift trägt
            beides zusammen, s. model/penSets.ts) statt des sonst aufgelösten
            `weightMm`. */}
        {sourceRow(
            "attr.weight",
            weightEditable && !sel.colorPenId,
            weightUi,
            onWeightSourceChange,
            <>
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={0.01}
                min={0}
                disabled={!weightEditable || !!sel.colorPenId}
                list="attr-pen-weights"
                value={sel.colorPenId ? resolvePenWeight(project, sel.colorPenId) : sel.weightMm}
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

        {/* Deckkraft (0..1) — bei BILDERN deren eigene Bild-Deckkraft, bei
            allen übrigen 2D-Formen die Objekt-Transparenz (wirkt auf Strich
            UND Füllung, s. `Drawing2D.opacity`). Schlichtes Zahlenfeld
            wie die Strichstärke bei Annotationen: kein Bauteil/keine Ebene,
            also keine Quellen-Vererbung. */}
        {(sel.isImage || isDrawing) && (
          <>
            <span className="attr-key">{t("attr.opacity")}</span>
            <span className="attr-val">
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={sel.opacity ?? 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) host.onSetSelectionOpacity(Math.max(0, Math.min(1, v)));
                }}
              />
            </span>
          </>
        )}

        {/* Bildkorrektur (Sättigung/Helligkeit/Kontrast/Graustufen) — NUR
            Kontext-Objekt-Luftbilder (`ContextImage.filters`); Drawing2D-/
            Layout-Bilder haben (noch) keine Korrektur. Neutral-Defaults
            (1/1/1/0), damit ein fehlendes `filters`-Objekt als "kein Effekt"
            angezeigt wird statt als 0/0/0/0. */}
        {sel.kind === "contextObject" && sel.isImage && (
          <>
            {(
              [
                ["saturation", "attr.saturation", 1, 0, 2] as const,
                ["brightness", "attr.brightness", 1, 0, 2] as const,
                ["contrast", "attr.contrast", 1, 0, 2] as const,
                ["grayscale", "attr.grayscale", 0, 0, 1] as const,
              ]
            ).map(([key, labelKey, neutral, min, max]) => (
              <Fragment key={key}>
                <span className="attr-key">{t(labelKey)}</span>
                <span className="attr-val">
                  <input
                    className="attr-num"
                    style={{ width: 72 }}
                    type="number"
                    step={0.05}
                    min={min}
                    max={max}
                    value={sel.imageFilters?.[key] ?? neutral}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v))
                        host.onSetSelectionImageFilters({ [key]: Math.max(min, Math.min(max, v)) });
                    }}
                  />
                </span>
              </Fragment>
            ))}
          </>
        )}

        {/* Linienstil — nur Drawing2D trägt ihn (Wand/Decke/Annotation etc.
            read-only), Rest wie gehabt. */}
        {(
          <>
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
          </>
        )}

        {/* Strichmuster-Massstab (LTSCALE je Objekt): streckt Striche und
            Lücken des Linienstils, ohne den Stil selbst zu ändern. */}
        {isDrawing && (
          <>
            <span className="attr-key">{t("attr.dashScale")}</span>
            <span className="attr-val">
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={0.25}
                min={0.01}
                value={drawing?.dashScale ?? 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) host.onSetDashScale(drawing!.id, v);
                }}
              />
            </span>
          </>
        )}


        {/* ── Linienenden (Pfeilspitzen) ────────────────────────────────
            Nur bei OFFENEN 2D-Formen und beim Text mit Hinweislinie —
            geschlossene Formen haben keine Enden. Grösse in Papier-mm
            (massstabsunabhängig, wie die Bemassungswerte). */}
        {openEndsShape && (
          <>
            <div className="attr-section-label">{t("attr.ends.section")}</div>
            {(
              [
                ["start", "attr.ends.start"],
                ["end", "attr.ends.end"],
              ] as const
            ).map(([key, labelKey]) => (
              <Fragment key={key}>
                <span className="attr-key">{t(labelKey)}</span>
                <span className="attr-val">
                  <Dropdown
                    value={drawing?.endMarks?.[key] ?? "none"}
                    onChange={(v) =>
                      host.onSetEndMarks(drawing!.id, { [key]: v as EndMark })
                    }
                    options={END_MARK_OPTIONS.map((o) => ({
                      value: o,
                      label: t(`attr.ends.${o}`),
                    }))}
                  />
                </span>
              </Fragment>
            ))}
            <span className="attr-key">{t("attr.ends.size")}</span>
            <span className="attr-val">
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={0.5}
                min={0}
                value={drawing?.endMarks?.sizeMm ?? END_MARK_DEFAULT_SIZE_MM}
                onChange={(e) => {
                  const mm = Number(e.target.value);
                  if (Number.isFinite(mm)) host.onSetEndMarks(drawing!.id, { sizeMm: mm });
                }}
              />
            </span>
          </>
        )}

        {/* ── Bemassung: Darstellungs-Feinheiten (SIA 400 B.5.3) ────────
            Nur bei einer selektierten Masskette. Alle Werte in Zentimetern
            (Modellmass, s. `model/dimension.ts`); leer/0 fällt auf den
            Standard zurück. Die Masszahl selbst wird direkt im Plan am
            eigenen Griff verschoben (rastet nahe der Standardlage ein). */}
        {drawing?.geom.shape === "grid" && (() => {
          const geom = drawing.geom as Extract<typeof drawing.geom, { shape: "grid" }>;
          const here = geom.levels?.includes(drawing.levelId) && geom.levels.length === 1;
          return (
            <>
              <div className="attr-section-label">{t("attr.grid.section")}</div>
              <span className="attr-key">{t("attr.grid.bubbles")}</span>
              <span className="attr-val">
                <select value={geom.bubbles ?? "both"} onChange={(e) => host.onSetGridProps(drawing.id, { bubbles: e.target.value as "start" | "end" | "both" })}>
                  <option value="both">{t("attr.grid.bubbles.both")}</option>
                  <option value="start">{t("attr.grid.bubbles.start")}</option>
                  <option value="end">{t("attr.grid.bubbles.end")}</option>
                </select>
              </span>
              <span className="attr-key">{t("attr.grid.extend")}</span>
              <span className="attr-val">
                <input className="attr-num" style={{ width: 72 }} type="number" step={0.1} min={0} value={geom.extend ?? 1.5}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) host.onSetGridProps(drawing.id, { extend: v }); }} />
              </span>
              <span className="attr-key">{t("attr.grid.bubbleMm")}</span>
              <span className="attr-val">
                <input className="attr-num" style={{ width: 72 }} type="number" step={0.5} min={2} value={geom.bubbleMm ?? 8}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 2) host.onSetGridProps(drawing.id, { bubbleMm: v }); }} />
              </span>
              <span className="attr-key">{t("attr.grid.show3d")}</span>
              <span className="attr-val">
                <input type="checkbox" checked={geom.show3d === true} onChange={(e) => host.onSetGridProps(drawing.id, { show3d: e.target.checked })} />
              </span>
              <span className="attr-key">{t("attr.grid.levels")}</span>
              <span className="attr-val">
                <select value={here ? "here" : "all"} onChange={(e) => host.onSetGridProps(drawing.id, { levels: e.target.value === "here" ? [drawing.levelId] : undefined })}>
                  <option value="all">{t("attr.grid.levels.all")}</option>
                  <option value="here">{t("attr.grid.levels.here")}</option>
                </select>
              </span>
            </>
          );
        })()}

        {drawing?.geom.shape === "dimension" && (
          <>
            <div className="attr-section-label">{t("attr.dim.section")}</div>
            {/* Abstände/Grössen in PAPIER-mm (massstabsunabhängig, wie die
                Strichstärken darunter) — beim Erzeugen des Plans wird mit
                dessen Massstab in Modellmass umgerechnet. */}
            {(
              [
                ["gapMm", "attr.dim.gap", DIM_DEFAULTS_MM.gap],
                ["overshootMm", "attr.dim.overshoot", DIM_DEFAULTS_MM.overshoot],
                ["tickLenMm", "attr.dim.tick", DIM_DEFAULTS_MM.tickLen],
                ["textHeightMm", "attr.dim.textHeight", DIM_DEFAULTS_MM.textHeight],
              ] as const
            ).map(([key, labelKey, fallback]) => {
              const geom = drawing.geom as Extract<typeof drawing.geom, { shape: "dimension" }>;
              return (
                <Fragment key={key}>
                  <span className="attr-key">{t(labelKey)}</span>
                  <span className="attr-val">
                    <input
                      className="attr-num"
                      style={{ width: 72 }}
                      type="number"
                      step={0.5}
                      min={0}
                      value={geom[key] ?? fallback}
                      onChange={(e) => {
                        const mm = Number(e.target.value);
                        if (Number.isFinite(mm)) host.onSetDimensionStyle(drawing.id, { [key]: mm });
                      }}
                    />
                  </span>
                </Fragment>
              );
            })}
          </>
        )}

        {/* Strichstärken der drei Bestandteile — anders als die Abstände
            oben sind das echte PAPIER-mm (wie jede Strichstärke hier),
            also massstabsunabhängig. Leer gelassen (0) = Standard: Mass-
            und Hilfslinie erben die Elementstärke, der Massstrich wird
            doppelt so dick gezeichnet. */}
        {drawing?.geom.shape === "dimension" &&
          (
            [
              ["lineWeightMm", "attr.dim.lineWeight"],
              ["extWeightMm", "attr.dim.extWeight"],
              ["tickWeightMm", "attr.dim.tickWeight"],
            ] as const
          ).map(([key, labelKey]) => {
            const geom = drawing.geom as Extract<typeof drawing.geom, { shape: "dimension" }>;
            const fallback = key === "tickWeightMm" ? sel.weightMm * 2 : sel.weightMm;
            return (
              <Fragment key={key}>
                <span className="attr-key">{t(labelKey)}</span>
                <span className="attr-val">
                  <input
                    className="attr-num"
                    style={{ width: 72 }}
                    type="number"
                    step={0.01}
                    min={0}
                    list="attr-pen-weights"
                    value={geom[key] ?? Number(fallback.toFixed(2))}
                    onChange={(e) => {
                      const mm = Number(e.target.value);
                      if (Number.isFinite(mm))
                        host.onSetDimensionStyle(drawing.id, { [key]: mm });
                    }}
                  />
                </span>
              </Fragment>
            );
          })}

        {/* ── Füllung (Vordergrund/Hintergrund + Schraffur) ─────────── */}
        {/* Vordergrund = Muster-/Schraffurfarbe, Hintergrund = Füllfarbe/
            Poché. Jedes Feld: Nach Ebene (LayerCategory erzwingt den Wert) /
            Nach Bauteil (erbt vom Component-Manager, Default) / eigener Wert.
            Eine Layout-Annotation kennt keine Füllung (nur Umriss) — Sektion
            entfällt komplett statt drei bedeutungslose Dropdowns zu zeigen. */}
        {(
          <>
            <div className="attr-section-label">{t("attr.fill")}</div>

            {/* Füllart: Keine / Vollfläche / Schraffur — die drei klaren Zustände einer
                Fläche, statt sie nur indirekt über Hintergrundfarbe + Schraffur-Liste
                zu erraten. Erkennung wie der Renderer (`plan/drawings.rs`: background →
                Ebenenfarbe bei Quelle „Ebene" → fillColor). */}
            {isDrawing && sel.closed === true && (() => {
              const hatchActive = !!sel.effectiveHatchId && !hatchPatternIsNone;
              const hasFill = !!(sel.background || sel.fillColor || sel.backgroundSource === "layer");
              const mode = hatchActive ? "hatch" : hasFill ? "solid" : "none";
              return (
                <>
                  <span className="attr-key">{t("attr.fillMode")}</span>
                  <span className="attr-val">
                    <Dropdown
                      value={mode}
                      disabled={!fillEditable}
                      onChange={(v) => host.onSetSelectionFillMode(v as "none" | "solid" | "hatch")}
                      options={[
                        { value: "none", label: t("attr.fillMode.none") },
                        { value: "solid", label: t("attr.fillMode.solid") },
                        { value: "hatch", label: t("attr.fillMode.hatch") },
                      ]}
                    />
                  </span>
                </>
              );
            })()}

            {/* Swatch — IMMER sichtbar (zeigt den effektiven Wert, welche
                Ebene/Bauteil/Override auch immer gerade liefert), aber nur bei
                „eigener Wert" editierbar (`disabled`). Trägt wie die Strich-
                farbe oben eine eigene Stift-Kopplung (`foregroundPenId`/
                `backgroundPenId`) — Frei/Stift + Popover-Palette identisch zur
                Stift-Zeile, nur pro Element statt pro Bauteil gekoppelt. */}
            {sourceRow(
              "attr.foreground",
              pocheEditable,
              fgUi,
              onForegroundSourceChange,
              <PenColorField
                color={sel.effectiveForeground ?? "#808080"}
                penId={sel.foregroundPenId}
                pens={project.pens ?? []}
                customPalettes={project.customPalettes}
                builtinBanks={project.builtinPaletteBanks}
                onSaveColor={host.onAddColorToCustomPalette}
                activeStyles={activePenSet(project)?.pens}
                disabled={!pocheEditable}
                onColorChange={host.onSetSelectionForeground}
                onPenChange={host.onSetSelectionForegroundPen}
              />,
            )}

            {sourceRow(
              "attr.background",
              pocheEditable,
              bgUi,
              onBackgroundSourceChange,
              <PenColorField
                color={sel.effectiveBackground ?? "#808080"}
                penId={sel.backgroundPenId}
                pens={project.pens ?? []}
                customPalettes={project.customPalettes}
                builtinBanks={project.builtinPaletteBanks}
                onSaveColor={host.onAddColorToCustomPalette}
                activeStyles={activePenSet(project)?.pens}
                disabled={!pocheEditable}
                onColorChange={host.onSetSelectionBackground}
                onPenChange={host.onSetSelectionBackgroundPen}
              />,
            )}

            {sourceRow(
              "attr.hatch",
              fillEditable,
              hatchUi,
              onHatchSourceChange,
              <Dropdown
                value={hatchPatternIsNone ? "" : sel.effectiveHatchId ?? ""}
                disabled={!fillEditable}
                onChange={(v) => host.onSetSelectionFill(v || null)}
                options={[
                  { value: "", label: t("attr.hatch.none") },
                  // Die Ressource „Ohne" (Muster none) wäre dasselbe wie „Keine Schraffur".
                  ...project.hatches
                    .filter((h) => h.pattern !== "none")
                    .map((h) => ({ value: h.id, label: h.name })),
                ]}
              />,
            )}

            {/* Transparenz NUR der Füllung/Schraffurfläche (Umriss bleibt deckend);
                in Prozent: 0 % = deckend, 100 % = unsichtbar. */}
            {isDrawing && (
              <>
                <span className="attr-key">{t("attr.fillTransparency")}</span>
                <span className="attr-val">
                  <input
                    className="attr-num"
                    style={{ width: 72 }}
                    type="number"
                    step={5}
                    min={0}
                    max={100}
                    value={Math.round((1 - (drawing?.fillOpacity ?? 1)) * 100)}
                    onChange={(e) => {
                      const pct = Number(e.target.value);
                      if (Number.isFinite(pct)) host.onSetSelectionFillOpacity(1 - Math.max(0, Math.min(100, pct)) / 100);
                    }}
                  />
                  <span className="attr-unit"> %</span>
                </span>
              </>
            )}

        {/* Schraffur-Platzierung an DIESEM Objekt (direkt unter der Schraffur-Auswahl): Winkel ersetzt den der
            Ressource, Massstab multipliziert sie, der Anker verschiebt das
            Musterraster (leer = Modellursprung, damit benachbarte Flächen
            dieselbe Phase teilen). Nur sinnvoll, wenn das Element überhaupt
            eine Schraffur zeigt. */}
        {isDrawing && sel.effectiveHatchId && !hatchPatternIsNone && (
          <>
            <span className="attr-key">{t("attr.hatch.angle")}</span>
            <span className="attr-val">
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={5}
                value={drawing?.hatchAngleDeg ?? ""}
                placeholder={t("attr.hatch.fromStyle")}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v === null || Number.isFinite(v))
                    host.onSetHatchPlacement(drawing!.id, { angleDeg: v });
                }}
              />
            </span>
            <span className="attr-key">{t("attr.hatch.scale")}</span>
            <span className="attr-val">
              <input
                className="attr-num"
                style={{ width: 72 }}
                type="number"
                step={0.1}
                min={0.01}
                value={drawing?.hatchScale ?? ""}
                placeholder={t("attr.hatch.fromStyle")}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v === null || (Number.isFinite(v) && v > 0))
                    host.onSetHatchPlacement(drawing!.id, { scale: v });
                }}
              />
            </span>
            <span className="attr-key">{t("attr.hatch.origin")}</span>
            <span className="attr-val">
              <button
                className="attr-btn"
                title={t("attr.hatch.origin.hint")}
                onClick={() =>
                  host.onSetHatchPlacement(drawing!.id, {
                    // Ankerpunkt = untere linke Ecke der Objekt-Bbox: das ist
                    // die Ecke, an der man ein Plattenraster üblicherweise
                    // ansetzen lässt. Erneuter Klick setzt zurück.
                    origin: drawing?.hatchOrigin
                      ? null
                      : { x: sel.bbox.minX, y: sel.bbox.minY },
                  })
                }
              >
                {drawing?.hatchOrigin ? t("attr.hatch.origin.reset") : t("attr.hatch.origin.corner")}
              </button>
            </span>
          </>
        )}
          </>
        )}

        {/* ── Masse (informativ, aus der bbox) — auf einem Layout-Blatt in Papier-mm ([93]). */}
        {/* Bauteile: die bbox ist der GRUNDRISS-Umriss (X/Y), keine Höhe — als
            „Ausdehnung X/Y" beschriften (Nutzer-Report: Fenster zeigte „Höhe
            0.34 m" = Wanddicke). Öffnungen tragen Breite/Höhe im eigenen
            Abschnitt, dort entfällt die bbox ganz. */}
        {!sel.opening && (
          <>
            <div className="attr-section-label">{t("attr.size")}</div>
            <span className="attr-key">{t(isModelElement ? "attr.extentX" : "attr.width")}</span>
            <span className="attr-val attr-readonly">{sizeText(bboxW)}</span>
            <span className="attr-key">{t(isModelElement ? "attr.extentY" : "attr.height")}</span>
            <span className="attr-val attr-readonly">{sizeText(bboxH)}</span>
          </>
        )}
      </div>

      {/* Element-spezifische Abschnitte (aus ObjectInfo hierher verschoben) —
          nur der jeweils passende erscheint. Nutzen weiter die `objinfo-*`-
          Darstellung + die Host-Handler. */}
      {sel.wall && <WallSection wall={sel.wall} host={host} />}
      {sel.ceiling && <CeilingSection ceiling={sel.ceiling} host={host} />}
      {sel.roof && <RoofSection roof={sel.roof} host={host} />}
      {(sel.wall || sel.roof) && <SurfacePatternPlacement kind={sel.wall ? "wall" : "roof"} id={sel.id} host={host} />}
      {sel.opening && <OpeningSection opening={sel.opening} host={host} />}
      {sel.stair && <StairSection stair={sel.stair} host={host} />}
      {sel.room && <RoomSection room={sel.room} roomId={sel.id} host={host} />}
      {sel.extrudedSolid && <ExtrudedSolidSection solid={sel.extrudedSolid} host={host} />}
      {sel.column && <ColumnSection column={sel.column} host={host} />}
      {sel.detailRef && <DetailRefSection detailRef={sel.detailRef} drawingId={sel.id} host={host} />}
      {sel.dimRefs && <DimRefsSection refs={sel.dimRefs} drawingId={sel.id} host={host} />}
    </div>
  );
}
