// Abschnitte „Extrudierter Körper" und „Stütze" der Attribute ([165] aus `ObjectInfoPanel.tsx`), dazu die
// Kennwert-Zeilen des Körpers (Kern-Netz, [115]). Gerufen von `AttributesPanel`.

import { t } from "../../i18n";
import type { ExtrudedSolidInfo, ColumnInfo, SolidProps } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { useStore } from "../../state/appStore";
import { Dropdown } from "../../ui/Dropdown";
import { selectionColumnValues, selectionSolidValues } from "../../state/mixedValues";
import { DimensionField, MixedMark } from "./fields";
import { useMulti } from "./useMulti";

/** Volumen/Oberfläche/Schwerpunkt aus dem Kern-Netz des Körpers (Manifold, dasselbe Netz wie im 3D). */
function SolidPropsRows({ props }: { props: SolidProps | null }) {
  if (!props) return null;
  const f = (v: number, d = 2) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return (
    <>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.volume")}</span>
        <span className="objinfo-fval">{f(props.volume)} m³</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.surface")}</span>
        <span className="objinfo-fval">{f(props.area)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.centroid")}</span>
        <span className="objinfo-fval">
          {f(props.centroid[0])} / {f(props.centroid[1])} / {f(props.centroid[2])}
        </span>
      </div>
      {!props.closed && <div className="objinfo-field objinfo-warn">{t("objinfo.extrudedSolid.notClosed")}</div>}
    </>
  );
}


// ── Extrusions-Attribut-Abschnitt ───────────────────────────────────────────
// Höhe editierbar (löst Re-Extrusion aus); Grundfläche + Geschoss read-only.
export function ExtrudedSolidSection({
  solid,
  host,
}: {
  solid: ExtrudedSolidInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const components = useStore((st) => st.project.components);
  // [195b] Mehrfachauswahl: Höhe und die übrigen Setter gelten für alle gewählten Körper.
  const multi = useMulti("solids", selectionSolidValues);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.extrudedSolid.section")}</div>

      {/* Höhe (editierbar, > 0) — baut das Kern-Netz neu. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.height")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.01}
          min={0.01}
          value={solid.height}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) host.onSetExtrudedSolidHeight(v);
          }}
          title={t("objinfo.extrudedSolid.height")}
        />
        <MixedMark on={multi?.height.mixed} what="height" />
      </div>

      <SolidPropsRows props={solid.props} />

      {/* Abstand über Geschoss-UK (Brüstungs-/Durchbruchshöhe). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.baseOffset")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.05}
          value={solid.baseOffset}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetExtrudedSolidBaseOffset(v);
          }}
          title={t("objinfo.extrudedSolid.baseOffset")}
        />
      </div>

      {/* [G1] Bauteil: Füllung und SIA-Schraffur der Schnittfläche in Grundriss und Schnitt. */}
      {!solid.subtract && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.component")}</span>
          <Dropdown
            value={solid.componentId}
            onChange={(v) => host.onSetExtrudedSolidComponent(v)}
            options={[
              { value: "", label: t("objinfo.extrudedSolid.component.none") },
              ...components.map((c) => ({ value: c.id, label: c.name })),
            ]}
            title={t("objinfo.extrudedSolid.componentHint")}
            width={130}
          />
        </div>
      )}

      {/* Abzugskörper: zieht sich von Wänden/Decken/Stützen ab (Grundriss, Schnitt, 3D, STEP). */}
      {solid.canSubtract && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.subtract")}</span>
          <input
            type="checkbox"
            checked={solid.subtract}
            onChange={(e) => host.onSetExtrudedSolidSubtract(e.target.checked)}
            title={t("objinfo.extrudedSolid.subtractHint")}
          />
        </div>
      )}

      {solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.brep")}</span>
          <span className="objinfo-fval">{solid.brepLabel}</span>
        </div>
      )}

      {/* Eckenradius (editierbar, ≥ 0): echte Kreisbögen an den Ecken der Aussenkontur. */}
      {!solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.cornerRadius")}</span>
          <input
            type="number"
            className="objinfo-text"
            step={0.05}
            min={0}
            value={solid.cornerRadius}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) host.onSetExtrudedSolidCornerRadius(v);
            }}
            title={t("objinfo.extrudedSolid.cornerRadius")}
          />
        </div>
      )}

      {/* Fase (editierbar, ≥ 0): gerade Abschrägung der Ecken der Aussenkontur. */}
      {!solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.chamfer")}</span>
          <input
            type="number"
            className="objinfo-text"
            step={0.05}
            min={0}
            value={solid.chamfer}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) host.onSetExtrudedSolidChamfer(v);
            }}
            title={t("objinfo.extrudedSolid.chamfer")}
          />
        </div>
      )}

      {/* Verjüngung (editierbar, 0..1) — baut das Kern-Netz neu. */}
      {!solid.brepLabel && (
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.taper")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.05}
          min={0}
          max={1}
          value={solid.taper}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetExtrudedSolidTaper(v);
          }}
          title={t("objinfo.extrudedSolid.taper")}
        />
      </div>
      )}

      {/* Grundfläche (read-only, abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.area")}</span>
        <span className="objinfo-fval">{solid.area.toFixed(2)} m²</span>
      </div>

      {/* Geschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.floor")}</span>
        <span className="objinfo-fval">{solid.floorName}</span>
      </div>
    </>
  );
}


// ── Stützen-Attribut-Abschnitt (Tragwerk) ───────────────────────────────────
// Profil (Rechteck/Kreis) + Masse, Höhe, Drehung editierbar; Geschoss + UK/OK
// read-only.
export function ColumnSection({
  column,
  host,
}: {
  column: ColumnInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  // [195b] Mehrfachauswahl: Profil, Masse, Höhe und Drehung gelten für alle gewählten Stützen.
  const multi = useMulti("columns", selectionColumnValues);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.column.section")}</div>

      {/* Profil-Dropdown (Rechteck/Kreis). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.profile")}</span>
        <Dropdown
          value={column.profile.kind}
          onChange={(v) => host.onSetColumnProfileKind(v as "rect" | "round")}
          options={[
            { value: "rect", label: t("objinfo.column.profile.rect") },
            { value: "round", label: t("objinfo.column.profile.round") },
          ]}
          title={t("objinfo.column.profile")}
          width={130}
        />
      </div>

      {/* Editierbare Masse je Profil. */}
      {column.profile.kind === "round" ? (
        <DimensionField
          label={t("objinfo.column.radius")}
          value={column.profile.radius}
          onCommit={(v) => host.onSetColumnRadius(v)}
        />
      ) : (
        <>
          <DimensionField
            label={t("objinfo.column.width")}
            value={column.profile.kind === "rect" ? column.profile.width : 0}
            onCommit={(v) => host.onSetColumnWidth(v)}
          />
          <DimensionField
            label={t("objinfo.column.depth")}
            value={column.profile.kind === "rect" ? column.profile.depth : 0}
            onCommit={(v) => host.onSetColumnDepth(v)}
          />
        </>
      )}

      <DimensionField
        label={t("objinfo.column.height")}
        value={column.height}
        onCommit={(v) => host.onSetColumnHeight(v)}
      />
      <MixedMark on={multi?.height.mixed} what="height" />

      {/* Drehung (Grad). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.rotation")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={1}
          value={Number(column.rotationDeg.toFixed(1))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetColumnRotation(v);
          }}
          title={t("objinfo.column.rotation")}
        />
      </div>

      {/* Geschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.floor")}</span>
        <span className="objinfo-fval">{column.floorName}</span>
      </div>
    </>
  );
}
