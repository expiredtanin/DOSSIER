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
import { PEN_WEIGHTS } from "../model/types";
import type { AttributeSource } from "../model/types";
import { usePanelHost } from "./host";
import { Dropdown } from "../ui/Dropdown";
import { PenColorField } from "../ui/PenColorField";
import { activePenSet, resolvePenWeight } from "../model/penSets";
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
} from "./ObjectInfoPanel";

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
  // Layout-Annotation (Linie/Rechteck/Text/Bild auf einem Blatt) — kein
  // Projekt-Bauteil, daher ohne Ebene/Bauteil-Vererbung: Farbe/Strichstärke
  // sind IMMER ein eigener Wert (kein 3-Quellen-Dropdown, keine Füllung/
  // Schraffur/Masse — s. Ausblendungen weiter unten).
  const isAnnotation = sel.kind === "layoutAnnotation";
  // Strichstärke: Wand/Decke/Stütze/Drawing2D tragen einen eigenen Override
  // (`strokeWeight`/`weightMm`) + Quellen-Dropdown; andere Elementarten erben
  // stets aus der Kategorie (kein Setter im Kontrakt → nicht editierbar). Bei
  // Annotationen nur Linie/Rechteck (Text/Bild kennen keine Strichstärke).
  const weightEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    sel.kind === "column" ||
    isDrawing ||
    (isAnnotation && (sel.annotKind === "line" || sel.annotKind === "rect"));
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
  const onHatchSourceChange = (next: UiSource) => {
    if (next === "custom") {
      host.onSetSelectionFill(sel.effectiveHatchId ?? project.hatches[0]?.id ?? null);
    } else {
      host.onSetSelectionHatchSource(next);
    }
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
        {isAnnotation ? (
          weightEditable && (
            <>
              <span className="attr-key">{t("attr.weight")}</span>
              <span className="attr-val">
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
              </span>
            </>
          )
        ) : (
          sourceRow(
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
          )
        )}

        {/* Deckkraft (0..1) — nur Bild-Elemente (Drawing2D `{shape:"image"}`
            im Plan, Layout-Annotation `kind:"image"`). Schlichtes Zahlenfeld
            wie die Strichstärke bei Annotationen: kein Bauteil/keine Ebene,
            also keine Quellen-Vererbung. */}
        {sel.isImage && (
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
        {!isAnnotation && (
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

        {/* ── Füllung (Vordergrund/Hintergrund + Schraffur) ─────────── */}
        {/* Vordergrund = Muster-/Schraffurfarbe, Hintergrund = Füllfarbe/
            Poché. Jedes Feld: Nach Ebene (LayerCategory erzwingt den Wert) /
            Nach Bauteil (erbt vom Component-Manager, Default) / eigener Wert.
            Eine Layout-Annotation kennt keine Füllung (nur Umriss) — Sektion
            entfällt komplett statt drei bedeutungslose Dropdowns zu zeigen. */}
        {!isAnnotation && (
          <>
            <div className="attr-section-label">{t("attr.fill")}</div>

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
                value={sel.effectiveHatchId ?? ""}
                disabled={!fillEditable}
                onChange={(v) => host.onSetSelectionFill(v || null)}
                options={[
                  { value: "", label: t("attr.none") },
                  ...project.hatches.map((h) => ({ value: h.id, label: h.name })),
                ]}
              />,
            )}
          </>
        )}

        {/* ── Masse (informativ, aus der bbox) — bei einer Layout-Annotation
            in Papier-mm statt Modell-Metern geführt (`formatM` passt nicht),
            daher hier weggelassen; Grösse steht bereits im Blatt-HUD. */}
        {!isAnnotation && (
          <>
            <div className="attr-section-label">{t("attr.size")}</div>
            <span className="attr-key">{t("attr.width")}</span>
            <span className="attr-val attr-readonly">{formatM(bboxW)}</span>
            <span className="attr-key">{t("attr.height")}</span>
            <span className="attr-val attr-readonly">{formatM(bboxH)}</span>
          </>
        )}
      </div>

      {/* Element-spezifische Abschnitte (aus ObjectInfo hierher verschoben) —
          nur der jeweils passende erscheint. Nutzen weiter die `objinfo-*`-
          Darstellung + die Host-Handler. */}
      {sel.wall && <WallSection wall={sel.wall} host={host} />}
      {sel.ceiling && <CeilingSection ceiling={sel.ceiling} host={host} />}
      {sel.roof && <RoofSection roof={sel.roof} host={host} />}
      {sel.opening && <OpeningSection opening={sel.opening} host={host} />}
      {sel.stair && <StairSection stair={sel.stair} host={host} />}
      {sel.room && <RoomSection room={sel.room} roomId={sel.id} host={host} />}
      {sel.extrudedSolid && <ExtrudedSolidSection solid={sel.extrudedSolid} host={host} />}
      {sel.column && <ColumnSection column={sel.column} host={host} />}
    </div>
  );
}
