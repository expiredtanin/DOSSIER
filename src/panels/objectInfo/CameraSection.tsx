// Abschnitt „Kamera" der Objekt-Info ([213]): Standpunkt und Augenhöhe, Ziel, Bildwinkel/Brennweite, Projektion,
// Sonnenstand und die Aktionen „Kamera öffnen" / „Aus aktueller Ansicht" / „Isometrisch". Jede Änderung ein Undo-Schritt
// (der Kern prüft die Op); bei mehreren gewählten Kameras wirken die Auswahlfelder auf alle.

import type { Camera, CameraProjection } from "../../model/types";
import { useStore } from "../../state/appStore";
import { openCamera, updateCameraFromView } from "../../state/cameraActions";
import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { patchItem } from "../../core";
import { Dropdown } from "../../ui/Dropdown";
import { clampFov, focalFromFov, fovFromFocal, isometricAim } from "../../viewport/cameraView";
import { DimensionField } from "./fields";

const PROJECTIONS: CameraProjection[] = ["perspective", "axonometric", "parallel"];

/** ISO-UTC-Text → Wert für `<input type="datetime-local">` (UTC-Anzeige, ohne Zeitzonen-Überraschung). */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16) : "";
}

export function CameraSection({ ids }: { ids: readonly string[] }) {
  const project = useStore((st) => st.project);
  const applyChange = useStore((s) => s.applyChange);
  const cams = (project.cameras ?? []).filter((x) => ids.includes(x.id));
  const cam = cams[0];
  if (!cam) return <div className="objinfo-panel"><div className="objinfo-empty">{t("objinfo.empty")}</div></div>;
  const locked = !!cam.locked;
  const set = (patch: Partial<Camera>, all = false) =>
    applyChange((p) => (all ? cams : [cam]).filter((x) => !x.locked).flatMap((x) => patchItem(p, "cameras", x.id, patch)));
  const level = project.drawingLevels.find((l) => l.id === cam.floorId);
  const parallel = cam.projection !== "perspective";
  return (
    <div className="objinfo-panel objinfo-camera" data-testid="camera-section">
      <div className="objinfo-head">
        <span className="objinfo-kind">{cams.length > 1 ? t("objinfo.camera.many", { n: cams.length }) : t("objinfo.kind.camera")}</span>
      </div>
      <div className="objinfo-section-label">{t("objinfo.camera.section")}</div>
      <label className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.camera.name")}</span>
        <input
          className="objinfo-text"
          type="text"
          defaultValue={cam.name}
          key={`nm-${cam.id}-${cam.name}`}
          disabled={locked}
          data-testid="camera-name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== cam.name) set({ name: v });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.camera.projection")}</span>
        <Dropdown
          value={cam.projection}
          onChange={(v) => set({ projection: v as CameraProjection }, true)}
          options={PROJECTIONS.map((v) => ({ value: v, label: t(`objinfo.camera.projection.${v}` as TranslationKey) }))}
          title={t("objinfo.camera.projection")}
          width={150}
        />
      </div>
      <div className="objinfo-section-label">{t("objinfo.camera.stand")}</div>
      <DimensionField label="X" value={cam.position.x} min={-Infinity} onCommit={(v) => set({ position: { x: v, y: cam.position.y } })} />
      <DimensionField label="Y" value={cam.position.y} min={-Infinity} onCommit={(v) => set({ position: { x: cam.position.x, y: v } })} />
      <DimensionField label={t("objinfo.camera.eyeHeight")} value={cam.eyeHeight} min={0} onCommit={(v) => set({ eyeHeight: v })} />
      <div className="objinfo-section-label">{t("objinfo.camera.target")}</div>
      <DimensionField label="X" value={cam.target.x} min={-Infinity} onCommit={(v) => set({ target: { x: v, y: cam.target.y } })} />
      <DimensionField label="Y" value={cam.target.y} min={-Infinity} onCommit={(v) => set({ target: { x: cam.target.x, y: v } })} />
      <DimensionField label={t("objinfo.camera.targetHeight")} value={cam.targetHeight} min={-Infinity} onCommit={(v) => set({ targetHeight: v })} />
      {parallel ? (
        <DimensionField label={t("objinfo.camera.orthoHeight")} value={cam.orthoHeight ?? 10} min={0.1} onCommit={(v) => set({ orthoHeight: v })} />
      ) : (
        <>
          <DimensionField label={t("objinfo.camera.fov")} value={cam.fovDeg} min={5} unit="°" step={1} digits={1} onCommit={(v) => set({ fovDeg: clampFov(v) })} />
          <DimensionField
            label={t("objinfo.camera.focal")}
            value={focalFromFov(cam.fovDeg)}
            min={5}
            unit="mm"
            step={1}
            digits={1}
            onCommit={(v) => set({ fovDeg: clampFov(fovFromFocal(v)) })}
          />
        </>
      )}
      <label className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.camera.sun")}</span>
        <input
          className="objinfo-text"
          type="datetime-local"
          value={toLocalInput(cam.sunWhen)}
          disabled={locked}
          title={t("objinfo.camera.sunHint")}
          data-testid="camera-sun"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              set({ sunWhen: undefined });
              return;
            }
            const d = new Date(`${v}:00Z`);
            if (Number.isFinite(d.getTime())) set({ sunWhen: d.toISOString().replace(".000Z", "Z") });
          }}
        />
      </label>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.floor")}</span>
        <span className="objinfo-fval">{level?.name ?? cam.floorId}</span>
      </div>
      <div className="objinfo-actions">
        <button type="button" className="btn" data-testid="camera-open" onClick={() => void openCamera(cam.id)}>
          {t("camera.open")}
        </button>
        <button type="button" className="btn" disabled={locked} data-testid="camera-update" onClick={() => updateCameraFromView(cam.id)} title={t("camera.updateHint")}>
          {t("camera.update")}
        </button>
        {parallel && (
          <button type="button" className="btn" disabled={locked} data-testid="camera-iso" onClick={() => set(isometricAim(project, cam))} title={t("camera.isoHint")}>
            {t("camera.iso")}
          </button>
        )}
      </div>
      {locked && <div className="objinfo-muted">{t("objinfo.camera.locked")}</div>}
    </div>
  );
}
