// 3D-Modell-Import (OBJ/STL/glTF/GLB/PLY → Kontext-Meshes): verstecktes Datei-Feld + Dialog mit Einheit,
// Achse und Platzierung. Einmal in App eingehängt (`MeshImportHost`); geöffnet über Menü
// (`openMeshFileDialog`) oder Drag & Drop (`requestMeshImport`). Die Datei wird beim Öffnen und bei jeder
// Änderung von Einheit/Achse im Web-Worker gelesen (`readMesh`); der Dialog zeigt die erkannte Achse und die
// Ausdehnung, „Importieren" übernimmt das zuletzt gelesene Ergebnis (kein zweites Lesen).
//
// Muster: PointCloudImportDialog (abgedunkeltes Overlay, Esc/Hintergrund schliessen).

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { Dropdown } from "./Dropdown";
import {
  MESH_EXTENSIONS,
  MESH_SIDECAR_EXTENSIONS,
  MESH_UNITS,
  MISSING_EXTERNAL_PREFIX,
  NO_FACES_PREFIX,
  meshObjectsToImportedMeshes,
  readMesh,
} from "../io/meshImport";
import type { MeshImportReport, MeshObject, MeshPlacement, MeshUnit, MeshUp } from "../io/meshImport";
import { closeMeshImport, registerMeshFileInput, requestMeshImport, splitMeshFiles, useMeshImportRequest } from "../state/meshImportStore";
import type { MeshImportRequest } from "../state/meshImportStore";
import { requestPointCloudImport } from "../state/pointCloudStore";
import { projectGeoOrigin } from "../core";
import type { ImportedMesh, Project } from "../model/types";

export interface MeshImportHostProps {
  project: Project;
  onImport: (meshes: ImportedMesh[], report: MeshImportReport) => void;
  notify: (message: string, kind?: "info" | "warning" | "error") => void;
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));

/** Ausdehnung aller Objekte (Meter, Modell-Achsen). */
function extent(objects: readonly MeshObject[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const o of objects) {
    for (let i = 0; i + 2 < o.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (o.positions[i + a] < lo[a]) lo[a] = o.positions[i + a];
        if (o.positions[i + a] > hi[a]) hi[a] = o.positions[i + a];
      }
    }
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

/** Namen der fehlenden Begleitdateien aus der Rust-Meldung. */
function missingList(message: string): string {
  const m = /fehlen: (.*?) \(mit der/.exec(message);
  return m ? m[1] : message;
}

async function bytesOf(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

function MeshImportDialog({ req, project, onImport, notify }: { req: MeshImportRequest } & MeshImportHostProps) {
  const { file, sidecars } = req;
  const isGltf = /\.(gltf|glb)$/i.test(file.name);
  const [unit, setUnit] = useState<MeshUnit>("m");
  const [up, setUp] = useState<MeshUp>("auto");
  const [placement, setPlacement] = useState<MeshPlacement>("center");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ objects: MeshObject[]; report: MeshImportReport } | null>(null);
  const seq = useRef(0);
  // Dateiinhalt einmal laden, nicht bei jeder Änderung.
  const cache = useRef<{ main: Uint8Array; files: { name: string; bytes: Uint8Array }[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMeshImport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        cache.current ??= {
          main: await bytesOf(file),
          files: await Promise.all(sidecars.map(async (f) => ({ name: f.name, bytes: await bytesOf(f) }))),
        };
        const r = await readMesh(cache.current.main, file.name, { unit, up, files: cache.current.files });
        if (id !== seq.current) return;
        setResult(r);
      } catch (e) {
        if (id !== seq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith(NO_FACES_PREFIX)) {
          // PLY ohne Flächen = Punktwolke: Dialog wechseln.
          closeMeshImport();
          notify(t("mesh.import.noFaces"), "info");
          requestPointCloudImport(file);
          return;
        }
        setResult(null);
        setError(
          msg.startsWith(MISSING_EXTERNAL_PREFIX)
            ? t("mesh.import.missingExternal", { list: missingList(msg) })
            : `${t("mesh.import.failed")}: ${msg}`,
        );
      } finally {
        if (id === seq.current) setBusy(false);
      }
    })();
  }, [file, sidecars, unit, up]);

  const dims = useMemo(() => (result ? extent(result.objects) : null), [result]);
  const r = result?.report;

  const onDo = () => {
    if (!result) return;
    const meshes = meshObjectsToImportedMeshes(result.objects, file.name, { placement, geoOrigin: projectGeoOrigin(project) });
    closeMeshImport();
    onImport(meshes, result.report);
  };

  return (
    <div className="imp-overlay" onClick={() => closeMeshImport()}>
      <div className="imp-dialog" role="dialog" aria-modal="true" aria-label={t("mesh.import.title")} onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("mesh.import.title")}</span>
          <button className="imp-close" onClick={() => closeMeshImport()} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <div className="imp-file">
            <span className="imp-file-name" title={file.name}>
              {file.name} · {(file.size / 1e6).toFixed(1)} MB
            </span>
          </div>
          {sidecars.length > 0 && <div className="imp-note">{t("mesh.importDialog.files", { list: sidecars.map((f) => f.name).join(", ") })}</div>}

          <section className="imp-section">
            <div className="imp-section-title">{t("mesh.importDialog.unit")}</div>
            <Dropdown
              value={isGltf ? "m" : unit}
              onChange={(v) => setUnit(v as MeshUnit)}
              title={t("mesh.importDialog.unit")}
              options={MESH_UNITS.map((u) => ({ value: u, label: t(`mesh.importDialog.unit.${u}`), disabled: isGltf && u !== "m" }))}
            />
            {isGltf && <div className="imp-note">{t("mesh.importDialog.unitFixed")}</div>}
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("mesh.importDialog.up")}</div>
            {(["auto", "z", "y"] as const).map((u) => (
              <label key={u} className="imp-radio">
                <input type="radio" name="mesh-up" disabled={isGltf} checked={(isGltf ? "y" : up) === u} onChange={() => setUp(u)} />
                <span>{t(`mesh.importDialog.up.${u}`)}</span>
              </label>
            ))}
            {isGltf && <div className="imp-note">{t("mesh.importDialog.upFixed")}</div>}
          </section>

          <section className="imp-section">
            <div className="imp-section-title">{t("mesh.importDialog.placement")}</div>
            {(["center", "original"] as const).map((p) => (
              <label key={p} className="imp-radio">
                <input type="radio" name="mesh-placement" checked={placement === p} onChange={() => setPlacement(p)} />
                <span>{t(`mesh.importDialog.placement.${p}`)}</span>
              </label>
            ))}
          </section>

          {busy && <div className="imp-note">{t("mesh.importDialog.reading")}</div>}
          {error && <div className="imp-warn">{error}</div>}
          {r && dims && !busy && (
            <section className="imp-section" data-testid="mesh-report">
              <div className={r.upAuto && !r.upCertain ? "imp-warn" : "imp-note"}>
                {r.upAuto && !r.upCertain
                  ? t("mesh.importDialog.detectedUncertain", { axis: r.up.toUpperCase(), n: r.objects, tris: r.triangles })
                  : t("mesh.importDialog.detected", {
                      axis: r.up.toUpperCase(),
                      n: r.objects,
                      tris: r.triangles,
                      size: fmt(dims[0]),
                      depth: fmt(dims[1]),
                      height: fmt(dims[2]),
                    })}
              </div>
              {r.truncated && <div className="imp-warn">{t("mesh.import.truncated")}</div>}
              {r.warnings.map((w) => (
                <div key={w} className="imp-note">
                  {w}
                </div>
              ))}
            </section>
          )}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={() => closeMeshImport()}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" onClick={onDo} disabled={!result || busy}>
            {t("mesh.importDialog.import")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Verstecktes Datei-Feld (mehrere Dateien: Modell + `.mtl`/`.bin`) + Dialog; einmal in der App einhängen. */
export function MeshImportHost(props: MeshImportHostProps) {
  const req = useMeshImportRequest();
  return (
    <>
      <input
        ref={registerMeshFileInput}
        type="file"
        multiple
        accept={[...MESH_EXTENSIONS, ...MESH_SIDECAR_EXTENSIONS].map((e) => "." + e).join(",")}
        style={{ display: "none" }}
        data-testid="mesh-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const r = splitMeshFiles(files);
          if (r) requestMeshImport(r.file, r.sidecars);
        }}
      />
      {req && <MeshImportDialog key={req.file.name + req.file.size + req.file.lastModified} req={req} {...props} />}
    </>
  );
}
