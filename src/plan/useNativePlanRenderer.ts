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
import type { Plan } from './generatePlan';
import { GpuChunkCache, type ViewBox } from './glPlan';
import { NativeGl, type NativeInvoke } from './glPlan/nativeGl';
import { readCssColor } from './useGlPlanRenderer';
import { NativeTextSync } from './nativeText';

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
  const excludedText = useRef<string | null>(null);

  const pushTexts = useCallback((plan: Plan | null) => {
    const invoke = invokeRef.current;
    if (!invoke || !plan || textsDisabled.current) return;
    const { upsert, remove } = textSync.current.delta(plan.primitives, excludedText.current);
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
      );
    } catch (e) {
      console.warn('Tessellierung fehlgeschlagen:', e);
      cache.dispose();
    }
    const { layout, delete: del } = gl.takeLayout(cache.geometries);
    lastPlan.current = plan;
    // Direkt (nicht über sendFrame): Reihenfolge nach den Puffer-Uploads ist wichtig.
    void invoke('native2d_layout', { layout, delete: del }).catch((e) =>
      console.debug('native2d_layout fehlgeschlagen', e),
    );
    pushTexts(plan);
  }, [pushTexts]);

  const render = useCallback(
    (viewBox: ViewBox, paperScaleN = 100) => {
      const invoke = invokeRef.current;
      if (!invoke) return;
      syncRect();
      const sheet = readCssColor('--sheet');
      sendFrame(() =>
        invoke('native2d_frame', {
          view: viewBox,
          paperScale: paperScaleN,
          clear: sheet ? [sheet[0], sheet[1], sheet[2]] : null,
        }),
      );
    },
    [sendFrame, syncRect],
  );

  return { render, updateGeometry, ready, gpuTexts, setExcludedText };
}
