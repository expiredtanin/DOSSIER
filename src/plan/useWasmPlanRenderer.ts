/**
 * React-Hook für den nativen render2d-Renderer als WASM/WebGPU-Viewport.
 *
 * Spiegelt die Schnittstelle von {@link useGlPlanRenderer} ({ render,
 * updateGeometry, ready }), damit PlanView beide Engines ohne weitere Verzweigung
 * am selben Canvas + über dieselben Effekte treiben kann. Die eigentliche
 * Zeichenlogik lebt in Rust (src-tauri/render2d, Feature `web`); hier wird nur das
 * WASM-Modul geladen, der Renderer an das Canvas gebunden und die Szene/ViewBox
 * durchgereicht.
 *
 * Fällt bei fehlendem WebGPU oder Init-Fehler still auf `ready:false` zurück; der
 * Aufrufer (PlanView) behält dann den WebGL2-/SVG-Pfad.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan } from "./generatePlan";
import { planToRenderScene } from "./toRenderScene";

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal-Typ des WASM-Exports (das echte .d.ts entsteht erst mit `build:engine`). */
interface WebPlanRendererLike {
  set_scene(json: string): void;
  set_view_box(x: number, y: number, w: number, h: number): void;
  set_paper_scale(n: number): void;
  set_text_scale(n: number): void;
  resize(w: number, h: number): void;
  render(): void;
}

/**
 * WASM-Modul EINMAL laden + initialisieren (memoisiert). Wichtig: `mod.default()`
 * darf nur einmal laufen — ein zweiter Init (z.B. durch React-StrictMode-Doppel-
 * mount) verwirft die Closures des ersten und wirft „closure invoked recursively
 * or after being dropped".
 */
let enginePromise: Promise<any> | null = null;
function loadEngine(): Promise<any> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod: any = await import("../engine/pkg/render2d.js");
      await mod.default(); // lädt render2d_bg.wasm
      return mod;
    })();
  }
  return enginePromise;
}

/**
 * Renderer je Canvas EINMAL erzeugen (memoisiert). Ein Canvas kann nur EINEN
 * WebGPU-Kontext tragen; ein zweiter `WebPlanRenderer.new` auf demselben Canvas
 * (StrictMode-Remount) würde kollidieren. Die Promise wird gecacht, damit der
 * Doppelmount denselben Renderer teilt.
 */
const rendererCache = new WeakMap<HTMLCanvasElement, Promise<WebPlanRendererLike>>();
function getRenderer(canvas: HTMLCanvasElement): Promise<WebPlanRendererLike> {
  let p = rendererCache.get(canvas);
  if (!p) {
    p = (async () => {
      const mod = await loadEngine();
      // Canvas VOR dem Surface-Erzeugen auf die Zielpixel (DPR) bringen.
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      return (await mod.WebPlanRenderer.new(canvas, undefined)) as WebPlanRendererLike;
    })();
    rendererCache.set(canvas, p);
    // Bei Fehlschlag den Cache leeren, damit ein späterer Versuch neu startet.
    p.catch(() => rendererCache.delete(canvas));
  }
  return p;
}

export function useWasmPlanRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const rendererRef = useRef<WebPlanRendererLike | null>(null);
  const [ready, setReady] = useState(false);

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
      } catch (e) {
        console.warn("render2d WASM/WebGPU-Init fehlgeschlagen → Fallback", e);
        rendererRef.current = null;
        setReady(false);
      }
    })();
    return () => {
      disposed = true;
      setReady(false);
    };
  }, [enabled, canvasRef]);

  /** Szene beim Plan-Wechsel neu setzen (re-tesselliert in Rust, gecacht). */
  const updateGeometry = useCallback((plan: Plan) => {
    const r = rendererRef.current;
    if (!r || !plan) return;
    try {
      r.set_scene(JSON.stringify(planToRenderScene(plan)));
    } catch (e) {
      console.warn("render2d set_scene fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Einen Frame zeichnen (Canvas-Größe + dpr hier abgleichen). `textScaleN`
   * bewusst getrennt von `paperScaleN`: er treibt NUR die Schriftgröße der
   * Raumstempel (spiegelt die SVG-Formel — feste Referenzskala 1:100 im
   * Anzeigemodus, siehe PlanView.tsx `textScaleForGl`), während `paperScaleN`
   * weiter die echten Papier-mm-Strichbreiten der Geometrie treibt.
   */
  const render = useCallback(
    (viewBox: ViewBox, paperScaleN = 100, textScaleN = 100) => {
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
        r.set_paper_scale(paperScaleN);
        r.set_text_scale(textScaleN);
        r.set_view_box(viewBox.x, viewBox.y, viewBox.w, viewBox.h);
        r.render();
      } catch (e) {
        console.warn("render2d render fehlgeschlagen:", e);
      }
    },
    [canvasRef],
  );

  return { render, updateGeometry, ready };
}
