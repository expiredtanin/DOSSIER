// Baurecht im Lage-Panel ([63]): Parzelle und Baulinien aus der Auswahl übernehmen,
// Grenzabstände (pauschal und je Kante), Gesamthöhe; Ergebnis der Prüfung. Die Darstellung im
// Grundriss entsteht aus `Project.siteRules` (`plan/generatePlan/siteRules.ts`).

import { t } from "../i18n";
import { useSelectionInfo } from "../state/useSelectionInfo";
import { useStore } from "../state/appStore";
import { checkSiteRules, patchItem, setField } from "../core";
import type { Project, SiteRules } from "../model/types";
import { lineFromDrawing, parcelFromDrawing } from "./siteRulesInput";

const fmt = (n: number, d = 1) => n.toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Zahl aus einer Eingabe; leer → undefined, ungültig/negativ → null (verwerfen). */
function parseLen(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const v = Number(text.trim().replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Gewählte Decke/Körper/Wand (Erker), die als Vorsprung markiert werden kann, samt aktuellem Stand. */
function projectionTarget(
  p: Project,
  sel: { kind: string; id: string } | null | undefined,
): { kind: "ceiling" | "extrudedSolid" | "wall"; id: string; flag: boolean } | null {
  if (sel?.kind === "ceiling") {
    const c = p.ceilings?.find((x) => x.id === sel.id);
    return c ? { kind: "ceiling", id: c.id, flag: c.siteProjection === true } : null;
  }
  if (sel?.kind === "wall") {
    const w = p.walls.find((x) => x.id === sel.id);
    return w ? { kind: "wall", id: w.id, flag: w.siteProjection === true } : null;
  }
  if (sel?.kind === "extrudedSolid") {
    const x = p.extrudedSolids?.find((e) => e.id === sel.id);
    return x && x.operation !== "subtract" ? { kind: "extrudedSolid", id: x.id, flag: x.siteProjection === true } : null;
  }
  return null;
}

/** Vorsprung-Markierung setzen (true) oder entfernen (Feld fehlt = normales Bauteil). */
function withProjection<T extends { siteProjection?: boolean }>(e: T, on: boolean): T {
  const { siteProjection: _old, ...rest } = e;
  return (on ? { ...rest, siteProjection: true } : rest) as T;
}

export function SiteRulesSection() {
  const project = useStore((s) => s.project);
  const applyChange = useStore((s) => s.applyChange);
  const rules = project.siteRules;
  const sel = useSelectionInfo();
  const selDrawing = sel?.kind === "drawing2d" ? project.drawings2d.find((d) => d.id === sel.id) : undefined;
  const selParcel = parcelFromDrawing(selDrawing);
  const selLine = lineFromDrawing(selDrawing);
  // Vorsprung markieren: gewählte Decke (Balkon), freier Körper oder Wand (Erker).
  const selProjection = projectionTarget(project, sel);

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

  const check = checkSiteRules(project);
  const n = rules.parcel.length;
  const ok = check !== null && check.violationArea < 0.01 && !check.heightExceeded && !check.profileExceeded;

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
        <label className="sun-row" title={t("siteRules.show3d.hint")}>
          <input
            type="checkbox"
            checked={rules.show3d === true}
            onChange={(e) => write((r) => ({ ...r, show3d: e.target.checked }))}
          />
          <span>{t("siteRules.show3d")}</span>
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
                top: fmt(check.heightAboveTerrain ?? check.maxTop, 2),
                max: fmt(rules.maxHeight, 2),
              })}
            </div>
          )}
          {rules.profileAngle !== undefined && (
            <div>{t(check.profileExceeded ? "siteRules.profileOver" : "siteRules.profileOk")}</div>
          )}
          {check.terrainMin !== null && (
            <div>{t("siteRules.terrainAtFacade", { z: fmt(check.terrainMin, 2) })}</div>
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

      <label className="kz-parcel" title={t("siteRules.profileAngle.hint")}>
        <span>{t("siteRules.profileAngle")}</span>
        <input
          type="number"
          min={0}
          max={89}
          step={5}
          className="kz-input kz-num"
          value={rules.profileAngle ?? ""}
          placeholder="–"
          onChange={(e) => {
            const v = parseLen(e.target.value);
            if (v === null || (v !== undefined && v >= 90)) return;
            write((r) => {
              const { profileAngle: _old, ...rest } = r;
              return v === undefined ? rest : { ...rest, profileAngle: v };
            }, "siteRules:profileAngle");
          }}
        />
        <span>°</span>
      </label>
      {rules.profileAngle !== undefined && (
        <label className="kz-parcel" title={t("siteRules.profileHeight.hint")}>
          <span>{t("siteRules.profileHeight")}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            className="kz-input kz-num"
            value={rules.profileHeight ?? ""}
            placeholder="0"
            onChange={(e) => {
              const v = parseLen(e.target.value);
              if (v === null) return;
              write((r) => {
                const { profileHeight: _old, ...rest } = r;
                return v === undefined ? rest : { ...rest, profileHeight: v };
              }, "siteRules:profileHeight");
            }}
          />
          <span>m</span>
        </label>
      )}

      <label className="kz-parcel" title={t("siteRules.projectionDepth.hint")}>
        <span>{t("siteRules.projectionDepth")}</span>
        <input
          type="number"
          min={0}
          step={0.1}
          className="kz-input kz-num"
          value={rules.projectionDepth ?? ""}
          placeholder="–"
          onChange={(e) => {
            const v = parseLen(e.target.value);
            if (v === null) return;
            write((r) => {
              const { projectionDepth: _old, ...rest } = r;
              return v === undefined ? rest : { ...rest, projectionDepth: v };
            }, "siteRules:projectionDepth");
          }}
        />
        <span>m</span>
      </label>
      {rules.projectionDepth !== undefined && (
        <label className="kz-parcel" title={t("siteRules.projectionShare.hint")}>
          <span>{t("siteRules.projectionShare")}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            className="kz-input kz-num"
            value={rules.projectionShare === undefined ? "" : Math.round(rules.projectionShare * 1000) / 10}
            placeholder="–"
            onChange={(e) => {
              const v = parseLen(e.target.value);
              if (v === null) return;
              write((r) => {
                const { projectionShare: _old, ...rest } = r;
                return v === undefined ? rest : { ...rest, projectionShare: v / 100 };
              }, "siteRules:projectionShare");
            }}
          />
          <span>%</span>
        </label>
      )}
      {rules.projectionDepth !== undefined && selProjection && (
        <label className="sun-row" title={t("siteRules.markProjection.hint")}>
          <input
            type="checkbox"
            checked={selProjection.flag}
            onChange={(e) => {
              const v = e.target.checked;
              applyChange((p: Project) =>
                selProjection.kind === "ceiling"
                  ? patchItem(p, "ceilings", selProjection.id, (c) => withProjection(c, v))
                  : selProjection.kind === "wall"
                    ? patchItem(p, "walls", selProjection.id, (w) => withProjection(w, v))
                    : patchItem(p, "extrudedSolids", selProjection.id, (x) => withProjection(x, v)),
              );
            }}
          />
          <span>{t("siteRules.markProjection")}</span>
        </label>
      )}

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
