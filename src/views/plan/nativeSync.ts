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

import type { Plan } from "../../core";
import { materializeGreyed, materializeUnderlay } from "../../core";
import type { Project } from "../../model/types";
import { planToRenderScene } from "../../core";
import { projectToModel3d, TRUCK_MESH_READY_EVENT } from "../../core";

/** Sammel-Fenster: Modelländerungen werden gebündelt gepusht (nicht je Frame). */
const DEBOUNCE_MS = 200;

/** Läuft die App in einer Tauri-Webview? (Sonst: reiner Browser, kein Invoke.) */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Gibt es in diesem Build überhaupt ein natives Fenster (Rust-Features
 * native2d/native3d)? Einmal beim ersten Push erfragt. Ohne diese Prüfung
 * wurde bei JEDER Planänderung die komplette Szene in JS umgewandelt und per
 * IPC an einen Befehl geschickt, den es im Standard-Build nicht gibt —
 * bei einem Kataster-Import (3,7 Mio. Primitive) mehrere Sekunden
 * Hauptthread-Arbeit, nur um dann zu scheitern. Fehlt der Befehl selbst
 * (älterer Build), gilt das ebenfalls als "nein".
 */
let nativeEnabled: Promise<boolean> | null = null;
function isNativeEnabled(): Promise<boolean> {
  nativeEnabled ??= (async () => {
    try {
      // @ts-ignore optionales Paket
      const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core").catch(() => null);
      if (!mod || typeof (mod as any).invoke !== "function") return false;
      return (await (mod as any).invoke("native_viewport_enabled")) === true;
    } catch {
      return false;
    }
  })();
  return nativeEnabled;
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
  sceneTimer = setTimeout(async () => {
    if (!(await isNativeEnabled())) return;
    // planToRenderScene liest `greyed` am Primitiv → gedimmte Referenz-Ebenen materialisieren.
    void invokeNative("push_native_scene", { scene: planToRenderScene(materializeGreyed(materializeUnderlay(plan), true)) });
  }, DEBOUNCE_MS);
}

/**
 * Debounced: das 3D-Modell des Projekts (alle Geschosse, gestapelt) — Wände mit
 * Öffnungs-Teilquadern plus Deckenplatten — ans native 3D-Fenster schieben.
 * No-op ohne Tauri.
 */
export function pushNativeWalls(project: Project): void {
  if (!isTauri()) return;
  lastProject = project;
  clearTimeout(wallsTimer);
  wallsTimer = setTimeout(async () => {
    if (!(await isNativeEnabled())) return;
    void invokeNative("push_native_walls", { walls: projectToModel3d(project, { voids: true }) });
  }, DEBOUNCE_MS);
}

/** Letztes an {@link pushNativeWalls} übergebenes Projekt (für den Re-Push unten). */
let lastProject: Project | null = null;

// truck-Extrusionen (s. toWalls3d.ts emitExtrudedSolids) laden WASM asynchron;
// ohne diesen Re-Push nach Abschluss bliebe eine fertige Extrusion im nativen
// Fenster unsichtbar, weil `pushNativeWalls` nur bei Projektänderungen läuft.
if (typeof window !== "undefined") {
  window.addEventListener(TRUCK_MESH_READY_EVENT, () => {
    if (lastProject) pushNativeWalls(lastProject);
  });
}
