// Tab „Linien" (Line Styles) — Strichstärke/Farbe/Strichmuster, wahlweise
// Strich-Presets, Zickzack oder ein frei gezeichnetes Custom-Motiv. Master-
// Detail-Layout wie die übrigen Ressourcen-Tabs (siehe {@link LineStyleDetail}).

import { useState } from "react";
import type { LineStyle, Project } from "../../model/types";
import { PEN_WEIGHTS } from "../../model/types";
import { parseLin } from "../../io/linParser";
import { LineSwatch } from "../hatchPreview";
import {
  segmentsToDash,
  dashToSegments,
  presetOfDash,
  LINE_PRESETS,
  type LineSegment,
  type LineSegmentType,
  type LinePresetKey,
} from "../lineSegments";
import { MotifEditor } from "../MotifEditor";
import { t } from "../../i18n";
import {
  ColorField,
  DeleteButton,
  FieldRow,
  FileImportButton,
  NumberField,
  Segmented,
  SelectField,
} from "./fields";

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

/** .lin-Text → id-lose Linienstile (schwarze Haarlinie 0.18 als Default). */
function linToStyles(text: string): Omit<LineStyle, "id">[] {
  return parseLin(text).map((p) => ({
    name: p.name,
    weight: 0.18,
    color: "#1a1a1a",
    dash: p.dash,
  }));
}

export function LinesTab({
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
