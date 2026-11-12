// Abschnitt „Wand" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Referenzlinie, Aufbau, Geschoss, Unter-
// und Oberkante. Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import { selectionWallHeights, selectionWallValues } from "../../state/mixedValues";
import type { WallInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import type { WallReferenceLine, SliceTermination } from "../../model/types";
import { UValueRow } from "../UValueRow";
import { formatM } from "../../model/types";
import { BuildingFlags, DimensionField, MixedMark, VerticalAnchorRow } from "./fields";
import { useMulti } from "./useMulti";

// ── Wand-Attribut-Abschnitt ──────────────────────────────────────────────────
// Aufbau-Typ (einschichtig/mehrschichtig), Dicke/Preset, Referenzgeschoss +
// Oberverknüpfung, UK/OK je Modus-Umschalter. Alle Werte/Setter über den Host.
export function WallSection({
  wall,
  host,
}: {
  wall: WallInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  // [195b] Mehrfachauswahl: abweichender Typ/Dicke/Höhe als „gemischt" kennzeichnen.
  const multi = useMulti("walls", selectionWallValues);
  const heights = useMulti("walls", selectionWallHeights);
  const mixedMark = (on: boolean | undefined, what: string) => <MixedMark on={on} what={what} />;
  // Aufbau-Typ-Segment: einschichtig vs. mehrschichtig. Aus dem Modell
  // abgeleitet (singleLayer); der Umschalter auf „mehrschichtig" wählt einen
  // mehrschichtigen Wandtyp-Preset (erster mit >1 Schicht), auf „einschichtig"
  // setzt er die Dicke des aktuellen Aufbaus als einschichtige Wand.
  const isSingle = wall.singleLayer;

  const multiPresets = wall.wallTypes.filter((wt) => wt.layerCount > 1);

  function chooseSingle() {
    if (isSingle) return;
    // Auf einschichtig wechseln: aktuelle Gesamtdicke als Einzelschicht setzen.
    host.onSetWallThickness(wall.thickness);
  }
  function chooseMulti() {
    if (!isSingle) return;
    const first = multiPresets[0];
    if (first) host.onSetWallType(first.id);
  }

  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.wall.section")}</div>

      {/* Referenzlinie (wo die Achse über die Dicke liegt) — außen/mitte/innen ODER
          bei mehrschichtigen Wänden eine SCHICHTTRENNLINIE (Fuge). Ein Fugenwert
          wird als "off:<offset>" kodiert und übersteuert die benannte Linie. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.refLine")}</span>
        <Dropdown
          value={
            wall.referenceOffset != null
              ? `off:${wall.referenceOffset.toFixed(4)}`
              : wall.referenceLine
          }
          onChange={(v) => {
            if (v.startsWith("off:")) host.onSetWallReferenceOffset(Number(v.slice(4)));
            else host.onSetWallReferenceLine(v as WallReferenceLine);
          }}
          options={[
            { value: "left", label: t("objinfo.wall.refLine.left") },
            { value: "center", label: t("objinfo.wall.refLine.center") },
            { value: "right", label: t("objinfo.wall.refLine.right") },
            ...wall.layerBoundaries.map((b) => ({
              value: `off:${b.offset.toFixed(4)}`,
              label: `${t("objinfo.wall.refLine.joint")} ${b.label}`,
            })),
          ]}
          title={t("objinfo.wall.refLine")}
          width={120}
        />
        {mixedMark(multi?.referenceLine.mixed, "referenceLine")}
      </div>

      {/* Terminierung am Deckenanschluss (Zuschnitt, NICHT Priorität): ob die Wand
          an der Decke endet oder oberhalb wieder auftaucht. Default "both". */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.sliceTermination")}</span>
        <Dropdown
          value={wall.sliceTermination}
          onChange={(v) => host.onSetWallSliceTermination(v as SliceTermination)}
          options={[
            { value: "both", label: t("objinfo.wall.sliceTermination.both") },
            { value: "below", label: t("objinfo.wall.sliceTermination.below") },
            { value: "above", label: t("objinfo.wall.sliceTermination.above") },
          ]}
          title={t("objinfo.wall.sliceTermination")}
          width={120}
        />
      </div>

      {/* An Dach anschliessen ([G2]): automatisch endet die Wand an der Dach-Unterkante, "Ja"
          verlängert sie bis unter das Dach, "Nein" lässt die Dächer die Wand nicht schneiden. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.roofAttach")}</span>
        <Dropdown
          value={wall.roofAttach}
          onChange={(v) => host.onSetWallRoofAttach(v as "auto" | "on" | "off")}
          options={[
            { value: "auto", label: t("objinfo.wall.roofAttach.auto") },
            { value: "on", label: t("objinfo.wall.roofAttach.on") },
            { value: "off", label: t("objinfo.wall.roofAttach.off") },
          ]}
          title={t("objinfo.wall.roofAttach.tip")}
          width={120}
        />
      </div>
      <BuildingFlags isExternal={wall.isExternal} loadBearing={wall.loadBearing} host={host} />

      {/* Aufbau-Typ-Segment. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.buildup")}</span>
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
            label={t("objinfo.wall.thickness")}
            value={wall.thickness}
            onCommit={(v) => host.onSetWallThickness(v)}
          />
          {mixedMark(multi?.thickness.mixed, "thickness")}
        </>
      ) : (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.wall.preset")}</span>
          <Dropdown
            value={wall.wallTypeId}
            onChange={(id) => host.onSetWallType(id)}
            options={wall.wallTypes.map((wt) => ({
              value: wt.id,
              label: wt.label,
              title: wt.name,
            }))}
            title={t("objinfo.wall.preset")}
            width={150}
          />
          {mixedMark(multi?.wallTypeId.mixed, "wallType")}
        </div>
      )}

      {/* Referenzgeschoss (read-only Anzeige). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.refFloor")}</span>
        <span className="objinfo-fval">{wall.floorName}</span>
      </div>
      <UValueRow project={storeProject} kind="wall" typeId={wall.wallTypeId} />

      {/* Länge + Volumen (read-only). Volumen ist NETTO — Fenster/Türen
          abgezogen; der Titel zeigt zusätzlich das Bruttovolumen. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.length")}</span>
        <span className="objinfo-fval">{formatM(wall.length)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.volume")}</span>
        <span
          className="objinfo-fval"
          title={
            wall.openingVolume > 0
              ? `${t("objinfo.wall.volumeGross")}: ${wall.grossVolume.toFixed(2)} m³ − ${wall.openingVolume.toFixed(2)} m³`
              : undefined
          }
        >
          {wall.netVolume.toFixed(2)} m³
        </span>
      </div>

      {/* Verknüpfung zum oberen Geschoss: OK an nächstes Geschoss binden. */}
      <label className="objinfo-field objinfo-check-field">
        <span className="objinfo-flabel">{t("objinfo.wall.linkAbove")}</span>
        <input
          type="checkbox"
          className="objinfo-check"
          checked={wall.top?.mode === "floor"}
          disabled={!wall.floorAbove}
          title={
            wall.floorAbove
              ? wall.floorAbove.name
              : t("objinfo.wall.floorAboveNone")
          }
          onChange={(e) => {
            if (e.target.checked && wall.floorAbove) {
              host.onSetWallTop({ mode: "floor", floorId: wall.floorAbove.id });
            } else {
              host.onSetWallTop(null);
            }
          }}
        />
      </label>

      <div className="objinfo-sep" />

      {/* OK & UK getrennt: je „an Geschoss gebunden" ODER „eigene Höhe". OK
          (oben) steht oben, UK (unten) darunter — räumlich passend (Nutzer). */}
      <VerticalAnchorRow
        label={t("objinfo.wall.top")}
        anchor={wall.top}
        defaultZ={wall.zTop}
        floors={wall.floors}
        defaultFloorId={wall.floorAbove?.id ?? wall.floorId}
        onChange={(a) => host.onSetWallTop(a)}
      />
      {mixedMark(heights?.top.mixed, "top")}
      <VerticalAnchorRow
        label={t("objinfo.wall.bottom")}
        anchor={wall.bottom}
        defaultZ={wall.zBottom}
        floors={wall.floors}
        defaultFloorId={wall.floorId}
        onChange={(a) => host.onSetWallBottom(a)}
      />
      {mixedMark(heights?.bottom.mixed, "bottom")}

      {/* Höhe = OK − UK (abgeleitet, read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.height")}</span>
        <span className="objinfo-fval">{formatM(wall.zTop - wall.zBottom)}</span>
      </div>
    </>
  );
}
