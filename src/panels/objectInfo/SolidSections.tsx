// Abschnitte „Extrudierter Körper" und „Stütze" der Attribute ([165] aus `ObjectInfoPanel.tsx`), dazu die
// Kennwert-Zeilen des Körpers (truck). Gerufen von `AttributesPanel`.

import type { SolidSpec, SolidProps } from "../../engine/truckSolid";
import { useState, useEffect } from "react";
import { solidProps } from "../../engine/truckSolid";
import { t } from "../../i18n";
import type { ExtrudedSolidInfo, ColumnInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { Dropdown } from "../../ui/Dropdown";
import { DimensionField } from "./fields";

/** Volumen/Oberfläche/Schwerpunkt aus truck (asynchron, aus dem tessellierten B-Rep). */
function SolidPropsRows({ spec }: { spec: SolidSpec | null }) {
  const [props, setProps] = useState<SolidProps | null>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    let alive = true;
    setProps(null);
    if (!spec) return;
    solidProps(spec).then(
      (p) => alive && setProps(p),
      () => alive && setProps(null),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
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


// ── Extrusions-Attribut-Abschnitt (truck-Integration) ───────────────────────
// Höhe editierbar (löst Re-Extrusion aus); Grundfläche + Geschoss read-only.
export function ExtrudedSolidSection({
  solid,
  host,
}: {
  solid: ExtrudedSolidInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.extrudedSolid.section")}</div>

      {/* Höhe (editierbar, > 0) — löst eine Re-Extrusion (truck-WASM) aus. */}
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
      </div>

      <SolidPropsRows spec={solid.spec} />

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

      {/* Verjüngung (editierbar, 0..1) — löst eine Re-Extrusion (truck-WASM) aus. */}
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
