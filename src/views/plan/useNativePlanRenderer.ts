/**
 * Nativer Plan-Renderer (macOS/Tauri): dieselbe Schnittstelle wie
 * `useGlPlanRenderer` ({render, updateGeometry, ready}), aber die Pixel entstehen
 * in einer Metal-Fläche HINTER der transparenten Webview (src-tauri/src/native_embed.rs).
 *
 * Kompilierung + Chunk-Cache bleiben TypeScript (`GpuChunkCache` mit `NativeGl`);
 * Rust hält die Puffer. Pan/Zoom kostet nur noch einen kleinen Frame-Aufruf.
 * Eingaben, Auswahl, Griffe, Text bleiben im SVG-Overlay darüber.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Plan } from "../../core";
import { GpuChunkCache } from "../../core";
import { compilePrimitivesToGpu } from "../../core";
import type { GpuGeometry, ViewBox__plan_glPlan_glPlanTypes as ViewBox } from "../../core";
import type { Primitive } from "../../core";
import { NativeGl, type NativeInvoke } from './nativeGl';
import { readCssColor } from './cssColor';
import { NativeTextSync } from "../../core";
import { planTextEntries } from "../../core";

/** Läuft die App in einer Tauri-Webview? */
const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let invokePromise: Promise<NativeInvoke | null> | null = null;
function loadInvoke(): Promise<NativeInvoke | null> {
  invokePromise ??= (async () => {
    if (!isTauri()) return null;
    try {
      // @ts-ignore optionales Paket
      const mod = await import(/* @vite-ignore */ '@tauri-apps/api/core').catch(() => null);
      return mod && typeof (mod as any).invoke === 'function' ? ((mod as any).invoke as NativeInvoke) : null;
    } catch {
      return null;
    }
  })();
  return invokePromise;
}

let availablePromise: Promise<boolean> | null = null;
/** Gibt es in diesem Build die eingebettete native 2D-Fläche? (einmal erfragt) */
export function nativeEmbedAvailable(): Promise<boolean> {
  availablePromise ??= (async () => {
    const invoke = await loadInvoke();
    if (!invoke) return false;
    try {
      return (await invoke('native2d_embed_available')) === true;
    } catch {
      return false;
    }
  })();
  return availablePromise;
}

/** Wahr, sobald klar ist, dass die native Fläche verfügbar ist (null = noch offen). */
export function useNativeAvailable(): boolean | null {
  const [avail, setAvail] = useState<boolean | null>(null);
  useEffect(() => {
    let off = false;
    void nativeEmbedAvailable().then((v) => {
      if (!off) setAvail(v);
    });
    return () => {
      off = true;
    };
  }, []);
  return avail;
}

export function useNativePlanRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const glRef = useRef<NativeGl | null>(null);
  const cacheRef = useRef<GpuChunkCache | null>(null);
  const invokeRef = useRef<NativeInvoke | null>(null);
  const rectRef = useRef('');
  const [ready, setReady] = useState(false);
  // Texte: Rust zeichnet einfache Texte als Vektor-Glyphen (nativeText.ts). Solange
  // das nicht bestätigt ist (oder keine Schrift gefunden wurde), bleibt es beim SVG.
  const [gpuTexts, setGpuTexts] = useState(false);
  const textSync = useRef(new NativeTextSync());
  const textsDisabled = useRef(false);
  const lastPlan = useRef<Plan | null>(null);
  // Auswahl-Hervorhebung als eigene native Geometrie (zuoberst, konstante Pixelbreite).
  const highlightGeom = useRef<GpuGeometry | null>(null);
  const lastPxPerMeter = useRef(0);
  const excludedText = useRef<string | null>(null);

  const pushTexts = useCallback((plan: Plan | null) => {
    const invoke = invokeRef.current;
    if (!invoke || !plan || textsDisabled.current) return;
    // Nur die Text-Einträge (`planTextEntries`, [K3d]) — nicht alle Primitive.
    const { upsert, remove } = textSync.current.delta(planTextEntries(plan).map((e) => e.p), excludedText.current);
    if (upsert.length === 0 && remove.length === 0) return;
    void invoke('native2d_texts', { upsert, remove })
      .then((ok) => {
        if (ok === true) setGpuTexts(true);
        else {
          textsDisabled.current = true;
          textSync.current.reset();
          setGpuTexts(false);
        }
      })
      .catch(() => {
        textsDisabled.current = true;
        setGpuTexts(false);
      });
  }, []);

  /** Text, der gerade im Editor liegt: nicht nativ zeichnen (der Editor zeigt ihn). */
  const setExcludedText = useCallback(
    (id: string | null) => {
      if (excludedText.current === id) return;
      excludedText.current = id;
      pushTexts(lastPlan.current);
    },
    [pushTexts],
  );

  // Frame-Aufrufe zusammenfassen: höchstens einer in der Luft, der letzte gewinnt.
  const frameBusy = useRef(false);
  const frameNext = useRef<(() => Promise<unknown>) | null>(null);
  const sendFrame = useCallback((job: () => Promise<unknown>) => {
    if (frameBusy.current) {
      frameNext.current = job;
      return;
    }
    frameBusy.current = true;
    const run = (j: () => Promise<unknown>) => {
      void j()
        .catch((e) => console.debug('native2d_frame fehlgeschlagen', e))
        .finally(() => {
          const next = frameNext.current;
          frameNext.current = null;
          if (next) run(next);
          else frameBusy.current = false;
        });
    };
    run(job);
  }, []);

  const syncRect = useCallback((force = false) => {
    const invoke = invokeRef.current;
    const canvas = canvasRef.current;
    if (!invoke || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (!force && key === rectRef.current) return;
    rectRef.current = key;
    void invoke('native2d_embed_rect', { x: r.left, y: r.top, w: r.width, h: r.height }).catch(() => {});
  }, [canvasRef]);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let disposed = false;
    let ro: ResizeObserver | null = null;
    const holes: Element[] = [];
    const onWin = () => syncRect();
    void (async () => {
      const invoke = await loadInvoke();
      if (!invoke || disposed || !(await nativeEmbedAvailable())) return;
      invokeRef.current = invoke;
      const gl = new NativeGl(invoke);
      glRef.current = gl;
      cacheRef.current = new GpuChunkCache(gl);
      syncRect(true);
      if (canvasRef.current && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => syncRect());
        ro.observe(canvasRef.current);
      }
      window.addEventListener('resize', onWin);
      // Webview über der Fläche durchsichtig machen: alle Vorfahren des Canvas
      // verlieren ihren Hintergrund (Geschwister behalten ihren eigenen).
      for (let el = canvasRef.current?.parentElement; el; el = el.parentElement) {
        el.setAttribute('data-native-hole', '');
        holes.push(el);
      }
      document.documentElement.setAttribute('data-native-hole', '');
      setReady(true);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      for (const el of holes) el.removeAttribute('data-native-hole');
      document.documentElement.removeAttribute('data-native-hole');
      window.removeEventListener('resize', onWin);
      cacheRef.current?.dispose();
      cacheRef.current = null;
      const invoke = invokeRef.current;
      // Layout leeren + Fläche ausblenden (Plan-Ansicht verschwindet).
      if (glRef.current && invoke) {
        const { remove } = textSync.current.delta([]);
        if (remove.length) void invoke('native2d_texts', { upsert: [], remove }).catch(() => {});
        lastPlan.current = null;
        highlightGeom.current = null;
        lastSentGeoms.current = null;
        setGpuTexts(false);
        const { delete: del } = glRef.current.takeLayout([]);
        void invoke('native2d_layout', { layout: [], delete: del }).catch(() => {});
        void invoke('native2d_embed_hide').catch(() => {});
      }
      glRef.current = null;
      invokeRef.current = null;
      rectRef.current = '';
      setReady(false);
    };
  }, [enabled, canvasRef, syncRect]);

  /** Zuletzt gesendete Geometrie-Liste: unverändert → kein erneuter Layout-Versand. */
  const lastSentGeoms = useRef<readonly GpuGeometry[] | null>(null);
  const takeFullLayout = useCallback(() => {
    const gl = glRef.current!;
    const geoms = cacheRef.current?.geometries ?? [];
    const prev = lastSentGeoms.current;
    const same = !!prev && prev.length === geoms.length && prev.every((g, i) => g === geoms[i]);
    lastSentGeoms.current = geoms.slice();
    const res = gl.takeLayout(geoms);
    return { ...res, unchanged: same && res.delete.length === 0 };
  }, []);

  /**
   * Auswahl-Hervorhebung nativ zeichnen (statt eines riesigen SVG-Pfads, dessen
   * Rastern bei grossen Kataster-Auswahlen beim An-/Abwählen Hunderte ms kostete).
   */
  const setHighlight = useCallback(
    (prims: readonly Primitive[], color: string) => {
      const gl = glRef.current;
      const invoke = invokeRef.current;
      if (!gl || !invoke) return;
      const old = highlightGeom.current;
      if (old) {
        gl.deleteBuffer(old.fill.positionBuffer);
        gl.deleteBuffer(old.fill.indexBuffer);
        gl.deleteBuffer(old.line.vertexBuffer);
        gl.deleteBuffer(old.line.indexBuffer);
        highlightGeom.current = null;
      }
      if (prims.length) {
        const lines: Primitive[] = [];
        const mk = (a: { x: number; y: number }, b: { x: number; y: number }, drawingId?: string) =>
          lines.push({ kind: 'line', a, b, cls: 'sel', weightMm: 0.3, color, drawingId } as Primitive);
        for (const p of prims) {
          if (p.kind === 'line') mk(p.a, p.b, p.drawingId);
          else if (p.kind === 'polygon' && p.pts.length > 1) {
            for (let i = 0; i < p.pts.length; i++) mk(p.pts[i], p.pts[(i + 1) % p.pts.length], p.drawingId);
          }
        }
        highlightGeom.current = compilePrimitivesToGpu(gl, lines, lastPxPerMeter.current);
      }
      const del = gl.takeUploads();
      const hl = highlightGeom.current;
      let geom = null;
      if (hl) {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const e = gl.layoutOf(hl);
        e.line_batches = e.line_batches.map((b) => ({ ...b, stroke_mm: 2.5 * dpr, device_px: true }));
        geom = e;
      }
      void invoke('native2d_highlight', { geom, delete: del }).catch(() => {});
    },
    [],
  );

  const updateGeometry = useCallback((plan: Plan, pxPerMeter = 0) => {
    const cache = cacheRef.current;
    const gl = glRef.current;
    const invoke = invokeRef.current;
    if (!cache || !gl || !invoke || !plan) return;
    try {
      cache.update(
        plan.primitives,
        pxPerMeter,
        pxPerMeter > 0 ? Math.round(Math.log2(pxPerMeter)) : -Infinity,
        plan.greyedRanges,
        plan.underlay,
        plan.bufRuns,
      );
    } catch (e) {
      console.warn('Tessellierung fehlgeschlagen:', e);
      cache.dispose();
    }
    lastPxPerMeter.current = pxPerMeter;
    const { layout, delete: del, unchanged } = takeFullLayout();
    lastPlan.current = plan;
    // Direkt (nicht über sendFrame): Reihenfolge nach den Puffer-Uploads ist wichtig.
    // Unverändertes Layout (kein Chunk neu, nichts freigegeben) nicht erneut senden.
    if (!unchanged) {
      void invoke('native2d_layout', { layout, delete: del }).catch((e) =>
        console.debug('native2d_layout fehlgeschlagen', e),
      );
    }
    pushTexts(plan);
  }, [pushTexts, takeFullLayout]);

  const render = useCallback(
    (viewBox: ViewBox, paperScaleN = 100, _textScale?: number, onApplied?: () => void) => {
      const invoke = invokeRef.current;
      if (!invoke) {
        onApplied?.();
        return;
      }
      syncRect();
      const sheet = readCssColor('--sheet');
      sendFrame(() =>
        invoke('native2d_frame', {
          view: viewBox,
          paperScale: paperScaleN,
          clear: sheet ? [sheet[0], sheet[1], sheet[2]] : null,
        }).then(
          (r) => {
            onApplied?.();
            return r;
          },
          (e) => {
            onApplied?.();
            throw e;
          },
        ),
      );
    },
    [sendFrame, syncRect],
  );

  return { render, updateGeometry, ready, gpuTexts, setExcludedText, setHighlight };
}
