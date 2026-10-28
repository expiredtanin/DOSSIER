// Baurecht im Lage-Panel ([63]): Parzelle und Baulinien aus der Auswahl übernehmen,
// Grenzabstände (pauschal und je Kante), Gesamthöhe; Ergebnis der Prüfung. Die Darstellung im
// Grundriss entsteht aus `Project.siteRules` (`plan/generatePlan/siteRules.ts`).

import { t } from "../i18n";
import { usePanelHost } from "./host";
import { useStore } from "../state/appStore";
import { checkSiteRules, setField } from "../core";
import type { Project, SiteRules } from "../model/types";
import { lineFromDrawing, parcelFromDrawing } from "./siteRulesInput";

const fmt = (n: number, d = 1) => n.toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Zahl aus einer Eingabe; leer → undefined, ungültig/negativ → null (verwerfen). */
function parseLen(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const v = Number(text.trim().replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function SiteRulesSection() {
  const host = usePanelHost();
  const applyChange = useStore((s) => s.applyChange);
  const rules = host.project.siteRules;
  const sel = host.selection;
  const selDrawing = sel?.kind === "drawing2d" ? host.project.drawings2d.find((d) => d.id === sel.id) : undefined;
  const selParcel = parcelFromDrawing(selDrawing);
  const selLine = lineFromDrawing(selDrawing);

  const write = (fn: (r: SiteRules) => SiteRules | undefined, key?: string) =>
    applyChange((p: Project) => {
      const old = p.siteRules;
      if (!old) return [];
      return [setField("siteRules", fn(old))];
    }, key);

  const takeParcel = () => {
    if (!selParcel) return;
    applyChange((p: Project) => {
      // Neue Grenze: Grenzabstände je Kante passen nicht mehr → zurücksetzen.
      const { setbacks: _old, ...prev } = p.siteRules ?? { parcel: [], defaultSetback: 4 };
      return [setField("siteRules", { ...prev, parcel: selParcel })];
    });
  };

  if (!rules) {
    return (
      <div className="site-rules">
        <div className="site-rules-head">{t("siteRules.title")}</div>
        <button type="button" className="site-btn" disabled={!selParcel} onClick={takeParcel} title={t("siteRules.fromSelection.hint")}>
          {t("siteRules.fromSelection")}
        </button>
        {!selParcel && <div className="sun-readout">{t("siteRules.fromSelection.hint")}</div>}
      </div>
    );
  }

  const check = checkSiteRules(host.project);
  const n = rules.parcel.length;
  const ok = check !== null && check.violationArea < 0.01 && !check.heightExceeded;

  return (
    <div className="site-rules">
      <div className="site-rules-head">
        <span>{t("siteRules.title")}</span>
        <label className="sun-row">
          <input
            type="checkbox"
            checked={rules.show !== false}
            onChange={(e) => write((r) => ({ ...r, show: e.target.checked }))}
          />
          <span>{t("siteRules.show")}</span>
        </label>
      </div>

      {check && (
        <div className={"site-rules-result" + (ok ? " ok" : " bad")}>
          <div>{t("siteRules.areas", { parcel: fmt(check.parcelArea), allowed: fmt(check.allowedArea) })}</div>
          <div>
            {check.violationArea >= 0.01
              ? t("siteRules.violation", { area: fmt(check.violationArea, 2) })
              : t("siteRules.inside")}
          </div>
          {rules.maxHeight !== undefined && check.maxTop !== null && (
            <div>
              {t(check.heightExceeded ? "siteRules.heightOver" : "siteRules.heightOk", {
                top: fmt(check.maxTop, 2),
                max: fmt(rules.maxHeight, 2),
              })}
            </div>
          )}
        </div>
      )}

      <label className="kz-parcel">
        <span>{t("siteRules.defaultSetback")}</span>
        <input
          type="number"
          min={0}
          step={0.5}
          className="kz-input kz-num"
          value={rules.defaultSetback}
          onChange={(e) => {
            const v = parseLen(e.target.value);
            if (typeof v === "number") write((r) => ({ ...r, defaultSetback: v }), "siteRules:default");
          }}
        />
        <span>m</span>
      </label>
      <label className="kz-parcel">
        <span>{t("siteRules.maxHeight")}</span>
        <input
          type="number"
          min={0}
          step={0.5}
          className="kz-input kz-num"
          value={rules.maxHeight ?? ""}
          placeholder="–"
          onChange={(e) => {
            const v = parseLen(e.target.value);
            if (v === null) return;
            write((r) => {
              const { maxHeight: _old, ...rest } = r;
              return v === undefined ? rest : { ...rest, maxHeight: v };
            }, "siteRules:maxHeight");
          }}
        />
        <span>m</span>
      </label>

      <details className="site-rules-edges">
        <summary>{t("siteRules.edges", { n })}</summary>
        {rules.parcel.map((p, i) => {
          const q = rules.parcel[(i + 1) % n];
          const own = rules.setbacks?.[i];
          return (
            <label key={i} className="kz-parcel">
              <span>{t("siteRules.edge", { i: i + 1, len: fmt(Math.hypot(q.x - p.x, q.y - p.y)) })}</span>
              <input
                type="number"
                min={0}
                step={0.5}
                className="kz-input kz-num"
                value={own ?? ""}
                placeholder={String(rules.defaultSetback)}
                onChange={(e) => {
                  const v = parseLen(e.target.value);
                  if (v === null) return;
                  write((r) => {
                    // Leere Felder vor dem letzten gesetzten Wert erben den pauschalen Abstand.
                    const s = Array.from({ length: n }, (_, j) => r.setbacks?.[j] ?? r.defaultSetback);
                    s[i] = v ?? r.defaultSetback;
                    return { ...r, setbacks: s };
                  }, `siteRules:edge:${i}`);
                }}
              />
              <span>m</span>
            </label>
          );
        })}
      </details>

      <div className="site-rules-lines">
        <span>{t("siteRules.lines", { n: rules.buildingLines?.length ?? 0 })}</span>
        <button
          type="button"
          className="site-btn"
          disabled={!selLine}
          title={t("siteRules.addLine.hint")}
          onClick={() => selLine && write((r) => ({ ...r, buildingLines: [...(r.buildingLines ?? []), selLine] }))}
        >
          {t("siteRules.addLine")}
        </button>
        {(rules.buildingLines?.length ?? 0) > 0 && (
          <button
            type="button"
            className="site-remove"
            title={t("siteRules.clearLines")}
            aria-label={t("siteRules.clearLines")}
            onClick={() =>
              write((r) => {
                const { buildingLines: _old, ...rest } = r;
                return rest;
              })
            }
          >
            ×
          </button>
        )}
      </div>

      <div className="site-actions">
        <button type="button" className="site-btn" disabled={!selParcel} title={t("siteRules.fromSelection.hint")} onClick={takeParcel}>
          {t("siteRules.replaceParcel")}
        </button>
        <button type="button" className="site-btn" onClick={() => write(() => undefined)}>
          {t("siteRules.remove")}
        </button>
      </div>
    </div>
  );
}
