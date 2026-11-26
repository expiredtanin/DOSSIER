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
 * Aufrufer (PlanView) behält dann den SVG-Pfad. Aufrufe, Neuaufbau nach Geräteverlust und
 * „letzte Szene gewinnt" regelt `WasmPlanRendererSession` (wasmRendererSession.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan } from "../../core";
import { planSceneBin } from "../../core";
import { loadFontFile } from "../../text/glyphFonts";
import { type WebPlanRendererLike, WasmPlanRendererSession } from "./wasmRendererSession";

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
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
      const mod: any = await import("../../engine/pkg/render2d.js");
      await mod.default(); // lädt render2d_bg.wasm
      return mod;
    })();
    // Fehlgeschlagenes Laden nicht für immer merken.
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

/**
 * [333] Geparkte Renderer: Schliesst sich eine Plan-Ansicht (Tab-Wechsel), wird ihr Renderer nicht freigegeben,
 * sondern aufbewahrt; die nächste Plan-Ansicht hängt ihn an ihren Canvas (`attach_canvas`) statt ein neues
 * WebGPU-Gerät anzufordern (das kostete beim Wechsel zurück zum Plan den grössten Teil von ~0.35 s). Höchstens
 * {@link PARK_MAX} (Grundriss, Schnitt, Ansicht nebeneinander), nach {@link PARK_MS} freigegeben.
 */
const PARK_MAX = 3;
const PARK_MS = 5 * 60_000;
const parked: { r: WebPlanRendererLike; timer: ReturnType<typeof setTimeout> }[] = [];

function freeQuietly(r: WebPlanRendererLike): void {
  try {
    r.free?.();
  } catch {
    /* bereits unbrauchbar */
  }
}

function park(r: WebPlanRendererLike): void {
  if (typeof r.attach_canvas !== "function") {
    freeQuietly(r);
    return;
  }
  const entry = {
    r,
    timer: setTimeout(() => {
      const i = parked.indexOf(entry);
      if (i >= 0) parked.splice(i, 1);
      freeQuietly(r);
    }, PARK_MS),
  };
  parked.push(entry);
  while (parked.length > PARK_MAX) {
    const old = parked.shift()!;
    clearTimeout(old.timer);
    freeQuietly(old.r);
  }
}

/** Einen geparkten Renderer an `canvas` hängen; null, wenn keiner da ist oder das Anhängen scheitert. */
function unpark(canvas: HTMLCanvasElement): WebPlanRendererLike | null {
  for (let e = parked.pop(); e; e = parked.pop()) {
    clearTimeout(e.timer);
    try {
      if (e.r.is_lost()) throw new Error("verloren");
      e.r.attach_canvas!(canvas);
      return e.r;
    } catch {
      freeQuietly(e.r);
    }
  }
  return null;
}

/** Neuen Renderer auf dem Canvas erzeugen (auch nach Geräteverlust: derselbe Canvas-Kontext) oder einen geparkten anhängen. */
async function createRenderer(canvas: HTMLCanvasElement): Promise<WebPlanRendererLike> {
  const mod = await loadEngine();
  // Canvas VOR dem Surface-Erzeugen auf die Zielpixel (DPR) bringen.
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  return unpark(canvas) ?? ((await mod.WebPlanRenderer.new(canvas, undefined)) as WebPlanRendererLike);
}

/**
 * Sitzung je Canvas EINMAL (memoisiert). Ein Canvas trägt EINEN WebGPU-Kontext; die Sitzung
 * ist der einzige Besitzer des Renderers (Neuaufbau nach Ausfall inbegriffen), damit der
 * StrictMode-Doppelmount nicht zwei Renderer auf denselben Kontext setzt.
 */
interface CanvasSession {
  session: WasmPlanRendererSession<Plan>;
  listeners: Set<(ready: boolean) => void>;
}
const sessions = new WeakMap<HTMLCanvasElement, CanvasSession>();
function sessionFor(canvas: HTMLCanvasElement): CanvasSession {
  let cs = sessions.get(canvas);
  if (!cs) {
    const listeners = new Set<(ready: boolean) => void>();
    const session = new WasmPlanRendererSession<Plan>({
      create: () => createRenderer(canvas),
      encode: (plan) => planSceneBin(plan),
      loadFont: (key) => loadFontFile(key),
      onReadyChange: (r) => listeners.forEach((l) => l(r)),
      park,
    });
    cs = { session, listeners };
    sessions.set(canvas, cs);
  }
  return cs;
}

export function useWasmPlanRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const [session, setSession] = useState<WasmPlanRendererSession<Plan> | null>(null);
  const [ready, setReady] = useState(false);

  // Sitzung an das Canvas binden (memoisiert, StrictMode-fest).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enabled || !canvas) {
      setReady(false);
      return;
    }
    const cs = sessionFor(canvas);
    cs.listeners.add(setReady);
    setSession(cs.session);
    setReady(cs.session.ready);
    cs.session.start();
    return () => {
      cs.listeners.delete(setReady);
      setSession(null);
      setReady(false);
      // [206] Canvas wirklich weg (kein Wiedereinhängen wie beim StrictMode-Doppelmount): Renderer freigeben,
      // sonst lebte das WebGPU-Gerät bis zur Speicherbereinigung weiter.
      setTimeout(() => {
        if (cs.listeners.size === 0 && sessions.get(canvas) === cs) {
          sessions.delete(canvas);
          cs.session.dispose();
        }
      }, 0);
    };
  }, [enabled, canvasRef]);

  /**
   * Szene beim Plan-Wechsel setzen (re-tesselliert in Rust). Gleicher Plan → kein erneutes
   * Hochladen; während eines Neuaufbaus gemerkt (die letzte Szene gewinnt).
   */
  const updateGeometry = useCallback(
    (plan: Plan) => {
      if (session && plan) session.setScene(plan);
    },
    [session],
  );

  /**
   * Einen Frame zeichnen (Canvas-Größe + dpr hier abgleichen). `textScaleN`
   * bewusst getrennt von `paperScaleN`: er treibt NUR die Schriftgröße der
   * Raumstempel (spiegelt die SVG-Formel — feste Referenzskala 1:100 im
   * Anzeigemodus, siehe PlanView.tsx `textScaleForGl`), während `paperScaleN`
   * weiter die echten Papier-mm-Strichbreiten der Geometrie treibt.
   */
  // Plot-Massstab der Strichmuster (`setDashScale`), beim nächsten Frame übernommen.
  const dashScaleRef = useRef(0);
  const setDashScale = useCallback((n: number) => {
    dashScaleRef.current = n > 0 && isFinite(n) ? n : 0;
  }, []);
  const render = useCallback(
    (viewBox: ViewBox, paperScaleN = 100, textScaleN = 100) => {
      const canvas = canvasRef.current;
      if (!session || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      session.draw({ viewBox, paperScaleN, textScaleN, dashScaleN: dashScaleRef.current, width, height });
    },
    [canvasRef, session],
  );

  return { render, updateGeometry, ready, setDashScale };
}
