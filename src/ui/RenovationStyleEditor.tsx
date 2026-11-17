// [275] Umbau-Farben bearbeiten: je Status Füllung und Linie als freie Farbe ODER Stift (der gemeinsame `PenColorField`
// der App: Frei/Stift-Umschalter, Stift-Raster des aktiven Stiftsatzes), „gestrichelt“, Zurücksetzen je Status. Eine
// Komponente für das Umbau-Panel (Abschnitt „Darstellung“, Etappen) und den Ressourcen-Tab „Umbau“ — reine Darstellung,
// die Änderung geht als ganzes `RenovationStyles` an `onChange` (der Aufrufer macht daraus Ops).

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import type { Project, RenovationStatus, RenovationStyle, RenovationStyles } from "../model/types";
import { activePenSet } from "../model/penSets";
import { patchRenovationStyles, RENOVATION_STATUSES } from "../core";
import type { RenovationStyleSet } from "../core";
import { PenColorField } from "./PenColorField";

export interface RenovationStyleEditorProps {
  project: Project;
  /** Eigene Angaben (Projekt oder Etappe); `undefined` = keine. */
  styles: RenovationStyles | undefined;
  /** Aufgelöste Farben, die gerade gelten (Kern), für die Anzeige. */
  shown: RenovationStyleSet;
  onChange: (next: RenovationStyles | undefined, status: RenovationStatus) => void;
  statuses?: readonly RenovationStatus[];
  /** „gestrichelt“ für diese Status anbieten (Vorgabe: nur Abbruch). */
  dashedFor?: readonly RenovationStatus[];
  disabled?: boolean;
  /** Präfix der `data-testid` (z. B. `reno-style` → `reno-style-new`). */
  testId: string;
  onSaveColor?: (paletteId: string, hex: string) => void;
}

export function RenovationStyleEditor({ project, styles, shown, onChange, statuses = RENOVATION_STATUSES, dashedFor = ["demolish"], disabled, testId, onSaveColor }: RenovationStyleEditorProps) {
  const pens = project.pens ?? [];
  const activeStyles = activePenSet(project)?.pens;
  const patch = (s: RenovationStatus, p: Partial<RenovationStyle> | null) => onChange(patchRenovationStyles(styles, s, p), s);
  return (
    <div className="reno-style-grid">
      <div className="reno-style-row reno-style-head" aria-hidden="true">
        <span />
        <span className="reno-style-cap">{t("renovation.styles.fill")}</span>
        <span className="reno-style-cap">{t("renovation.styles.line")}</span>
        <span />
        <span />
      </div>
      {statuses.map((s) => {
        const own = styles?.[s];
        const st = shown[s];
        return (
          <div className="reno-style-row" key={s} data-testid={`${testId}-${s}`} data-fill={st.fill} data-line={st.line ?? ""} data-dashed={String(st.dashed)}>
            <span className="reno-style-label">{t(`renovation.status.${s}` as TranslationKey)}</span>
            <span className="reno-style-field" title={t("renovation.styles.fill")} data-testid={`${testId}-${s}-fill`}>
              <PenColorField
                color={st.fill}
                penId={own?.fillPen}
                pens={pens}
                activeStyles={activeStyles}
                customPalettes={project.customPalettes}
                builtinBanks={project.builtinPaletteBanks}
                onSaveColor={onSaveColor}
                disabled={disabled}
                onColorChange={(fill) => patch(s, { fill })}
                onPenChange={(fillPen) => patch(s, fillPen ? { fillPen } : { fillPen: undefined, fill: st.fill })}
              />
            </span>
            <span className="reno-style-field" title={t("renovation.styles.line")} data-testid={`${testId}-${s}-line`}>
              <PenColorField
                color={st.line ?? "#000000"}
                penId={own?.linePen}
                pens={pens}
                activeStyles={activeStyles}
                customPalettes={project.customPalettes}
                builtinBanks={project.builtinPaletteBanks}
                onSaveColor={onSaveColor}
                disabled={disabled}
                onColorChange={(line) => patch(s, { line })}
                onPenChange={(linePen) => patch(s, linePen ? { linePen } : { linePen: undefined, ...(st.line ? { line: st.line } : {}) })}
              />
            </span>
            {dashedFor.includes(s) ? (
              <label className="reno-style-dashed">
                <input type="checkbox" checked={st.dashed} disabled={disabled} data-testid={`${testId}-${s}-dashed`} onChange={(e) => patch(s, { dashed: e.target.checked })} />
                {t("renovation.styles.dashed")}
              </label>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="reno-icon-btn"
              disabled={disabled || !own}
              title={t("renovation.styles.reset")}
              aria-label={t("renovation.styles.reset")}
              data-testid={`${testId}-${s}-reset`}
              onClick={() => patch(s, null)}
            >
              ↺
            </button>
          </div>
        );
      })}
    </div>
  );
}
