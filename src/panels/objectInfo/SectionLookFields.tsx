// Darstellung einer Schnitt-/Ansichtslinie im Plan ([276]): Linie (durchgehend / nur Enden / keine), Linientyp, Stift,
// Marke (Pfeil / L / Dreieck / keine), Marke an Anfang/Ende/beiden, Beschriftung — mit kleinen Vorschau-Symbolen je Option.
// Gerufen von `SectionLineSection`. Die Werte der Ebene gehen vor, danach die Vorgabe der Modelldarstellung des gerade
// gezeigten Plans (Ressourcen > Modelldarstellung > Schnitt-/Ansichtsmarken), zuletzt die Basis (wie bisher).

import type { ReactNode } from "react";
import type { DrawingLevel, ModelViewSectionMarks, Project, SectionLineMode, SectionMarker, SectionMarkerAt } from "../../model/types";
import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";

/** Wirksame Darstellung einer Linie: Ebene > Vorgabe der Modelldarstellung > Basis (gleiche Reihenfolge wie der Kern). */
export interface SectionLookValues {
  lineMode: SectionLineMode;
  endLengthMm: number;
  marker: SectionMarker;
  markerAt: SectionMarkerAt;
  markerLabel: boolean;
}

export function effectiveSectionLook(level: DrawingLevel, marks: ModelViewSectionMarks | undefined): SectionLookValues {
  const elev = level.kind === "elevation";
  return {
    lineMode: level.lineMode ?? marks?.lineMode ?? (elev ? "none" : "full"),
    endLengthMm: level.endLengthMm ?? marks?.endLengthMm ?? 12,
    marker: level.marker ?? marks?.marker ?? (elev ? "triangle" : "arrow"),
    markerAt: level.markerAt ?? marks?.markerAt ?? "both",
    markerLabel: level.markerLabel ?? marks?.markerLabel ?? true,
  };
}

/** Vorgabe der Modelldarstellung des gezeigten Plans für Schnitte bzw. Ansichten. */
export function marksOfPlan(project: Project, planLevelId: string, elev: boolean): ModelViewSectionMarks | undefined {
  const mvId = project.drawingLevels.find((l) => l.id === planLevelId)?.modelViewOptionId;
  const mv = mvId ? project.modelViewOptions?.find((m) => m.id === mvId) : undefined;
  return elev ? mv?.elevationMarks : mv?.sectionMarks;
}

const INK = "currentColor";

/** Kleine Vorschau (36 × 20): Linie waagrecht, Blickrichtung nach unten. */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true" className="look-icon">
      {children}
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  // Linie
  "line:full": (
    <Svg>
      <line x1="2" y1="6" x2="9" y2="6" stroke={INK} strokeWidth="2.4" />
      <line x1="9" y1="6" x2="27" y2="6" stroke={INK} strokeWidth="1" strokeDasharray="5 1.5 1 1.5" />
      <line x1="27" y1="6" x2="34" y2="6" stroke={INK} strokeWidth="2.4" />
    </Svg>
  ),
  "line:ends": (
    <Svg>
      <line x1="2" y1="6" x2="9" y2="6" stroke={INK} strokeWidth="2.4" />
      <line x1="27" y1="6" x2="34" y2="6" stroke={INK} strokeWidth="2.4" />
    </Svg>
  ),
  "line:none": (
    <Svg>
      <line x1="2" y1="6" x2="34" y2="6" stroke={INK} strokeWidth="1" strokeDasharray="1 3" opacity="0.4" />
      <line x1="12" y1="2" x2="24" y2="10" stroke={INK} strokeWidth="1.2" opacity="0.7" />
    </Svg>
  ),
  // Marke
  "marker:arrow": (
    <Svg>
      <line x1="4" y1="3" x2="4" y2="13" stroke={INK} strokeWidth="2" />
      <polygon points="4,18 1,12 7,12" fill={INK} />
      <line x1="32" y1="3" x2="32" y2="13" stroke={INK} strokeWidth="2" />
      <polygon points="32,18 29,12 35,12" fill={INK} />
    </Svg>
  ),
  "marker:lAngle": (
    <Svg>
      <polyline points="12,3 4,3 4,14" fill="none" stroke={INK} strokeWidth="2" />
      <polyline points="24,3 32,3 32,14" fill="none" stroke={INK} strokeWidth="2" />
    </Svg>
  ),
  "marker:triangle": (
    <Svg>
      <polygon points="4,16 0.5,6 7.5,6" fill={INK} />
      <polygon points="32,16 28.5,6 35.5,6" fill={INK} />
    </Svg>
  ),
  "marker:none": (
    <Svg>
      <line x1="12" y1="4" x2="24" y2="14" stroke={INK} strokeWidth="1.2" opacity="0.7" />
    </Svg>
  ),
  // Marke an
  "at:both": (
    <Svg>
      <line x1="4" y1="6" x2="32" y2="6" stroke={INK} strokeWidth="1" opacity="0.5" />
      <polygon points="4,16 1,8 7,8" fill={INK} />
      <polygon points="32,16 29,8 35,8" fill={INK} />
    </Svg>
  ),
  "at:start": (
    <Svg>
      <line x1="4" y1="6" x2="32" y2="6" stroke={INK} strokeWidth="1" opacity="0.5" />
      <polygon points="4,16 1,8 7,8" fill={INK} />
    </Svg>
  ),
  "at:end": (
    <Svg>
      <line x1="4" y1="6" x2="32" y2="6" stroke={INK} strokeWidth="1" opacity="0.5" />
      <polygon points="32,16 29,8 35,8" fill={INK} />
    </Svg>
  ),
};

/** Elevation: ein Zeichen in der Mitte statt je Ende. */
const ELEVATION_ICONS: Record<string, ReactNode> = {
  "marker:arrow": (
    <Svg>
      <line x1="18" y1="3" x2="18" y2="13" stroke={INK} strokeWidth="2" />
      <polygon points="18,18 15,12 21,12" fill={INK} />
    </Svg>
  ),
  "marker:triangle": (
    <Svg>
      <polygon points="18,16 14.5,6 21.5,6" fill={INK} />
    </Svg>
  ),
};

interface Choice<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
}

/** Gruppe von Symbol-Knöpfen (eine Wahl); der Tooltip trägt die Beschriftung. */
export function IconChoice<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Choice<T>[]; label: string }) {
  return (
    <div className="look-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`look-choice-btn${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          title={o.label}
          aria-label={o.label}
          data-testid={`look-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

const lbl = (k: string) => t(`objinfo.sectionLine.look.${k}` as TranslationKey);

export function SectionLookFields({
  level,
  project,
  planLevelId,
  onPatch,
}: {
  level: DrawingLevel;
  project: Project;
  planLevelId: string;
  onPatch: (patch: Partial<DrawingLevel>) => void;
}) {
  const elev = level.kind === "elevation";
  const eff = effectiveSectionLook(level, marksOfPlan(project, planLevelId, elev));
  const icon = (key: string) => (elev ? ELEVATION_ICONS[key] : undefined) ?? ICONS[key];
  const modes: SectionLineMode[] = ["full", "ends", "none"];
  const markers: SectionMarker[] = elev ? ["triangle", "arrow", "none"] : ["arrow", "lAngle", "triangle", "none"];
  const ats: SectionMarkerAt[] = ["both", "start", "end"];
  const pens = project.pens ?? [];
  const penSet = project.penSets?.find((s) => s.id === project.activePenSetId);
  const overridden = [level.lineMode, level.endLengthMm, level.lineStyleId, level.linePenId, level.marker, level.markerAt, level.markerLabel].some((v) => v !== undefined);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.sectionLine.look")}</div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{lbl("line")}</span>
        <IconChoice
          label={lbl("line")}
          value={eff.lineMode}
          onChange={(v) => onPatch({ lineMode: v })}
          options={modes.map((m) => ({ value: m, label: lbl(m), icon: icon(`line:${m}`) }))}
        />
      </div>

      {eff.lineMode !== "none" && (
        <>
          {eff.lineMode === "ends" && (
            <div className="objinfo-field">
              <span className="objinfo-flabel">{lbl("endLength")}</span>
              <input
                type="number"
                className="objinfo-text"
                step={1}
                min={2}
                max={60}
                value={level.endLengthMm ?? eff.endLengthMm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onPatch({ endLengthMm: v });
                }}
                title={lbl("endLength")}
              />
            </div>
          )}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{lbl("lineStyle")}</span>
            <Dropdown
              value={level.lineStyleId ?? ""}
              onChange={(v) => onPatch({ lineStyleId: v === "" ? undefined : v })}
              options={[{ value: "", label: t("attr.lineStyle.none") }, ...project.lineStyles.map((l) => ({ value: l.id, label: l.name }))]}
              title={lbl("lineStyle")}
              width={150}
            />
          </div>
        </>
      )}

      <div className="objinfo-field">
        <span className="objinfo-flabel">{lbl("pen")}</span>
        <Dropdown
          value={level.linePenId ?? ""}
          onChange={(v) => onPatch({ linePenId: v === "" ? undefined : v })}
          options={[
            { value: "", label: t("attr.lineStyle.none") },
            ...pens.map((p) => {
              const w = penSet?.pens[p.id]?.weight;
              return { value: p.id, label: w ? `${p.name} · ${w} mm` : p.name };
            }),
          ]}
          title={lbl("pen")}
          width={150}
        />
      </div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{lbl("marker")}</span>
        <IconChoice
          label={lbl("marker")}
          value={eff.marker}
          onChange={(v) => onPatch({ marker: v })}
          options={markers.map((m) => ({ value: m, label: lbl(m), icon: icon(`marker:${m}`) }))}
        />
      </div>

      {!elev && eff.marker !== "none" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{lbl("markerAt")}</span>
          <IconChoice
            label={lbl("markerAt")}
            value={eff.markerAt}
            onChange={(v) => onPatch({ markerAt: v })}
            options={ats.map((m) => ({ value: m, label: lbl(m), icon: icon(`at:${m}`) }))}
          />
        </div>
      )}

      <div className="objinfo-field">
        <span className="objinfo-flabel">{lbl("label")}</span>
        <input type="checkbox" checked={eff.markerLabel} onChange={(e) => onPatch({ markerLabel: e.target.checked })} title={lbl("label")} />
      </div>

      {overridden && (
        <button
          type="button"
          className="objinfo-btn"
          onClick={() => onPatch({ lineMode: undefined, endLengthMm: undefined, lineStyleId: undefined, linePenId: undefined, marker: undefined, markerAt: undefined, markerLabel: undefined })}
        >
          {lbl("reset")}
        </button>
      )}
    </>
  );
}
