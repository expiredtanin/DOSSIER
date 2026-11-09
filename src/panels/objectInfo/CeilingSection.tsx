// Abschnitt „Decke" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Aufbau, Höhenlage, Öffnungen.
// Gerufen von `AttributesPanel`.

import type { CeilingInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import { UValueRow } from "../UValueRow";
import { formatM } from "../../model/types";
import { BuildingFlags, DimensionField, VerticalAnchorRow } from "./fields";

export function CeilingSection({
  ceiling,
  host,
}: {
  ceiling: CeilingInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
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
        <DimensionField
          label={t("objinfo.ceiling.thickness")}
          value={ceiling.thickness}
          onCommit={(v) => host.onSetCeilingThickness(v)}
        />
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
        </div>
      )}

      {/* Referenzgeschoss (read-only Anzeige). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.refFloor")}</span>
        <span className="objinfo-fval">{ceiling.floorName}</span>
      </div>
      <UValueRow project={host.project} kind="ceiling" typeId={ceiling.typeId} />

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
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.height")}</span>
        <span className="objinfo-fval">{formatM(ceiling.zTop - ceiling.zBottom)}</span>
      </div>
    </>
  );
}
