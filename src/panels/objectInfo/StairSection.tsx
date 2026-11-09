// Abschnitt „Treppe" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Treppenform und Läufe.
// Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import type { StairInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import type { StairShape } from "../../model/types";
import { formatM } from "../../model/types";
import { DimensionField } from "./fields";

/**
 * [151] Läufe und Podest einer Podesttreppe (L, U, gerade mit Podest): Lauflängen, Steigungen im ersten
 * Lauf, Drehsinn (L/U), Treppenauge, Mittellauf und Versatz (U), Podesttiefe (U, gerade mit Podest).
 */
function StairFlightFields({ stair, host }: { stair: StairInfo; host: ReturnType<typeof usePanelHost> }) {
  const isU = stair.shape === "U";
  const turn = stair.turn ?? 1;
  return (
    <>
      <DimensionField
        label={t("objinfo.stair.run1")}
        value={stair.runLength ?? 0}
        onCommit={(v) => v > 0.1 && host.onSetStairPatch({ runLength: v })}
      />
      <DimensionField
        label={t("objinfo.stair.run2")}
        value={stair.run2Length ?? stair.runLength ?? 0}
        onCommit={(v) => v > 0.1 && host.onSetStairPatch({ run2Length: v })}
      />
      <DimensionField
        label={t("objinfo.stair.run1Steps")}
        unit="" step={1} digits={0} value={stair.run1Steps ?? 0}
        onCommit={(v) => host.onSetStairPatch({ run1Steps: v >= 1 ? Math.round(v) : undefined })}
      />
      {stair.shape !== "straightLanding" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.stair.turn")}</span>
          <div className="objinfo-segment">
            <button
              type="button"
              className={"objinfo-seg-btn" + (turn > 0 ? " active" : "")}
              onClick={() => host.onSetStairPatch({ turn: 1 })}
            >
              {t("objinfo.stair.turn.left")}
            </button>
            <button
              type="button"
              className={"objinfo-seg-btn" + (turn < 0 ? " active" : "")}
              onClick={() => host.onSetStairPatch({ turn: -1 })}
            >
              {t("objinfo.stair.turn.right")}
            </button>
          </div>
        </div>
      )}
      {stair.shape !== "L" && (
        <DimensionField
          label={t("objinfo.stair.landing")}
          value={stair.landingLength ?? stair.width}
          onCommit={(v) => v > 0.1 && host.onSetStairPatch({ landingLength: v })}
        />
      )}
      {isU && (
        <>
          <DimensionField
            label={t("objinfo.stair.gap")}
            value={stair.gap ?? 0.1}
            onCommit={(v) => v >= 0 && host.onSetStairPatch({ gap: v })}
          />
          <DimensionField
            label={t("objinfo.stair.midSteps")}
            unit="" step={1} digits={0} value={stair.midSteps ?? 0}
            onCommit={(v) => host.onSetStairPatch({ midSteps: v >= 1 ? Math.round(v) : undefined })}
          />
          {(stair.midSteps ?? 0) >= 1 && (
            <DimensionField
              label={t("objinfo.stair.midOffset")}
              min={-10} value={stair.midOffset ?? 0}
              onCommit={(v) => host.onSetStairPatch({ midOffset: v !== 0 ? v : undefined })}
            />
          )}
          <DimensionField
            label={t("objinfo.stair.run2Offset")}
            min={-10} value={stair.run2Offset ?? 0}
            onCommit={(v) => host.onSetStairPatch({ run2Offset: v !== 0 ? v : undefined })}
          />
        </>
      )}
    </>
  );
}


export function StairSection({
  stair,
  host,
}: {
  stair: StairInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.stair.section")}</div>

      {/* Treppentyp (Bibliothek) — treibt u. a. die 3D-Tragart (massiv/offen). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.type")}</span>
        <Dropdown
          value={stair.typeId ?? ""}
          onChange={(v) => host.onSetStairType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(storeProject.stairTypes ?? []).map((st) => ({
              value: st.id,
              label: st.name,
            })),
          ]}
          title={t("objinfo.stair.type")}
          width={130}
        />
      </div>

      {/* Grundform-Dropdown. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.shape")}</span>
        <Dropdown
          value={stair.shape}
          onChange={(v) => host.onSetStairShape(v as StairShape)}
          options={[
            { value: "straight", label: t("objinfo.stair.shape.straight") },
            { value: "L", label: t("objinfo.stair.shape.L") },
            { value: "U", label: t("objinfo.stair.shape.U") },
            { value: "straightLanding", label: t("objinfo.stair.shape.straightLanding") },
            { value: "spiral", label: t("objinfo.stair.shape.spiral") },
          ]}
          title={t("objinfo.stair.shape")}
          width={130}
        />
      </div>

      {/* Referenzpunkt der Laufbreite (links/mitte/rechts). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.referenz")}</span>
        <Dropdown
          value={stair.referenz ?? "mitte"}
          onChange={(v) => host.onSetStairReferenz(v as "links" | "mitte" | "rechts")}
          options={[
            { value: "links", label: t("objinfo.stair.referenz.links") },
            { value: "mitte", label: t("objinfo.stair.referenz.mitte") },
            { value: "rechts", label: t("objinfo.stair.referenz.rechts") },
          ]}
          title={t("objinfo.stair.referenz")}
          width={130}
        />
      </div>

      {/* Laufrichtung (aufwärts/abwärts). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.direction")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (stair.up ? " active" : "")}
            onClick={() => host.onSetStairUp(true)}
          >
            {t("objinfo.stair.direction.up")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (!stair.up ? " active" : "")}
            onClick={() => host.onSetStairUp(false)}
          >
            {t("objinfo.stair.direction.down")}
          </button>
        </div>
      </div>

      {/* Pfeil-Darstellung (offener Winkel- oder gefüllter SIA-Vollpfeil). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.arrow")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + ((stair.arrowStyle ?? "line") === "line" ? " active" : "")}
            onClick={() => host.onSetStairArrowStyle("line")}
          >
            {t("objinfo.stair.arrow.line")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (stair.arrowStyle === "filled" ? " active" : "")}
            onClick={() => host.onSetStairArrowStyle("filled")}
          >
            {t("objinfo.stair.arrow.filled")}
          </button>
        </div>
      </div>

      {/* Editierbare Maße. */}
      <DimensionField
        label={t("objinfo.stair.width")}
        value={stair.width}
        onCommit={(v) => host.onSetStairWidth(v)}
      />
      {stair.shape === "spiral" && (
        <DimensionField
          label={t("objinfo.stair.column")}
          value={stair.centerColumn ?? 0}
          onCommit={(v) => host.onSetStairColumn(v)}
        />
      )}
      {stair.shape !== "spiral" && stair.shape !== "straight" && <StairFlightFields stair={stair} host={host} />}
      <DimensionField
        label={t("objinfo.stair.steps")}
        value={stair.stepCount}
        onCommit={(v) => host.onSetStairSteps(v)}
      />
      <DimensionField
        label={t("objinfo.stair.rise")}
        value={stair.totalRise}
        onCommit={(v) => host.onSetStairRise(v)}
      />

      {/* Abgeleitete Werte (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.riser")}</span>
        <span className="objinfo-fval">{formatM(stair.riserHeight)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.tread")}</span>
        <span className="objinfo-fval">{formatM(stair.treadDepth)}</span>
      </div>
      {stair.concreteVolume !== undefined && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.stair.concreteVolume")}</span>
          <span className="objinfo-fval">{stair.concreteVolume.toFixed(2)} m³</span>
        </div>
      )}
      {stair.soffitArea !== undefined && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.stair.soffitArea")}</span>
          <span className="objinfo-fval">{stair.soffitArea.toFixed(2)} m²</span>
        </div>
      )}

      {/* Referenzgeschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.refFloor")}</span>
        <span className="objinfo-fval">{stair.floorName}</span>
      </div>

      <div className="objinfo-sep" />

      {/* UK/OK (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.bottom")}</span>
        <span className="objinfo-fval">{formatM(stair.zBottom)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.top")}</span>
        <span className="objinfo-fval">{formatM(stair.zTop)}</span>
      </div>
    </>
  );
}
