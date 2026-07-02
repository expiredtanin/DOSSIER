// Live-Spiegelung in die nativen wgpu-Fenster (src-tauri/src/native.rs): schiebt
// die AKTUELL sichtbare 2D-Szene bzw. die geflachten 3D-Wände debounced per
// Tauri-Command an die native Event-Loop. Es wird EXAKT dieselbe Ableitung
// benutzt wie für die Browser-Ansicht (planToRenderScene auf dem sichtbaren
// Plan, projectToWalls3d aufs Projekt) — 1:1-Parität inkl. Türschwenk,
// Fenster-Symbolen und Raumstempel-Text (echte Glyphen via GPU-Atlas in Rust).
//
// Im reinen Browser (kein Tauri) sind beide Funktionen No-ops: erkannt wird
// Tauri an `window.__TAURI_INTERNALS__`; Fehler beim Invoke werden still
// geschluckt (console.debug), damit die App nie daran scheitert.

import type { Plan } from "./generatePlan";
import type { Project } from "../model/types";
import { planToRenderScene } from "./toRenderScene";
import { projectToWalls3d } from "./toWalls3d";

/** Sammel-Fenster: Modelländerungen werden gebündelt gepusht (nicht je Frame). */
const DEBOUNCE_MS = 200;

/** Läuft die App in einer Tauri-Webview? (Sonst: reiner Browser, kein Invoke.) */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Geguardeter Invoke (Muster wie src/compute): nie werfen, Fehler nur debuggen. */
async function invokeNative(cmd: string, args: Record<string, unknown>): Promise<void> {
  try {
    // @ts-ignore optionales Paket
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core").catch(() => null);
    if (!mod || typeof (mod as any).invoke !== "function") return;
    await (mod as any).invoke(cmd, args);
  } catch (e) {
    console.debug(`nativeSync: ${cmd} fehlgeschlagen`, e);
  }
}

let sceneTimer: ReturnType<typeof setTimeout> | undefined;
let wallsTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced: den sichtbaren Plan (dasselbe Objekt wie in der PlanView) als
 * render2d-Szene ans native 2D-Fenster schieben. No-op ohne Tauri.
 */
export function pushNativeScene(plan: Plan): void {
  if (!isTauri()) return;
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => {
    void invokeNative("push_native_scene", { scene: planToRenderScene(plan) });
  }, DEBOUNCE_MS);
}

/**
 * Debounced: das 3D-Modell des Projekts (alle Geschosse, gestapelt) — Wände mit
 * Öffnungs-Teilquadern plus Deckenplatten — ans native 3D-Fenster schieben.
 * No-op ohne Tauri.
 */
export function pushNativeWalls(project: Project): void {
  if (!isTauri()) return;
  clearTimeout(wallsTimer);
  wallsTimer = setTimeout(() => {
    void invokeNative("push_native_walls", { walls: projectToWalls3d(project) });
  }, DEBOUNCE_MS);
}
