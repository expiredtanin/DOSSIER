// [118] Kamera-Anmeldung des 3D-Viewports, getrennt vom Lebenszyklus des GPU-Renderers.
//
// Der Orbit-Zustand gehört dem Viewport, nicht dem Renderer: `read`/`write` arbeiten auf ihm und zeichnen nur,
// wenn gerade ein Renderer lebt (`host.render` ist ohne Renderer ein No-op). So bleibt die Kamera lesbar und
// setzbar, solange der Viewport gemountet ist — auch bei Geräteverlust, Neuaufbau oder aufgegebenem WebGPU
// (Hinweis „3D nicht verfügbar“). `snapshot`/`image` liefern ohne Renderer null (wie dokumentiert).

import type { Camera3d } from "./useWasm3dRenderer";
import { camera3dFromViewCamera, lerpOrbit, orbitCamera, orbitFromCamera3d, type CapturedImage, type OrbitState, type ViewportCameraApi } from "./cameraBridge";
import type { ExportProgress } from "./imageExport";

export interface ViewportCameraHost {
  getOrbit(): OrbitState | null;
  setOrbit(o: OrbitState): void;
  /** Aktuelle Zeichenfläche (CSS-Pixel), oder null. */
  getRect(): { width: number; height: number } | null;
  /** Ab jetzt zeichnet der Orbit (nicht mehr die Rust-Preset-Kamera); ohne Renderer wirkungslos. */
  useOrbitRedraw(): void;
  /** Das Bild so zeichnen, wie es gerade angezeigt wird (ohne Renderer ein No-op). */
  redraw(): void;
  snapshot(maxEdge: number): Promise<Uint8Array | null>;
  exportImage(o: { camera: Camera3d; width: number; height: number; transparent: boolean; samples?: number } & ExportProgress): Promise<CapturedImage | null>;
  setSection(plane: { point: [number, number, number]; normal: [number, number, number] } | null): void;
  fit(): void;
  canvas(): HTMLCanvasElement | null;
}

/** Baut die Brücken-API; `dispose` bricht eine laufende Kamerafahrt ab. */
export function createViewportCameraApi(host: ViewportCameraHost): { api: ViewportCameraApi; dispose: () => void } {
  let anim = 0;
  const api: ViewportCameraApi = {
    read: () => {
      const o = host.getOrbit();
      const rect = host.getRect();
      if (!o || !rect || rect.width < 1 || rect.height < 1) return null;
      return { camera: orbitCamera(o), aspect: rect.width / rect.height };
    },
    write: (cam, animate) => {
      const to = orbitFromCamera3d(cam);
      if (!to) return false;
      cancelAnimationFrame(anim);
      const from = host.getOrbit();
      host.useOrbitRedraw();
      if (!animate || !from) {
        host.setOrbit(to);
        host.redraw();
        return true;
      }
      const t0 = performance.now();
      const DURATION = 350;
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / DURATION);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
        host.setOrbit(k >= 1 ? to : lerpOrbit(from, to, e));
        host.redraw();
        if (k < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
      return true;
    },
    snapshot: (maxEdge) => host.snapshot(maxEdge),
    image: (o) => {
      const cur = host.getOrbit();
      if (!cur || !host.getRect()) return Promise.resolve(null);
      // Gespeicherte Kamera ([213]) oder die Live-Kamera; das Blickziel liegt im Abstand der Live-Kamera.
      const cam = o.camera ? camera3dFromViewCamera(o.camera, cur.dist) : orbitCamera(cur);
      if (!cam) return Promise.resolve(null);
      return host.exportImage({
        camera: cam,
        width: o.width,
        height: o.height,
        transparent: o.transparent,
        ...(o.samples !== undefined ? { samples: o.samples } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    },
    section: (plane) => host.setSection(plane),
    fit: () => host.fit(),
    canvas: () => host.canvas(),
  };
  return { api, dispose: () => cancelAnimationFrame(anim) };
}

/**
 * [118] Was der Viewport tut, wenn ein Renderer bereit wird (erster Aufbau oder Neuaufbau nach Geräteverlust):
 * `preset` = Preset anwenden und den Orbit daraus neu setzen (erster Aufbau, Preset gewechselt, oder noch keine
 * Nutzerkamera: die Preset-Kamera lebt nur im Renderer); `redraw` = der Orbit (Standpunkt, Ziel, Projektion,
 * Begehen) bleibt, der neue Renderer zeichnet ihn nur.
 */
export function cameraAfterReady(s: { hasOrbit: boolean; appliedPreset: string | null; view3d: string; orbitMode: boolean }): "preset" | "redraw" {
  if (!s.hasOrbit || s.appliedPreset !== s.view3d) return "preset";
  return s.orbitMode ? "redraw" : "preset";
}
