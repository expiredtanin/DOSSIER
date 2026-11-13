// [223] Dialog „3D-Bild exportieren": PNG in wählbarer Auflösung (Ansicht, Full HD, 4K, A-Format bei 300 dpi) aus dem
// 3D-Viewport. render3d zeichnet direkt in der Zielgrösse (`cameraBridge.captureImage`), mit der aktuellen Darstellung
// (Schatten, Kanten, Texturen, Pausen/Graustufen). Optionen: transparenter Hintergrund, Kamera (live oder gespeicherte,
// [213]). Danach speichern oder ins Layout einsetzen ([208], wie der Rendering-Dialog). Registriert sich als Öffner
// (`state/imageExportDialogHook`); Befehl `bild3d`, Menü Ansicht. Overlay wie `RenderDialog` (kein window.prompt).

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { paperPixels } from "../core";
import { getState } from "../state/appStore";
import { setImageExportDialogOpener } from "../state/imageExportDialogHook";
import { defaultTargetLayout, placeImageOnLayout } from "../state/layoutImageActions";
import { saveBinaryFile } from "../native/saveFile";
import { captureImage, getCamera, viewportAvailable, type ViewCamera } from "../viewport/cameraBridge";
import { cameraToView } from "../viewport/cameraView";
import { IMAGE_MAX_EDGE, clampImageSize, imageFileName } from "../viewport/imageExport";

type SizeId = "view" | "hd" | "uhd" | "a4" | "a3" | "a2" | "custom";
const SIZE_IDS: SizeId[] = ["view", "hd", "uhd", "a4", "a3", "a2", "custom"];

/** Zielgrösse eines Presets; "view" = Seitenverhältnis der Ansicht mit 2000 px langer Seite. */
function presetSize(id: Exclude<SizeId, "custom">, aspect: number): { width: number; height: number } {
  switch (id) {
    case "view":
      return aspect >= 1 ? { width: 2000, height: Math.round(2000 / aspect) } : { width: Math.round(2000 * aspect), height: 2000 };
    case "hd":
      return { width: 1920, height: 1080 };
    case "uhd":
      return { width: 3840, height: 2160 };
    default:
      return paperPixels(id, "landscape", 300);
  }
}

type Phase = "setup" | "working" | "done" | "error";

export const ImageExportDialogHost = memo(function ImageExportDialogHost() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<SizeId>("uhd");
  const [dims, setDims] = useState({ width: 3840, height: 2160 });
  const [transparent, setTransparent] = useState(false);
  const [cameraKey, setCameraKey] = useState("live");
  const [phase, setPhase] = useState<Phase>("setup");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ png: Uint8Array; width: number; height: number; transparent: boolean } | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [layoutTarget, setLayoutTarget] = useState("");
  const [aspect, setAspect] = useState(16 / 9);

  useEffect(() => {
    setImageExportDialogOpener(() => {
      const st = getState();
      const a = getCamera()?.aspect;
      const asp = a && Number.isFinite(a) && a > 0 ? a : 16 / 9;
      setAspect(asp);
      setCameraKey("live");
      setPhase("setup");
      setMessage("");
      setResult(null);
      setLayoutTarget(defaultTargetLayout(st.project, st.activeLevelId)?.id ?? "");
      setOpen(true);
    });
    return () => setImageExportDialogOpener(null);
  }, []);

  useEffect(() => {
    if (!result) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([result.png as BlobPart], { type: "image/png" }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  const busy = phase === "working";
  const close = useCallback(() => {
    setOpen(false);
    setResult(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, close]);

  const cameras = useMemo(() => (open ? (getState().project.cameras ?? []) : []), [open]);
  if (!open) return null;

  const pickSize = (id: SizeId) => {
    setSize(id);
    if (id !== "custom") setDims(presetSize(id, aspect));
  };
  const effective = clampImageSize(dims.width, dims.height);
  const validDims = Number.isFinite(dims.width) && Number.isFinite(dims.height) && dims.width >= 16 && dims.height >= 16;
  const canStart = validDims && !busy;
  const layouts = getState().project.layouts ?? [];

  const start = async () => {
    if (!canStart) return;
    const st = getState();
    let camera: ViewCamera | undefined;
    if (cameraKey !== "live") {
      const cam = (st.project.cameras ?? []).find((c) => c.id === cameraKey);
      const view = cam ? cameraToView(st.project, cam, effective.width / effective.height) : null;
      if (!view) {
        setPhase("error");
        setMessage(t("image3d.cameraBad"));
        return;
      }
      camera = view;
    }
    setPhase("working");
    setMessage("");
    // Dem Browser einen Frame lassen, damit „Arbeite …" erscheint, bevor das Zeichnen den Hauptthread belegt.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const img = await captureImage({ width: dims.width, height: dims.height, transparent, ...(camera ? { camera } : {}) });
    if (!img) {
      setPhase("error");
      setMessage(viewportAvailable() ? t("image3d.empty") : t("image3d.noViewport"));
      return;
    }
    setResult(img);
    setPhase("done");
    if (transparent && !img.transparent) setMessage(t("image3d.noTransparency"));
  };

  const fileName = () => imageFileName(getState().project.name, result?.width ?? 0, result?.height ?? 0);
  const save = async () => {
    if (!result) return;
    if (await saveBinaryFile(result.png, fileName(), "image/png")) getState().notify(t("image3d.saved"), "info");
  };
  const placeInLayout = () => {
    if (!result) return;
    const st = getState();
    const layout = (st.project.layouts ?? []).find((l) => l.id === layoutTarget);
    if (layout && placeImageOnLayout(layout.id, fileName(), result.png)) st.notify(t("render.toLayout.done", { name: layout.name }), "info");
    else st.notify(t("render.toLayout.none"), "warning");
  };

  return (
    <div className="imp-overlay" onClick={() => !busy && close()}>
      <div className="imp-dialog render-dialog" role="dialog" aria-modal="true" aria-label={t("image3d.title")} data-testid="image3d-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("image3d.title")}</span>
          <button className="imp-close" onClick={close} aria-label={t("export.close")} disabled={busy}>
            ×
          </button>
        </header>
        <div className="imp-body">
          {phase !== "done" && (
            <>
              <p className="imp-note">{t("image3d.intro")}</p>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.camera.title")}</div>
                <select className="imp-select" data-testid="image3d-camera" value={cameraKey} disabled={busy} onChange={(e) => setCameraKey(e.target.value)}>
                  <option value="live">{t("render.camera.live")}</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </section>
              <section className="imp-section">
                <div className="imp-section-title">{t("render.size")}</div>
                <select className="imp-select" data-testid="image3d-size" value={size} disabled={busy} onChange={(e) => pickSize(e.target.value as SizeId)}>
                  {SIZE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t(`image3d.size.${id}`)}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                  <label>
                    {t("render.width")}{" "}
                    <input className="imp-input" type="number" min={16} style={{ width: 90 }} data-testid="image3d-width" value={dims.width} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, width: Number(e.target.value) }); }} />
                  </label>
                  <label>
                    {t("render.height")}{" "}
                    <input className="imp-input" type="number" min={16} style={{ width: 90 }} data-testid="image3d-height" value={dims.height} disabled={busy} onChange={(e) => { setSize("custom"); setDims({ ...dims, height: Number(e.target.value) }); }} />
                  </label>
                </div>
                {validDims && effective.clamped && (
                  <div className="imp-note" data-testid="image3d-clamped">
                    {t("image3d.clamped", { max: IMAGE_MAX_EDGE, width: effective.width, height: effective.height })}
                  </div>
                )}
              </section>
              <section className="imp-section">
                <label className="imp-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" data-testid="image3d-transparent" checked={transparent} disabled={busy} onChange={(e) => setTransparent(e.target.checked)} />
                  {t("image3d.transparent")}
                </label>
              </section>
            </>
          )}

          {busy && (
            <section className="imp-section" data-testid="image3d-progress">
              <progress style={{ width: "100%" }} />
              <div className="imp-note">{t("image3d.working", { width: effective.width, height: effective.height })}</div>
            </section>
          )}

          {phase === "done" && result && imageUrl && (
            <section className="imp-section" data-testid="image3d-result">
              <div className="imp-note">{t("image3d.done", { width: result.width, height: result.height })}</div>
              <img
                src={imageUrl}
                alt={t("image3d.title")}
                style={{
                  maxWidth: "100%",
                  maxHeight: 360,
                  display: "block",
                  marginTop: 6,
                  ...(result.transparent ? { background: "repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 16px 16px" } : {}),
                }}
              />
              {layouts.length > 0 && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                  <span>{t("render.toLayout.target")}</span>
                  <select className="imp-select" data-testid="image3d-layout-target" value={layoutTarget} onChange={(e) => setLayoutTarget(e.target.value)}>
                    {layouts.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
          )}

          {message && (
            <p className="imp-note" role="status" data-testid="image3d-message">
              {message}
            </p>
          )}
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={close} disabled={busy}>
            {t("export.close")}
          </button>
          {phase === "done" ? (
            <>
              <button className="imp-btn" onClick={() => { setPhase("setup"); setMessage(""); }}>
                {t("render.again")}
              </button>
              <button
                className="imp-btn"
                data-testid="image3d-to-layout"
                disabled={layouts.length === 0}
                title={layouts.length === 0 ? t("render.toLayout.none") : undefined}
                onClick={placeInLayout}
              >
                {t("render.toLayout")}
              </button>
              <button className="imp-btn primary" data-testid="image3d-save" onClick={() => void save()}>
                {t("render.save")}
              </button>
            </>
          ) : (
            <button className="imp-btn primary" data-testid="image3d-start" disabled={!canStart} onClick={() => void start()}>
              {t("image3d.start")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
});
