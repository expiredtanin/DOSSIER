/**
 * React-Hook für den WebGL2-GPU-Plan-Renderer.
 * Verwaltet GL-Kontext, Shader, Geometrie-Cache und Render-Aufrufe.
 *
 * Fällt bei fehlendem WebGL2/Shader-Fehler still auf null zurück; der Aufrufer
 * (PlanView) behält dann den SVG-Pfad (Parität-Fallback).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Plan } from './generatePlan';
import {
  compilePrimitivesToGpu,
  createFillProgram,
  createLineProgram,
  PlanGpuRenderer,
  type GpuGeometry,
  type ViewBox,
} from './glPlan';

/** Liest eine CSS-Custom-Property (z. B. "--sheet") als RGB[0..1] oder null. */
function readCssColor(varName: string): [number, number, number] | null {
  if (typeof window === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  let h = raw.startsWith('#') ? raw.slice(1) : raw;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}

export function useGlPlanRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const rendererRef = useRef<PlanGpuRenderer | null>(null);
  const geomRef = useRef<GpuGeometry | null>(null);
  // GL WIRKLICH aktiv (Kontext + Shader ok)? Steuert den SVG-Fallback: bei false
  // rendert der Aufrufer den vollen SVG-Pfad, bei true übernimmt die GL-Ebene.
  const [ready, setReady] = useState(false);

  // GL-Kontext + Shader einmal aufsetzen.
  useEffect(() => {
    if (!enabled || !canvasRef.current) {
      setReady(false);
      return;
    }
    let disposed = false;
    try {
      const gl = canvasRef.current.getContext('webgl2', {
        antialias: true,
        alpha: false,
        premultipliedAlpha: false,
      });
      if (!gl) {
        console.warn('WebGL2 nicht verfügbar → SVG-Fallback');
        return;
      }
      const fillProg = createFillProgram(gl);
      const lineProg = createLineProgram(gl);
      if (!fillProg || !lineProg) {
        console.warn('Shader-Kompilierung fehlgeschlagen → SVG-Fallback');
        return;
      }
      if (disposed) return;
      glRef.current = gl;
      const renderer = new PlanGpuRenderer(gl, fillProg, lineProg);
      // Löschfarbe theme-sicher aus --sheet (Zeichenblatt ist immer „Papier").
      const sheet = readCssColor('--sheet');
      if (sheet) renderer.setClearColor(sheet[0], sheet[1], sheet[2]);
      rendererRef.current = renderer;
      setReady(true);
    } catch (e) {
      console.warn('WebGL2-Init fehlgeschlagen:', e);
      glRef.current = null;
      rendererRef.current = null;
      setReady(false);
    }
    return () => {
      disposed = true;
      setReady(false);
    };
  }, [enabled, canvasRef]);

  /** Geometrie beim Plan-Wechsel neu tessellieren (einmalig, gecacht). */
  const updateGeometry = useCallback((plan: Plan) => {
    const gl = glRef.current;
    if (!gl || !plan) return;
    try {
      geomRef.current = compilePrimitivesToGpu(gl, plan.primitives);
    } catch (e) {
      console.warn('Tessellierung fehlgeschlagen:', e);
      geomRef.current = null;
    }
  }, []);

  /** Einen Frame zeichnen (Canvas-Größe + dpr hier abgleichen). */
  const render = useCallback(
    (viewBox: ViewBox, paperScaleN = 100) => {
      const gl = glRef.current;
      const renderer = rendererRef.current;
      const canvas = canvasRef.current;
      if (!gl || !renderer || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      renderer.render(geomRef.current, viewBox, { width: w, height: h }, paperScaleN);
    },
    [canvasRef],
  );

  return { render, updateGeometry, ready };
}
