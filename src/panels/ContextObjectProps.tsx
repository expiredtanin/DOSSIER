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
import { useEffect, useMemo, useState } from "react";
import type { ExcavationQuantity } from "../core";

/** Zahl-Eingabe für ein Feld eines Kontext-Objekts (leer = Standard, ungültig = keine Änderung). */
export function NumField(props: {
  label: string;
  value: number | undefined;
  step: number;
  min?: number;
  placeholder?: string;
  /** Einheit hinter dem Feld (nicht im Label). */
  unit?: string;
  title?: string;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="objinfo-field" title={props.title}>
      <span className="objinfo-flabel">{props.label}</span>
      <input
        className="objinfo-input"
        type="number"
        step={props.step}
        min={props.min}
        placeholder={props.placeholder}
        value={props.value === undefined ? "" : Number(props.value.toPrecision(12))}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return props.onChange(undefined);
          const v = Number(raw);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
      <span className="objinfo-unit">{props.unit}</span>
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


/** [193] Netzpunkt wählen (Nummer ab 1) und seine Höhe setzen; Zuschneiden des Netzes auf die Parzelle. */
function MeshPointFields({ obj }: { obj: Extract<ContextObject, { positions: number[] }> }) {
  const host = usePanelHost();
  const setMeshPointHeight = useStore((s) => s.setMeshPointHeight);
  const cropMesh = useStore((s) => s.cropMesh);
  const notify = useStore((s) => s.notify);
  const parcel = useStore((s) => s.project.siteRules?.parcel);
  const deleteMeshPoint = useStore((s) => s.deleteMeshPoint);
  const active = useStore((s) => s.activeMeshPoint);
  const [nr, setNr] = useState("1");
  // Klick auf einen Netzpunkt-Griff im Grundriss wählt den Punkt: Nummer (und damit Höhe) vorausgefüllt.
  const activeIndex = active?.id === obj.id ? active.index : null;
  useEffect(() => {
    if (activeIndex != null) setNr(String(activeIndex + 1));
  }, [activeIndex]);
  const n = Math.floor(obj.positions.length / 3);
  const i = Math.round(Number(nr)) - 1;
  const valid = Number.isFinite(i) && i >= 0 && i < n;
  return (
    <>
      <label className="objinfo-field" title={t("site.meshPoint.hint", { n })}>
        <span className="objinfo-flabel">{t("site.meshPoint")}</span>
        <input className="objinfo-input" type="number" min={1} max={n} step={1} data-testid="mesh-point-nr" value={nr} onChange={(e) => setNr(e.target.value)} />
        <span className="objinfo-unit" />
      </label>
      <label className="objinfo-field">
        <span className="objinfo-flabel">{t("site.meshPoint.z")}</span>
        <input
          className="objinfo-input"
          type="number"
          step={0.1}
          data-testid="mesh-point-z"
          disabled={!valid}
          value={valid ? obj.positions[3 * i + 2] : ""}
          onChange={(e) => {
            if (valid && e.target.value.trim() !== "") setMeshPointHeight(obj.id, i, Number(e.target.value), `site-${obj.id}-meshZ-${i}`);
          }}
        />
        <span className="objinfo-unit">m</span>
      </label>
      <div className="site-actions">
      <button
        type="button"
        data-testid="mesh-point-delete"
        disabled={!valid || n <= 3}
        title={t("ctx.meshPointDelete.hint")}
        onClick={() => {
          if (valid) deleteMeshPoint(obj.id, i);
        }}
      >
        {t("site.meshPointDelete")}
      </button>
      <button
        type="button"
        data-testid="mesh-crop-parcel"
        disabled={!parcel || parcel.length < 3}
        title={parcel && parcel.length >= 3 ? t("site.meshCrop.hint") : t("site.meshCrop.noParcel")}
        onClick={() => {
          if (parcel && !cropMesh(obj.id, parcel)) notify(t("site.meshCrop.nothing"), "info");
        }}
      >
        {t("site.meshCrop")}
      </button>
      <button type="button" data-testid="mesh-crop-polygon" title={t("site.meshCrop.draw.hint")} onClick={() => host.onRunCommand("meshcrop")}>
        {t("site.meshCrop.draw")}
      </button>
      </div>
    </>
  );
}

/** [193] Höhenversatz (alle Höhen um dz) und, bei Höhenlinien, die Höhe je Linie. */
function HeightFields({ obj }: { obj: ContextObject }) {
  const offsetContextHeight = useStore((s) => s.offsetContextHeight);
  const setContourHeight = useStore((s) => s.setContourHeight);
  const groundContextObjects = useStore((s) => s.groundContextObjects);
  const hasTerrain = useStore((s) => s.project.context?.some((c) => c.type === "terrainMesh") ?? false);
  const notify = useStore((s) => s.notify);
  const [dz, setDz] = useState("");
  if (obj.type === "image") return null;
  const apply = () => {
    if (dz.trim() !== "") offsetContextHeight(obj.id, Number(dz.replace(",", ".")));
    setDz("");
  };
  return (
    <>
      <label className="objinfo-field" title={t("site.heightOffset.hint")}>
        <span className="objinfo-flabel">{t("site.heightOffset")}</span>
        <input
          className="objinfo-input"
          type="text"
          inputMode="decimal"
          data-testid="context-height-offset"
          placeholder="0.00"
          value={dz}
          onChange={(e) => setDz(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          onBlur={apply}
        />
        <span className="objinfo-unit">m</span>
      </label>
      {obj.type === "importedMesh" && (
        // [227] Kontextgebäude auf den tiefsten Geländepunkt unter dem Grundriss setzen.
        <div className="site-actions">
        <button
          type="button"
          data-testid="context-ground"
          disabled={!hasTerrain}
          title={hasTerrain ? t("site.ground.hint") : t("site.ground.noTerrain")}
          onClick={() => {
            if (!groundContextObjects([obj.id])) notify(t("site.ground.nothing"), "info");
          }}
        >
          {t("site.ground")}
        </button>
        </div>
      )}
      {(obj.type === "terrainMesh" || obj.type === "importedMesh") && <MeshPointFields obj={obj} />}
      {obj.type === "contourSet" && (
        <div className="site-contours" data-testid="contour-heights">
          <div className="objinfo-section-label">{t("site.contours", { n: obj.contours.length })}</div>
          {obj.contours.map((c, i) => (
            <label key={i} className="objinfo-field">
              <span className="objinfo-flabel" title={t("site.contour.points", { n: c.pts.length })}>{`${i + 1} · ${t("site.contour.points", { n: c.pts.length })}`}</span>
              <input
                className="objinfo-input"
                type="number"
                step={0.5}
                data-testid={`contour-z-${i}`}
                value={c.z}
                onChange={(e) => {
                  if (e.target.value.trim() !== "") setContourHeight(obj.id, i, Number(e.target.value), `site-${obj.id}-contourZ-${i}`);
                }}
              />
              <span className="objinfo-unit">m</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** Felder eines Kontext-Objekts; `null` für Arten ohne eigene Einstellungen (Höhenlinien, Luftbild). */
export function ContextObjectProps({ obj, quantities }: { obj: ContextObject; quantities: readonly ExcavationQuantity[] }) {
  return (
    <>
      <KindFields obj={obj} quantities={quantities} />
      <div className="site-props">
        <HeightFields obj={obj} />
      </div>
    </>
  );
}

function KindFields({ obj, quantities }: { obj: ContextObject; quantities: readonly ExcavationQuantity[] }) {
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
        <label className="objinfo-field">
          <span className="objinfo-flabel">{t("site.smoothShading")}</span>
          <input
            className="site-check"
            type="checkbox"
            checked={obj.smoothShading === true}
            onChange={(e) => host.onPatchContextObject(obj.id, { smoothShading: e.target.checked }, `site-${obj.id}-smoothShading`)}
          />
        </label>
        {obj.smoothShading === true && (
          <NumField label={t("site.creaseAngle")} unit="°" value={obj.creaseAngle} step={5} min={1} placeholder="30" onChange={patch("creaseAngle")} />
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
          <label className="objinfo-field" title={t("site.terrain.visible.hint", { name: `${cat.code} ${cat.name}` })}>
            <span className="objinfo-flabel">{t("site.terrain.visible")}</span>
            <input className="site-check" type="checkbox" data-testid="terrain-visible" checked={cat.visible} onChange={() => host.onToggleCategory(cat.code)} />
          </label>
        )}
        {hasSource && (
          <label className="objinfo-field" title={t("site.terrain.smooth.hint")}>
            <span className="objinfo-flabel">{t("site.terrain.smooth")}</span>
            <select
              className="objinfo-input"
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
          <label className="objinfo-field" title={isGrid ? t("site.terrain.resmooth.hint") : t("site.terrain.resmooth.unavailable")}>
            <span className="objinfo-flabel">{t("site.terrain.smooth")}</span>
            <select
              className="objinfo-input"
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
        <NumField label={t("site.contourInterval")} unit="m" value={obj.contourInterval} step={0.5} min={0} placeholder="—" onChange={patch("contourInterval")} />
        <NumField label={t("site.contourIndexEvery")} value={obj.contourIndexEvery} step={1} min={1} placeholder="5" onChange={patch("contourIndexEvery")} />
        <NumField label={t("site.earthDepth")} title={t("site.earthDepth.hint")} unit="m" value={obj.earthDepth} step={0.5} min={0.1} placeholder="1.5" onChange={patch("earthDepth")} />
        {/* [212] Material der Oberfläche (Bauteil): Farbe und Bildkarten im 3D, Pathtracer und Blender-Paket. */}
        <label className="objinfo-field" title={t("site.terrain.material.hint")}>
          <span className="objinfo-flabel">{t("site.terrain.material")}</span>
          <select
            className="objinfo-input"
            data-testid="terrain-material"
            value={obj.componentId ?? ""}
            onChange={(e) => host.onPatchContextObject(obj.id, { componentId: e.target.value || undefined })}
          >
            <option value="">{t("site.terrain.material.none")}</option>
            {(project.components ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (obj.type === "excavation") {
    return (
      <div className="site-props">
        <NumField label={t("site.excavation.bottom")} unit="m" value={obj.bottom} step={0.05} onChange={(v) => v !== undefined && patch("bottom")(v)} />
        <NumField label={t("site.excavation.slope")} unit="°" value={obj.slope} step={5} min={5} placeholder="45" onChange={patch("slope")} />
        <NumField label={t("site.excavation.fillSlope")} unit="°" value={obj.fillSlope} step={5} min={5} placeholder="33.7" onChange={patch("fillSlope")} />
        <NumField label={t("site.excavation.bermWidth")} unit="m" value={obj.bermWidth} step={0.25} min={0} placeholder="—" onChange={patch("bermWidth")} />
        <NumField label={t("site.excavation.bermHeight")} unit="m" value={obj.bermHeight} step={0.5} min={0} placeholder="—" onChange={patch("bermHeight")} />
        <NumField label={t("site.excavation.workingSpace")} unit="m" value={obj.workingSpace} step={0.1} min={0} placeholder="0" onChange={patch("workingSpace")} />
        <div className="objinfo-field" title={t("site.excavation.shoringHint")}>
          <span className="objinfo-flabel">{t("site.excavation.shoring")}</span>
          <span className="site-edges">
            {obj.outline.map((_, i) => (
              <label key={i}>
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
            <label className="objinfo-field">
              <span className="objinfo-flabel">{t("site.excavation.shoringKind")}</span>
              <select
                className="objinfo-input"
                data-testid="excavation-shoring-kind"
                value={obj.shoringKind ?? "sheetPile"}
                onChange={(e) => host.onPatchContextObject(obj.id, { shoringKind: e.target.value }, `site-${obj.id}-shoringKind`)}
              >
                <option value="sheetPile">{t("site.excavation.shoringKind.sheetPile")}</option>
                <option value="soldierPile">{t("site.excavation.shoringKind.soldierPile")}</option>
                <option value="borePile">{t("site.excavation.shoringKind.borePile")}</option>
              </select>
            </label>
            <NumField label={t("site.excavation.shoringThickness")} unit="m" value={obj.shoringThickness} step={0.05} min={0.05} placeholder={obj.shoringKind === "borePile" ? "0.6" : obj.shoringKind === "soldierPile" ? "0.3" : "0.2"} onChange={patch("shoringThickness")} />
            <NumField label={t("site.excavation.shoringEmbed")} title={t("site.excavation.shoringEmbed.hint")} unit="m" value={obj.shoringEmbed} step={0.1} min={0} placeholder="1" onChange={patch("shoringEmbed")} />
          </>
        )}
        <ExcavationQty q={quantities.find((x) => x.id === obj.id)} />
      </div>
    );
  }
  return null;
}
