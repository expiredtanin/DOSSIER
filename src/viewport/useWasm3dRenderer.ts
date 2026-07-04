/**
 * React-Hook für den nativen render3d-Renderer als WASM/WebGPU-Viewport.
 *
 * Gegenstück zu {@link useWasmPlanRenderer} (2D): lädt das WASM-Modul aus
 * src/engine/pkg3d (`npm run build:engine3d`), bindet den Renderer an ein
 * Canvas und reicht Modell + Kamera durch. Die eigentliche Zeichenlogik lebt
 * in Rust (src-tauri/render3d, Feature `web`) — dieselbe Extrusion/Pipeline
 * wie das native wgpu-Fenster.
 *
 * Modell-Sync: `updateModel(project)` flacht das Projekt über
 * {@link projectToModel3d} (Wände mit Öffnungs-Teilquadern + Deckenplatten)
 * und schiebt es als JSON an `set_model` — exakt dasselbe Format wie der
 * native Tauri-Push (nativeSync.ts).
 *
 * Fällt bei fehlendem WebGPU oder Init-Fehler auf `ready:false` + `failed:true`
 * zurück; der Aufrufer (Wasm3DViewport) zeigt dann den Hinweis-Fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../model/types";
import { projectToModel3d } from "../plan/toWalls3d";
import { loadEngine3d } from "../engine/engine3d";

/** Fertige Kamera für einen Frame (world-Meter, Y-up — wie render3d::types::Camera). */
export interface Camera3d {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** true = perspektivisch (fovY), false = orthografisch (orthoHalfHeight). */
  perspective: boolean;
  /** Vertikaler Öffnungswinkel in RADIANT (nur perspektivisch). */
  fovY: number;
  /** Halbe Sichthöhe in Metern (nur orthografisch). */
  orthoHalfHeight: number;
}

/** Minimal-Typ des WASM-Exports (das echte .d.ts entsteht erst mit `build:engine3d`). */
interface WebModelRendererLike {
  set_model(json: string): void;
  /** Darstellungsart setzen — `style` ∈ "shaded"|"white"|"wireframe"|"hidden"|
   * "textured" (deckt die volle `RenderMode`-Union der Oberleiste ab;
   * "textured" faellt engine-seitig vorerst auf "shaded" zurueck). */
  set_render_style(style: string): void;
  set_view_preset(preset: string): void;
  /** Boden-Referenzraster in der Welt-XZ-Ebene ein-/ausblenden (Rust-seitig,
   * `web::set_ground_grid`). `visible=false` zeichnet kein Raster; sonst ein
   * Quadrat der Kantenlaenge `extent_m` (zentriert um den Ursprung, XZ) auf
   * Hoehe `elevation_m` (world-Y) mit Linienabstand `spacing_m`. Wirkt erst
   * beim naechsten `render`. */
  set_ground_grid(
    visible: boolean,
    elevation_m: number,
    extent_m: number,
    spacing_m: number,
  ): void;
  set_camera(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    upX: number,
    upY: number,
    upZ: number,
    perspective: boolean,
    fovY: number,
    orthoHalfHeight: number,
  ): void;
  resize(w: number, h: number): void;
  render(): void;
}

/**
 * Renderer je Canvas EINMAL erzeugen (memoisiert). Ein Canvas kann nur EINEN
 * WebGPU-Kontext tragen; ein zweiter `WebModelRenderer.new` auf demselben
 * Canvas (StrictMode-Remount) würde kollidieren — die gecachte Promise lässt
 * den Doppelmount denselben Renderer teilen.
 */
const rendererCache = new WeakMap<HTMLCanvasElement, Promise<WebModelRendererLike>>();
function getRenderer(canvas: HTMLCanvasElement): Promise<WebModelRendererLike> {
  let p = rendererCache.get(canvas);
  if (!p) {
    p = (async () => {
      const mod = await loadEngine3d();
      // Canvas VOR dem Surface-Erzeugen auf die Zielpixel (DPR) bringen.
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      return (await mod.WebModelRenderer.new(canvas)) as WebModelRendererLike;
    })();
    rendererCache.set(canvas, p);
    // Bei Fehlschlag den Cache leeren, damit ein späterer Versuch neu startet.
    p.catch(() => rendererCache.delete(canvas));
  }
  return p;
}

export function useWasm3dRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const rendererRef = useRef<WebModelRendererLike | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // WASM-Renderer an das Canvas binden (memoisiert, StrictMode-fest).
  useEffect(() => {
    if (!enabled || !canvasRef.current) {
      setReady(false);
      return;
    }
    let disposed = false;
    const canvas = canvasRef.current;
    void (async () => {
      try {
        const renderer = await getRenderer(canvas);
        if (disposed) return;
        rendererRef.current = renderer;
        setReady(true);
        setFailed(false);
      } catch (e) {
        console.warn("render3d WASM/WebGPU-Init fehlgeschlagen", e);
        rendererRef.current = null;
        setReady(false);
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      setReady(false);
    };
  }, [enabled, canvasRef]);

  /** Modell bei Projektänderung neu setzen (re-extrudiert in Rust). */
  const updateModel = useCallback((project: Project) => {
    const r = rendererRef.current;
    if (!r || !project) return;
    try {
      r.set_model(JSON.stringify(projectToModel3d(project)));
    } catch (e) {
      console.warn("render3d set_model fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Darstellungsart umschalten — reicht die volle `RenderMode`-Union der
   * Oberleiste ("shaded"/"white"/"textured"/"wireframe"/"hidden") an Rust
   * durch (`web::set_render_style`); die Engine entscheidet je Stil, wie
   * gezeichnet wird ("textured" faellt dort vorerst auf "shaded" zurueck).
   * Wirkt erst beim nächsten `render`.
   */
  const setRenderStyle = useCallback((style: string) => {
    const r = rendererRef.current;
    if (!r) return;
    try {
      r.set_render_style(style);
    } catch (e) {
      console.warn("render3d set_render_style fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Boden-Referenzraster ein-/ausblenden (Overlay-Umschalter im Viewport,
   * s. Wasm3DViewport.tsx). `elevationM` = OKFF des aktiven Geschosses
   * (`baseElevation`), `extentM`/`spacingM` = Kantenlaenge/Linienabstand des
   * Quadrats in Metern. Wirkt erst beim naechsten `render`.
   */
  const setGroundGrid = useCallback(
    (visible: boolean, elevationM: number, extentM: number, spacingM: number) => {
      const r = rendererRef.current;
      if (!r) return;
      try {
        r.set_ground_grid(visible, elevationM, extentM, spacingM);
      } catch (e) {
        console.warn("render3d set_ground_grid fehlgeschlagen:", e);
      }
    },
    [],
  );

  /**
   * Kamera-Praeset anwenden (`front`/`top`/`side`/`iso`/`perspective`, wie
   * `View3d` in TopBar.tsx). Delegiert die formatfuellende Ziel-/Distanz-
   * Berechnung + Projektionsart (ortho fuer front/top/side) an Rust
   * (`web::set_view_preset` -> `math::preset_camera`) — dieselbe Logik wie das
   * native Fenster, statt einer zweiten Praeset-Tabelle in TS. Wirkt erst beim
   * naechsten `render`.
   */
  const applyViewPreset = useCallback((preset: string) => {
    const r = rendererRef.current;
    if (!r) return;
    try {
      r.set_view_preset(preset);
    } catch (e) {
      console.warn("render3d set_view_preset fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Einen Frame zeichnen (Canvas-Größe + DPR abgleichen). `cam` = null lässt
   * die zuletzt in Rust gesetzte Kamera unverändert — Fall für `render(null)`
   * direkt nach `applyViewPreset` (die Kamera kommt dann aus `preset_camera`,
   * ein `set_camera` hier würde das freie Orbit-Ergebnis darüberschreiben und
   * die orthografische Projektion der Presets zunichtemachen).
   */
  const render = useCallback(
    (cam: Camera3d | null) => {
      const r = rendererRef.current;
      const canvas = canvasRef.current;
      if (!r || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        r.resize(w, h);
        if (cam) {
          r.set_camera(
            cam.eye[0],
            cam.eye[1],
            cam.eye[2],
            cam.target[0],
            cam.target[1],
            cam.target[2],
            cam.up[0],
            cam.up[1],
            cam.up[2],
            cam.perspective,
            cam.fovY,
            cam.orthoHalfHeight,
          );
        }
        r.render();
      } catch (e) {
        console.warn("render3d render fehlgeschlagen:", e);
      }
    },
    [canvasRef],
  );

  return {
    render,
    updateModel,
    setRenderStyle,
    applyViewPreset,
    setGroundGrid,
    ready,
    failed,
  };
}
