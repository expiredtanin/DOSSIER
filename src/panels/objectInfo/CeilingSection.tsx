// Abschnitt „Decke" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Aufbau, Höhenlage, Öffnungen.
// Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import type { CeilingInfo } from "../../state/selectionInfo";
import type { CeilingSlope } from "../../model/types";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import { UValueRow } from "../UValueRow";
import { formatM } from "../../model/types";
import { selectionCeilingValues } from "../../state/mixedValues";
import { BuildingFlags, DimensionField, MixedMark, VerticalAnchorRow } from "./fields";
import { useMulti } from "./useMulti";

export function CeilingSection({
  ceiling,
  host,
}: {
  ceiling: CeilingInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  // [195b] Mehrfachauswahl: abweichende Werte als „gemischt" kennzeichnen.
  const multi = useMulti("ceilings", selectionCeilingValues);
  const isSingle = ceiling.singleLayer;
  const multiPresets = ceiling.ceilingTypes.filter((ct) => ct.layerCount > 1);

  function chooseSingle() {
    if (isSingle) return;
    host.onSetCeilingThickness(ceiling.thickness);
  }
  function chooseMulti() {
    if (!isSingle) return;
    const first = multiPresets[0];
    if (first) host.onSetCeilingType(first.id);
  }

  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.ceiling.section")}</div>
      <BuildingFlags isExternal={ceiling.isExternal} loadBearing={ceiling.loadBearing} host={host} />

      {/* Aufbau-Typ-Segment. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.buildup")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (isSingle ? " active" : "")}
            onClick={chooseSingle}
          >
            {t("objinfo.wall.single")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (!isSingle ? " active" : "")}
            onClick={chooseMulti}
            disabled={isSingle && multiPresets.length === 0}
          >
            {t("objinfo.wall.multi")}
          </button>
        </div>
      </div>

      {/* Einschichtig → Dicke-Zahlfeld. Mehrschichtig → Preset-Dropdown. */}
      {isSingle ? (
        <>
          <DimensionField
            label={t("objinfo.ceiling.thickness")}
            value={ceiling.thickness}
            onCommit={(v) => host.onSetCeilingThickness(v)}
          />
          <MixedMark on={multi?.thickness.mixed} what="thickness" />
        </>
      ) : (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.ceiling.preset")}</span>
          <Dropdown
            value={ceiling.typeId}
            onChange={(id) => host.onSetCeilingType(id)}
            options={ceiling.ceilingTypes.map((ct) => ({
              value: ct.id,
              label: ct.label,
              title: ct.name,
            }))}
            title={t("objinfo.ceiling.preset")}
            width={150}
          />
          <MixedMark on={multi?.typeId.mixed} what="ceilingType" />
        </div>
      )}

      {/* Referenzgeschoss (read-only Anzeige). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.refFloor")}</span>
        <span className="objinfo-fval">{ceiling.floorName}</span>
      </div>
      <UValueRow project={storeProject} kind="ceiling" typeId={ceiling.typeId} />

      {/* [178] Deckenrand an Aussenwänden: Auflager bis Aussenkante Kern (Standard) oder wie Umriss. */}
      <div className="objinfo-field" title={t("objinfo.ceiling.bearingCoreHint")}>
        <span className="objinfo-flabel">{t("objinfo.ceiling.bearingCore")}</span>
        <input
          type="checkbox"
          data-testid="objinfo-ceiling-bearingCore"
          checked={!ceiling.edgeAtOutline}
          onChange={(e) => host.onSetCeilingEdgeAtOutline?.(!e.target.checked)}
        />
      </div>

      {/* Fläche + Volumen (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.area")}</span>
        <span className="objinfo-fval">{ceiling.area.toFixed(2)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.volume")}</span>
        <span className="objinfo-fval">{ceiling.volume.toFixed(2)} m³</span>
      </div>

      {/* Aussparungen (Treppenauge/Schacht) — Liste mit Entfernen je Loch.
          Anlegen über den Befehl „Deckenloch" (BIM-Ribbon). */}
      {ceiling.openings.length > 0 && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.ceiling.openings")}</span>
            <span className="objinfo-fval">{ceiling.openings.length}</span>
          </div>
          {ceiling.openings.map((o, i) => (
            <div className="objinfo-field" key={i}>
              <span className="objinfo-flabel objinfo-muted">
                {`${i + 1}: ${o.width.toFixed(2)} × ${o.depth.toFixed(2)} m`}
              </span>
              <button
                type="button"
                className="objinfo-typebtn"
                title={t("objinfo.ceiling.removeOpening")}
                aria-label={t("objinfo.ceiling.removeOpening")}
                onClick={() => host.onRemoveCeilingOpening(i)}
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="objinfo-sep" />

      {/* OK der Decke: an Geschoss gebunden ODER eigene Höhe. */}
      <VerticalAnchorRow
        label={t("objinfo.ceiling.top")}
        anchor={ceiling.top}
        defaultZ={ceiling.zTop}
        floors={ceiling.floors}
        defaultFloorId={ceiling.floorId}
        onChange={(a) => host.onSetCeilingTop(a)}
      />
      <MixedMark on={multi?.top.mixed} what="top" />

      {/* UK der Decke: an Geschoss gebunden ODER eigene Höhe; ohne Override
          bleibt es beim heutigen Verhalten UK = OK − Dicke. */}
      <VerticalAnchorRow
        label={t("objinfo.ceiling.bottom")}
        anchor={ceiling.bottom}
        defaultZ={ceiling.zBottom}
        floors={ceiling.floors}
        defaultFloorId={ceiling.floorId}
        onChange={(a) => host.onSetCeilingBottom?.(a)}
      />
      <MixedMark on={multi?.bottom.mixed} what="bottom" />
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.height")}</span>
        <span className="objinfo-fval">{formatM(ceiling.zTop - ceiling.zBottom)}</span>
      </div>
      <SlopeRows ceiling={ceiling} host={host} />
    </>
  );
}

const DEG = Math.PI / 180;

/**
 * [281] Abschnitt „Neigung": aus / Gefälle / Rampe; Gefälle in % und Grad, Höhenunterschied, Richtung (aufwärts) und
 * Bezugspunkt. Gespeichert wird nur `slope` ({from, to, rise, ramp}); die Felder rechnen daraus um.
 */
function SlopeRows({ ceiling, host }: { ceiling: CeilingInfo; host: ReturnType<typeof usePanelHost> }) {
  const s = ceiling.slope;
  const mode: "off" | "on" | "ramp" = !s ? "off" : s.ramp ? "ramp" : "on";
  const len = s ? Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) : 0;
  const pct = s && len > 1e-9 ? (s.rise / len) * 100 : 0;
  // Richtung aufwärts: von `from` nach `to`, bei negativem Höhenunterschied umgekehrt.
  const dirDeg = s ? (((Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x) / DEG + (s.rise < 0 ? 180 : 0)) % 360) + 360) % 360 : 0;
  const set = (patch: Partial<CeilingSlope>) => {
    if (s) host.onSetCeilingSlope?.({ ...s, ...patch });
  };
  const setRise = (rise: number) => {
    if (isFinite(rise) && rise !== 0) set({ rise });
  };
  const choose = (m: "off" | "on" | "ramp") => {
    if (m === mode) return;
    if (m === "off") host.onSetCeilingSlope?.(null);
    else host.onSetCeilingSlope?.({ enable: m === "ramp" ? "ramp" : "slope" });
  };
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label" title={t("objinfo.ceiling.slope.hint")}>
        {t("objinfo.ceiling.slope.section")}
      </div>
      <div className="objinfo-field">
        <div className="objinfo-segment" data-testid="objinfo-ceiling-slope-mode">
          {(["off", "on", "ramp"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`objinfo-ceiling-slope-${m}`}
              className={"objinfo-seg-btn" + (mode === m ? " active" : "")}
              onClick={() => choose(m)}
            >
              {t(`objinfo.ceiling.slope.${m}`)}
            </button>
          ))}
        </div>
      </div>
      {s && (
        <>
          <div data-testid="objinfo-ceiling-slope-percent">
            <DimensionField
              label={t("objinfo.ceiling.slope.percent")}
              value={Math.abs(pct)}
              unit="%"
              digits={1}
              step={0.5}
              min={0}
              onCommit={(v) => setRise(Math.sign(s.rise || 1) * (v / 100) * len)}
            />
          </div>
          <DimensionField
            label={t("objinfo.ceiling.slope.angle")}
            value={Math.atan(Math.abs(pct) / 100) / DEG}
            unit="°"
            digits={2}
            step={0.5}
            min={0}
            onCommit={(v) => v < 89 && setRise(Math.sign(s.rise || 1) * Math.tan(v * DEG) * len)}
          />
          <DimensionField
            label={t("objinfo.ceiling.slope.rise")}
            value={Math.abs(s.rise)}
            min={0}
            onCommit={(v) => setRise(Math.sign(s.rise || 1) * v)}
          />
          <DimensionField
            label={t("objinfo.ceiling.slope.direction")}
            value={dirDeg}
            unit="°"
            digits={1}
            min={-360}
            onCommit={(a) => {
              // Gefällelinie dreht um den Bezugspunkt; aufwärts = Richtung, der Höhenunterschied wird positiv.
              const r = a * DEG;
              set({ to: { x: s.from.x + Math.cos(r) * len, y: s.from.y + Math.sin(r) * len }, rise: Math.abs(s.rise) });
            }}
          />
          <DimensionField
            label={t("objinfo.ceiling.slope.refX")}
            value={s.from.x}
            min={-Infinity}
            onCommit={(x) => set({ from: { x, y: s.from.y }, to: { x: s.to.x + x - s.from.x, y: s.to.y } })}
          />
          <DimensionField
            label={t("objinfo.ceiling.slope.refY")}
            value={s.from.y}
            min={-Infinity}
            onCommit={(y) => set({ from: { x: s.from.x, y }, to: { x: s.to.x, y: s.to.y + y - s.from.y } })}
          />
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.ceiling.slope.length")}</span>
            <span className="objinfo-fval">{formatM(len)}</span>
          </div>
        </>
      )}
    </>
  );
}
