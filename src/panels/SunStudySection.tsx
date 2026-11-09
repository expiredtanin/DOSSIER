// Schattenstudie im Lage-Panel ([64]/[59]): Schalter, Datum, Zeitregler (Ortszeit) und
// Sonnenstand. Der Schatten selbst entsteht im Grundriss (`plan/generatePlan/sunShadow.ts`)
// und im 3D (render3d-Shadow-Mapping, `viewport/sun3d.ts`, [64]) aus `Project.sunStudy`; der Regler schreibt mit coalesceKey (ein Undo-Schritt je Ziehen).

import { t } from "../i18n";
import { useStore } from "../state/appStore";
import { projectLatLon, setField, sunPosition } from "../core";
import type { SunStudy } from "../model/types";
import { defaultStudyIso, formatMinutes, isoToLocal, localToIso } from "./sunStudyTime";

/** Merkdaten: Tagundnachtgleiche, Sommer- und Wintersonnenwende (Tag/Monat). */
const PRESETS: { key: "sun.equinox" | "sun.summer" | "sun.winter"; md: string }[] = [
  { key: "sun.equinox", md: "03-21" },
  { key: "sun.summer", md: "06-21" },
  { key: "sun.winter", md: "12-21" },
];

export function SunStudySection() {
  const project = useStore((s) => s.project);
  const applyChange = useStore((s) => s.applyChange);
  const study: SunStudy = project.sunStudy ?? { when: defaultStudyIso(), show: false };
  const local = isoToLocal(study.when) ?? isoToLocal(defaultStudyIso())!;

  const write = (next: SunStudy, key?: string) => applyChange([setField("sunStudy", next)], key);
  const setLocal = (date: string, minutes: number, key?: string) => {
    const iso = localToIso({ date, minutes });
    if (iso) write({ ...study, when: iso }, key);
  };

  const { lat, lon } = projectLatLon(project);
  const sun = sunPosition(lat, lon, new Date(study.when));
  const year = local.date.slice(0, 4);

  return (
    <div className="sun-study">
      <label className="sun-row">
        <input type="checkbox" checked={study.show} onChange={(e) => write({ ...study, show: e.target.checked })} />
        <span>{t("sun.show")}</span>
      </label>
      <label className="sun-row" title={t("sun.shadows3d.hint")}>
        <input
          type="checkbox"
          checked={study.shadows3d ?? study.show}
          onChange={(e) => write({ ...study, shadows3d: e.target.checked })}
        />
        <span>{t("sun.shadows3d")}</span>
      </label>
      <div className="sun-row">
        <input
          type="date"
          className="kz-input"
          value={local.date}
          onChange={(e) => setLocal(e.target.value, local.minutes, "sunStudy:date")}
        />
        {PRESETS.map((p) => (
          <button key={p.md} type="button" className="site-btn sun-preset" title={t(p.key)} onClick={() => setLocal(`${year}-${p.md}`, local.minutes)}>
            {p.md.slice(3)}.{p.md.slice(0, 2)}.
          </button>
        ))}
      </div>
      <div className="sun-row">
        <input
          type="range"
          className="sun-slider"
          min={0}
          max={1435}
          step={5}
          value={local.minutes}
          aria-label={t("sun.time")}
          onChange={(e) => setLocal(local.date, Number(e.target.value), "sunStudy:time")}
        />
        <span className="sun-time">{formatMinutes(local.minutes)}</span>
      </div>
      <label className="sun-row" title={t("sun.treeHeight.hint")}>
        <span>{t("sun.treeHeight")}</span>
        <input
          type="number"
          className="kz-input"
          min={1}
          max={60}
          step={0.5}
          value={study.treeHeight ?? 8}
          onChange={(e) => {
            const h = Number(e.target.value);
            if (Number.isFinite(h) && h > 0) write({ ...study, treeHeight: h }, "sunStudy:treeHeight");
          }}
        />
      </label>
      <div className="sun-readout">
        {sun.elevation > 0
          ? t("sun.position", { az: sun.azimuth.toFixed(0), el: sun.elevation.toFixed(1) })
          : t("sun.belowHorizon")}
        {!project.geoAnchor && <span title={t("sun.noAnchor.hint")}> · {t("sun.noAnchor")}</span>}
      </div>
    </div>
  );
}
