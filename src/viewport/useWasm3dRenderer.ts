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
// wgpu-22-Limit-Shim (maxInterStageShaderComponents), geteilt mit useWasmPlanRenderer.
import { patchRequestDeviceLimits } from "../engine/requestDeviceShim";

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
 * WASM-Modul EINMAL laden + initialisieren (memoisiert). `mod.default()` darf
 * nur einmal laufen — ein zweiter Init (React-StrictMode-Doppelmount) verwirft
 * die Closures des ersten („closure invoked recursively or after being dropped").
 */
let enginePromise: Promise<any> | null = null;
function loadEngine(): Promise<any> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod: any = await import("../engine/pkg3d/render3d.js");
      await mod.default(); // lädt render3d_bg.wasm
      return mod;
    })();
  }
  return enginePromise;
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
      patchRequestDeviceLimits(); // wgpu-22-Limit-Shim (src/engine/requestDeviceShim)
      const mod = await loadEngine();
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

  /** Einen Frame mit der gegebenen Kamera zeichnen (Canvas-Größe + DPR abgleichen). */
  const render = useCallback(
    (cam: Camera3d) => {
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
        r.render();
      } catch (e) {
        console.warn("render3d render fehlgeschlagen:", e);
      }
    },
    [canvasRef],
  );

  return { render, updateModel, ready, failed };
}
