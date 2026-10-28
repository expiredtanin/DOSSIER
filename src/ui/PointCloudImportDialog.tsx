// Punktwolken-Import ([27] Stufe 1): verstecktes Datei-Feld + Dialog mit Voxel/Budget-Wahl und
// Bericht (Anzahl, Ausdehnung, EPSG, Lage). Einmal in App eingehängt (`PointCloudImportHost`);
// geöffnet über Menü (`openPointCloudFileDialog`), Drag & Drop oder das Lage-Panel
// (`requestPointCloudImport`). Gelesen wird im Web-Worker (`readPointCloud`), die fertige Wolke
// landet im UI-Store (`pointCloudStore.ts`), NICHT im Projekt.
//
// Muster: ExportDxfDialog (abgedunkeltes Overlay, Esc/Hintergrund schliessen).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { Dropdown } from "./Dropdown";
import { DEFAULT_MAX_POINTS, POINT_CLOUD_EXTENSIONS, readPointCloud } from "../io/pointCloud";
import type { PointCloudData } from "../io/pointCloud";
import {
  addPointCloud,
  closePointCloudImport,
  registerPointCloudFileInput,
  requestPointCloudImport,
  usePointCloudImportRequest,
} from "../state/pointCloudStore";
import { placePointCloud } from "../state/pointCloudPlacement";
import type { PointCloudPlacement } from "../state/pointCloudPlacement";
import { projectGeoOrigin } from "../core";
import type { Project } from "../model/types";

const BUDGETS = [1_000_000, 2_000_000, DEFAULT_MAX_POINTS, 10_000_000, 0];

const fmtInt = (n: number) => Math.round(n).toLocaleString("de-CH");
const fmtM = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(1) : n.toFixed(2));

/** Hinweistexte zur Lage (für Dialog und Panel). */
export function placementHints(p: PointCloudPlacement): TranslationKey[] {
  if (p.mode === "georef") {
    const keys: TranslationKey[] = [
      p.epsgAssumed ? "pointCloud.placement.georefAssumed" : "pointCloud.placement.georef",
    ];
    if (!p.heightFromAnchor) keys.push("pointCloud.placement.noHeight");
    return keys;
  }
  return [p.mode === "local" ? "pointCloud.placement.local" : "pointCloud.placement.centered"];
}

export function placementOf(data: PointCloudData, project: Project): PointCloudPlacement {
  const r = data.report;
  return placePointCloud(
    { origin: data.origin, bboxMin: r.bboxMin, bboxMax: r.bboxMax, epsg: r.epsg },
    projectGeoOrigin(project),
    project.geoAnchor?.height,
  );
}

function PointCloudImportDialog({ file, project }: { file: File; project: Project }) {
  const [voxel, setVoxel] = useState("0");
  const [budget, setBudget] = useState(DEFAULT_MAX_POINTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PointCloudData | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePointCloudImport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onRead = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const v = Number(voxel.replace(",", "."));
      const data = await readPointCloud(await file.arrayBuffer(), file.name, {
        voxel: Number.isFinite(v) && v > 0 ? v : 0,
        maxPoints: budget,
      });
      setResult(data);
    } catch (e) {
      setError(t("pointCloud.error", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = () => {
    if (!result) return;
    addPointCloud(file.name, result);
    closePointCloudImport();
  };

  const r = result?.report;
  const placement = result ? placementOf(result, project) : null;
  const attrs = r
    ? [
        r.hasColor && t("pointCloud.attr.rgb"),
        r.hasIntensity && t("pointCloud.attr.intensity"),
        r.hasClassification && t("pointCloud.attr.class"),
      ].filter(Boolean)
    : [];

  return (
    <div className="imp-overlay" onClick={() => closePointCloudImport()}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("pointCloud.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("pointCloud.title")}</span>
          <button className="imp-close" onClick={() => closePointCloudImport()} aria-label={t("pointCloud.cancel")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <div className="imp-file">
            <span className="imp-file-label">{t("pointCloud.file")}</span>
            <span className="imp-file-name" title={file.name}>
              {file.name} · {fmtInt(file.size / 1e6)} MB
            </span>
          </div>

          <section className="imp-section">
            <div className="imp-section-title">{t("pointCloud.voxel")}</div>
            <input
              className="kz-input"
              type="number"
              min={0}
              step={0.05}
              value={voxel}
              aria-label={t("pointCloud.voxel")}
              onChange={(e) => setVoxel(e.target.value)}
            />
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("pointCloud.budget")}</div>
            <Dropdown
              value={String(budget)}
              onChange={(v) => setBudget(Number(v))}
              title={t("pointCloud.budget")}
              options={BUDGETS.map((b) => ({
                value: String(b),
                label: b === 0 ? t("pointCloud.budget.unlimited") : t("pointCloud.budget.millions", { n: b / 1e6 }),
              }))}
            />
          </section>

          {busy && <div className="imp-note">{t("pointCloud.reading")}</div>}
          {error && <div className="imp-warn">{error}</div>}

          {r && placement && (
            <section className="imp-section pc-report" data-testid="pointcloud-report">
              <div className="imp-section-title">{t("pointCloud.report")}</div>
              <div>
                {t("pointCloud.report.format")}: {r.format.toUpperCase()} {r.version}
              </div>
              <div>
                {t("pointCloud.report.points", { kept: fmtInt(r.pointsKept), read: fmtInt(r.pointsRead) })}
                {r.voxel > 0 && <> · {t("pointCloud.report.voxel", { v: fmtM(r.voxel) })}</>}
              </div>
              <div>
                {t("pointCloud.report.bbox")}:{" "}
                {t("pointCloud.report.bboxValue", {
                  dx: fmtM(r.bboxMax[0] - r.bboxMin[0]),
                  dy: fmtM(r.bboxMax[1] - r.bboxMin[1]),
                  dz: fmtM(r.bboxMax[2] - r.bboxMin[2]),
                })}
              </div>
              <div>
                {t("pointCloud.report.min")}: {r.bboxMin.map(fmtM).join(" / ")}
              </div>
              <div>
                {t("pointCloud.report.epsg")}: {r.epsg !== null ? `EPSG ${r.epsg}` : t("pointCloud.report.epsgNone")}
              </div>
              <div>
                {t("pointCloud.report.attrs")}: {attrs.length ? attrs.join(", ") : t("pointCloud.attr.none")}
              </div>
              {r.truncated && <div className="imp-warn">{t("pointCloud.report.truncated")}</div>}
              {r.warnings.map((w) => (
                <div key={w} className="imp-note">
                  {w}
                </div>
              ))}
              {placementHints(placement).map((k) => (
                <div key={k} className="imp-note">
                  {t(k)}
                </div>
              ))}
              <div className="imp-note">{t("pointCloud.sessionHint")}</div>
            </section>
          )}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={() => closePointCloudImport()}>
            {t("pointCloud.cancel")}
          </button>
          <button className="imp-btn" onClick={() => void onRead()} disabled={busy}>
            {t("pointCloud.read")}
          </button>
          <button className="imp-btn primary" onClick={onAdd} disabled={!result || busy}>
            {t("pointCloud.add")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Verstecktes Datei-Feld + Dialog; einmal in der App einhängen. */
export function PointCloudImportHost({ project }: { project: Project }) {
  const file = usePointCloudImportRequest();
  return (
    <>
      <input
        ref={registerPointCloudFileInput}
        type="file"
        accept={POINT_CLOUD_EXTENSIONS.map((e) => "." + e).join(",")}
        style={{ display: "none" }}
        data-testid="pointcloud-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) requestPointCloudImport(f);
        }}
      />
      {file && <PointCloudImportDialog key={file.name + file.size + file.lastModified} file={file} project={project} />}
    </>
  );
}
