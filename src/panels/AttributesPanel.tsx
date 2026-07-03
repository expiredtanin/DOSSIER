// Inhalts-Panel „Attribute" — die Attribut-Palette (Vectorworks-Stil) für die
// aktuelle Auswahl. Zeigt die EFFEKTIV aufgelösten Stift-/Füll-Eigenschaften des
// ersten selektierten Elements und erlaubt das direkte Bearbeiten (Farbe,
// Strichstärke, Füllschraffur).
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

import { t } from "../i18n";
import { formatM } from "../model/types";
import { PEN_WEIGHTS } from "../model/types";
import { usePanelHost } from "./host";

export function AttributesPanel() {
  const host = usePanelHost();
  const sel = host.selection;
  const { project } = host;

  // Leerzustand: kompakter Hinweis, wenn nichts (Sinnvolles) selektiert ist.
  if (sel === null) {
    return (
      <div className="attr-panel">
        <div className="attr-empty">{t("attr.empty")}</div>
      </div>
    );
  }

  const isDrawing = sel.kind === "drawing2d";
  // Strichstärke wirkt laut Kontrakt nur auf Drawing2D; Wände erben sie aus der
  // Ebene und sind daher hier nicht editierbar.
  const weightEditable = isDrawing;
  // Füllschraffur nur bei geschlossener 2D-Form sinnvoll.
  const fillEditable = isDrawing && sel.closed === true;
  // Vordergrund/Hintergrund (Muster-/Füllfarbe) tragen Wand, Decke und
  // geschlossene 2D-Formen als Override; `undefined` = „Nach System".
  const pocheEditable =
    sel.kind === "wall" ||
    sel.kind === "ceiling" ||
    (isDrawing && sel.closed === true);

  // Ein Override-Farbfeld mit „Nach System"-Zustand: ist der Wert `undefined`,
  // zeigt es „Nach System" (leerer Swatch) statt einer Farbe und erbt; ein
  // Klick auf × stellt zurück auf „Nach System" (schreibt `null` → Feld weg).
  const overrideColor = (
    value: string | undefined,
    onSet: (color: string | null) => void,
  ) => (
    <span className="attr-val">
      <label className="attr-color">
        <span
          className="attr-color-swatch"
          style={{ background: pocheEditable && value ? value : "transparent" }}
        />
        <input
          type="color"
          value={value ?? "#808080"}
          disabled={!pocheEditable}
          title={pocheEditable ? undefined : t("attr.fillNeedsClosed")}
          onChange={(e) => onSet(e.target.value)}
        />
        <span className="attr-color-hex">
          {pocheEditable && value ? value : t("attr.bySystem")}
        </span>
        {pocheEditable && value !== undefined && (
          <button
            type="button"
            className="attr-color-clear"
            title={t("attr.bySystem")}
            onClick={() => onSet(null)}
          >
            ×
          </button>
        )}
      </label>
    </span>
  );

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
      <div className="attr-title">{t("attr.title")}</div>

      {/* ── Stift/Strich ──────────────────────────────────────────────── */}
      <div className="attr-section-label">{t("attr.stroke")}</div>
      <div className="attr-grid">
        {/* Farbe — gilt für Wand UND Drawing2D (Kontrakt setzt beide). */}
        <span className="attr-key">{t("attr.color")}</span>
        <span className="attr-val">
          <label className="attr-color">
            <span
              className="attr-color-swatch"
              style={{ background: sel.color }}
            />
            <input
              type="color"
              value={sel.color}
              onChange={(e) => host.onSetSelectionColor(e.target.value)}
            />
            <span className="attr-color-hex">{sel.color}</span>
          </label>
        </span>

        {/* Strichstärke (mm) — nur Drawing2D editierbar; Wände erben aus Ebene. */}
        <span className="attr-key">{t("attr.weight")}</span>
        <span className="attr-val">
          <input
            className="attr-num"
            type="number"
            step={0.01}
            min={0}
            list="attr-pen-weights"
            value={sel.weightMm}
            disabled={!weightEditable}
            title={weightEditable ? undefined : t("attr.inheritedFromLayer")}
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
        </span>

        {/* Linienstil — read-only/informativ (kein Setter im Kontrakt). */}
        <span className="attr-key">{t("attr.lineStyle")}</span>
        <span className="attr-val attr-readonly">
          {lineStyle ? lineStyle.name : "—"}
        </span>
      </div>

      {/* ── Füllung (Vordergrund/Hintergrund + Schraffur) ─────────────── */}
      {/* Vordergrund = Muster-/Schraffurfarbe, Hintergrund = Füllfarbe/Poché.
          Beide sind Overrides mit Default „Nach System" (erben vom Bauteil);
          `background` ist der Nachfolger des alten reinen `fillColor`-Feldes. */}
      <div className="attr-section-label">{t("attr.fill")}</div>
      <div className="attr-grid">
        <span className="attr-key">{t("attr.foreground")}</span>
        {overrideColor(sel.foreground, host.onSetSelectionForeground)}

        <span className="attr-key">{t("attr.background")}</span>
        {overrideColor(sel.background, host.onSetSelectionBackground)}

        <span className="attr-key">{t("attr.hatch")}</span>
        <span className="attr-val">
          <select
            className="attr-select"
            value={fillEditable ? sel.fillHatchId ?? "" : ""}
            disabled={!fillEditable}
            title={fillEditable ? undefined : t("attr.fillNeedsClosed")}
            onChange={(e) =>
              host.onSetSelectionFill(e.target.value || null)
            }
          >
            <option value="">{t("attr.none")}</option>
            {project.hatches.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </span>
      </div>

      {/* ── Maße (informativ, aus der bbox) ───────────────────────────── */}
      <div className="attr-section-label">{t("attr.size")}</div>
      <div className="attr-grid">
        <span className="attr-key">{t("attr.width")}</span>
        <span className="attr-val attr-readonly">{formatM(bboxW)}</span>
        <span className="attr-key">{t("attr.height")}</span>
        <span className="attr-val attr-readonly">{formatM(bboxH)}</span>
      </div>
    </div>
  );
}
