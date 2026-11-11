// Einstellungen eines Gelände-/Umgebungs-Elements (Netzkörper, Gelände, Baugrube) in der Objekt-Info ([137]:
// ein angeklicktes Gelände bzw. eine Baugrube zeigt dort ihre Felder). Gelände zusätzlich: Sichtbarkeit seiner
// Klasse und Glättung (aus den Höhenlinien neu erzeugt, ein Undo-Schritt); Raster-Gelände (swissALTI3D, ohne
// Höhenlinien) additiv nachglätten. [181] Sichtbarkeit nur über die Klasse — kein Einzel-Ausblenden, keine Import-Liste.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch. Alle sichtbaren Texte über t(...).

import { t } from "../i18n";
import { usePanelHost } from "./host";
import { useStore } from "../state/appStore";
import type { ContextObject } from "../model/types";
import { flattenCategories } from "../model/types";
import { resmoothGridTerrain } from "../model/terrain";
import { useMemo } from "react";
import type { ExcavationQuantity } from "../core";

/** Zahl-Eingabe für ein Feld eines Kontext-Objekts (leer = Standard, ungültig = keine Änderung). */
export function NumField(props: {
  label: string;
  value: number | undefined;
  step: number;
  min?: number;
  placeholder?: string;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="site-prop">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        min={props.min}
        placeholder={props.placeholder}
        value={props.value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return props.onChange(undefined);
          const v = Number(raw);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

const fmt1 = (v: number) => v.toLocaleString("de-CH", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function ExcavationQty({ q }: { q: ExcavationQuantity | undefined }) {
  if (!q) return <div className="site-qty">{t("site.excavation.noTerrain")}</div>;
  return (
    <div className="site-qty">
      {t("site.excavation.qty", { cut: fmt1(q.cut), fill: fmt1(q.fill), backfill: fmt1(q.backfill) })}
      {q.workingSpace > 0 && !q.workingSpaceOk && (
        <div className="site-warn" role="alert" data-testid="excavation-ws-warning">
          {t("site.excavation.workingSpaceWarn", { min: q.workingSpaceMin.toFixed(2), need: q.workingSpace.toFixed(2), n: q.workingSpaceSpots.length })}
        </div>
      )}
    </div>
  );
}

/** Glättungsstufen der Gelände-Erzeugung (`terrain.rs`, 0 = roh). */
const SMOOTH_LEVELS = [0, 1, 2, 3] as const;
/** [137] Zusätzliche Glättungs-Durchgänge für Raster-Gelände. */
const RESMOOTH_PASSES = [1, 2, 4] as const;

/** Felder eines Kontext-Objekts; `null` für Arten ohne eigene Einstellungen (Höhenlinien, Luftbild). */
export function ContextObjectProps({ obj, quantities }: { obj: ContextObject; quantities: readonly ExcavationQuantity[] }) {
  const host = usePanelHost();
  const project = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const regenerateTerrain = useStore((s) => s.regenerateTerrain);
  const resmoothTerrain = useStore((s) => s.resmoothTerrain);
  // [137] Raster-Gelände (swissALTI3D) lässt sich ohne Höhenlinien nachglätten; Prüfung nur bei Netz-Wechsel.
  const terrainPositions = obj.type === "terrainMesh" ? obj.positions : null;
  const isGrid = useMemo(() => (terrainPositions ? resmoothGridTerrain(terrainPositions, 0) !== null : false), [terrainPositions]);
  const patch = (field: string) => (v: number | undefined) => host.onPatchContextObject(obj.id, { [field]: v }, `site-${obj.id}-${field}`);

  if (obj.type === "importedMesh") {
    // [T4] Glatt oder kantig schattieren, Knickwinkel je Mesh (Vorgabe 30°).
    return (
      <div className="site-props">
        <label className="site-check">
          <input
            type="checkbox"
            checked={obj.smoothShading === true}
            onChange={(e) => host.onPatchContextObject(obj.id, { smoothShading: e.target.checked }, `site-${obj.id}-smoothShading`)}
          />
          {t("site.smoothShading")}
        </label>
        {obj.smoothShading === true && (
          <NumField label={t("site.creaseAngle")} value={obj.creaseAngle} step={5} min={1} placeholder="30" onChange={patch("creaseAngle")} />
        )}
      </div>
    );
  }

  if (obj.type === "terrainMesh") {
    const cat = flattenCategories(project.layers).find((c) => c.code === obj.categoryCode);
    const hasSource = (project.context ?? []).some((o) => o.type === "contourSet");
    return (
      <div className="site-props">
        {cat && (
          <label className="site-check" title={t("site.terrain.visible.hint", { name: `${cat.code} ${cat.name}` })}>
            <input type="checkbox" data-testid="terrain-visible" checked={cat.visible} onChange={() => host.onToggleCategory(cat.code)} />
            {t("site.terrain.visible")}
          </label>
        )}
        {hasSource && (
          <label className="site-prop" title={t("site.terrain.smooth.hint")}>
            <span>{t("site.terrain.smooth")}</span>
            <select
              data-testid="terrain-smooth"
              value={obj.smooth === undefined ? "" : String(obj.smooth)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (e.target.value === "" || !Number.isFinite(v)) return;
                if (!regenerateTerrain(obj.id, v)) notify(t("site.terrainFailed"), "error");
              }}
            >
              {obj.smooth === undefined && <option value="">—</option>}
              {SMOOTH_LEVELS.map((n) => (
                <option key={n} value={String(n)}>
                  {n === 0 ? t("site.terrain.smooth.raw") : t("site.terrain.smooth.level", { n })}
                </option>
              ))}
            </select>
          </label>
        )}
        {!hasSource && (
          <label className="site-prop" title={isGrid ? t("site.terrain.resmooth.hint") : t("site.terrain.resmooth.unavailable")}>
            <span>{t("site.terrain.smooth")}</span>
            <select
              data-testid="terrain-resmooth"
              disabled={!isGrid}
              value=""
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!(n > 0)) return;
                if (!resmoothTerrain(obj.id, n)) notify(t("site.terrain.resmooth.unavailable"), "error");
              }}
            >
              <option value="">
                {obj.smooth ? t("site.terrain.resmooth.current", { n: obj.smooth }) : t("site.terrain.resmooth.none")}
              </option>
              {isGrid &&
                RESMOOTH_PASSES.map((n) => (
                  <option key={n} value={String(n)}>
                    {t("site.terrain.resmooth.more", { n })}
                  </option>
                ))}
            </select>
          </label>
        )}
        <NumField label={t("site.contourInterval")} value={obj.contourInterval} step={0.5} min={0} placeholder="—" onChange={patch("contourInterval")} />
        <NumField label={t("site.contourIndexEvery")} value={obj.contourIndexEvery} step={1} min={1} placeholder="5" onChange={patch("contourIndexEvery")} />
        <NumField label={t("site.earthDepth")} value={obj.earthDepth} step={0.5} min={0.1} placeholder="1.5" onChange={patch("earthDepth")} />
      </div>
    );
  }

  if (obj.type === "excavation") {
    return (
      <div className="site-props">
        <NumField label={t("site.excavation.bottom")} value={obj.bottom} step={0.05} onChange={(v) => v !== undefined && patch("bottom")(v)} />
        <NumField label={t("site.excavation.slope")} value={obj.slope} step={5} min={5} placeholder="45" onChange={patch("slope")} />
        <NumField label={t("site.excavation.fillSlope")} value={obj.fillSlope} step={5} min={5} placeholder="33.7" onChange={patch("fillSlope")} />
        <NumField label={t("site.excavation.bermWidth")} value={obj.bermWidth} step={0.25} min={0} placeholder="—" onChange={patch("bermWidth")} />
        <NumField label={t("site.excavation.bermHeight")} value={obj.bermHeight} step={0.5} min={0} placeholder="—" onChange={patch("bermHeight")} />
        <NumField label={t("site.excavation.workingSpace")} value={obj.workingSpace} step={0.1} min={0} placeholder="0" onChange={patch("workingSpace")} />
        <div className="site-prop" title={t("site.excavation.shoringHint")}>
          <span>{t("site.excavation.shoring")}</span>
          <span>
            {obj.outline.map((_, i) => (
              <label key={i} style={{ marginRight: 6 }}>
                <input
                  type="checkbox"
                  data-testid={`excavation-shoring-${i}`}
                  checked={obj.edgeShoring?.[i] === true}
                  onChange={(e) => {
                    const next = obj.outline.map((__, k) => (k === i ? e.target.checked : obj.edgeShoring?.[k] === true));
                    host.onPatchContextObject(obj.id, { edgeShoring: next.some(Boolean) ? next : undefined }, `site-${obj.id}-edgeShoring`);
                  }}
                />
                {i + 1}
              </label>
            ))}
          </span>
        </div>
        {obj.edgeShoring?.some(Boolean) && (
          <>
            <label className="site-prop">
              <span>{t("site.excavation.shoringKind")}</span>
              <select
                data-testid="excavation-shoring-kind"
                value={obj.shoringKind ?? "sheetPile"}
                onChange={(e) => host.onPatchContextObject(obj.id, { shoringKind: e.target.value }, `site-${obj.id}-shoringKind`)}
              >
                <option value="sheetPile">{t("site.excavation.shoringKind.sheetPile")}</option>
                <option value="soldierPile">{t("site.excavation.shoringKind.soldierPile")}</option>
                <option value="borePile">{t("site.excavation.shoringKind.borePile")}</option>
              </select>
            </label>
            <NumField label={t("site.excavation.shoringThickness")} value={obj.shoringThickness} step={0.05} min={0.05} placeholder={obj.shoringKind === "borePile" ? "0.6" : obj.shoringKind === "soldierPile" ? "0.3" : "0.2"} onChange={patch("shoringThickness")} />
          </>
        )}
        <ExcavationQty q={quantities.find((x) => x.id === obj.id)} />
      </div>
    );
  }
  return null;
}
