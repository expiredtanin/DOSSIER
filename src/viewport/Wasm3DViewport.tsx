// 3D-Viewport auf der nativen Engine: render3d (Rust/wgpu) als WASM/WebGPU-
// Canvas. Aktiv hinter demselben Engine-Umschalter wie die 2D-Plan-Ansicht
// (`?engine=wasm` bzw. Statusleisten-Wahl, siehe Viewport3D.tsx); die three.js-
// Sicht bleibt der unveränderte Standardpfad.
//
// INTEGRATIONS-SPIKE (Umfang bewusst schmal): Massenmodell (Wände mit Öffnungs-
// Teilquadern + Deckenplatten, alle Geschosse gestapelt) + Orbit-Navigation.
// Auswahl/Raycast, Render-Modi, Kamera-Presets und Editier-Griffe der three.js-
// Sicht folgen später — bis dahin gilt: LINKS ohne Funktion, RECHTS unterdrückt
// nur das Browser-Menü.
//
// MAUS-SCHEMA wie die three.js-Sicht (docs/design/context-menu.md):
//   MITTE ziehen = Orbit, Shift+MITTE = Pan, RAD = Zoom.
// Die Orbit-/Pan-Mathematik folgt den OrbitControls-Konventionen (Winkel je
// Pixel an der Viewport-Höhe normiert), damit sich beide Pfade gleich anfühlen.

import { useEffect, useRef } from "react";
import type { Project } from "../model/types";
import { projectToModel3d } from "../plan/toWalls3d";
import { t } from "../i18n";
import { useWasm3dRenderer } from "./useWasm3dRenderer";
import type { Camera3d } from "./useWasm3dRenderer";

/** Vertikaler Öffnungswinkel (Radiant) — wie die three.js-PerspectiveCamera (50°). */
const FOV_Y = (50 * Math.PI) / 180;
/** Pitch-Klemme gegen den Gimbal-Flip (identisch zu render3d::math::orbit_eye). */
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Orbit-Zustand der Kamera: Kugelkoordinaten um ein Blickziel (world, Y-up). */
interface OrbitState {
  /** Azimut um die Y-Achse (Radiant). */
  yaw: number;
  /** Erhebung über die XZ-Ebene (Radiant, geklemmt). */
  pitch: number;
  /** Abstand vom Ziel (Meter). */
  dist: number;
  /** Blickziel (world). */
  target: [number, number, number];
}

/** Fertige Kamera aus dem Orbit-Zustand (Konvention wie render3d::math::orbit_eye). */
function orbitCamera(o: OrbitState): Camera3d {
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
  const r = o.dist * Math.cos(pitch);
  return {
    eye: [
      o.target[0] + r * Math.cos(o.yaw),
      o.target[1] + o.dist * Math.sin(pitch),
      o.target[2] + r * Math.sin(o.yaw),
    ],
    target: [o.target[0], o.target[1], o.target[2]],
    up: [0, 1, 0],
    perspective: true,
    fovY: FOV_Y,
    orthoHalfHeight: o.dist * 0.5,
  };
}

/**
 * Formatfüllender Start-Orbit: Bounding-Box des geflachten Modells (Wände +
 * Decken, world: x = Modell-x, z = Modell-y, y = Höhe) einpassen — Blick von
 * schräg oben (wie das Persp-Preset), Distanz aus Radius + Sichtwinkel.
 */
function fitOrbit(project: Project): OrbitState {
  const model = projectToModel3d(project);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const grow = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const w of model.walls) {
    grow(w.start[0], w.baseElevation, w.start[1]);
    grow(w.end[0], w.baseElevation + w.height, w.end[1]);
  }
  for (const s of model.slabs) {
    for (const p of s.outline) {
      grow(p[0], s.zBottom, p[1]);
      grow(p[0], s.zTop, p[1]);
    }
  }
  // Leeres Modell: neutraler Standpunkt (entspricht dem three.js-Start).
  if (!Number.isFinite(minX)) {
    return { yaw: Math.PI / 4, pitch: 0.5, dist: 14, target: [2.5, 1, 2] };
  }
  const target: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const radius =
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 || 1;
  // Abstand so, dass die Bounding-Kugel ins vertikale Sichtfeld passt (+ Rand).
  const dist = Math.max(4, (radius / Math.tan(FOV_Y / 2)) * 1.2);
  return { yaw: Math.PI / 4, pitch: 0.5, dist, target };
}

export function Wasm3DViewport({ project }: { project: Project }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { render, updateModel, ready, failed } = useWasm3dRenderer(canvasRef, true);
  // Orbit-Zustand in einem Ref (kein React-State): Mausbewegungen zeichnen
  // direkt neu, ohne die Komponente je Frame zu re-rendern.
  const orbitRef = useRef<OrbitState | null>(null);
  // Frisches Projekt für den (stabilen) Init-Effekt unten.
  const projectRef = useRef(project);
  projectRef.current = project;

  // Modell bei Bereitschaft + jeder Projektänderung neu einspielen. Der Orbit
  // wird nur beim ERSTEN Mal eingepasst — danach bleibt die Kamera beim
  // Editieren stehen (gleiches Verhalten wie der three.js-Kamera-Snapshot).
  useEffect(() => {
    if (!ready) return;
    updateModel(project);
    if (!orbitRef.current) orbitRef.current = fitOrbit(project);
    render(orbitCamera(orbitRef.current));
  }, [ready, project, updateModel, render]);

  // Canvas-Größe beobachten: bei Layout-Änderung mit aktueller Kamera neu
  // zeichnen (die Surface-Anpassung übernimmt der Hook im render()).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    const ro = new ResizeObserver(() => {
      if (orbitRef.current) render(orbitCamera(orbitRef.current));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ready, render]);

  // Maus-Navigation (MITTE = Orbit, Shift+MITTE = Pan, RAD = Zoom).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;

    let drag: { mode: "orbit" | "pan"; x: number; y: number } | null = null;

    const redraw = () => {
      if (orbitRef.current) render(orbitCamera(orbitRef.current));
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 1) return; // nur MITTE navigiert (links = Auswahl, s. o.)
      e.preventDefault();
      drag = { mode: e.shiftKey ? "pan" : "orbit", x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      const o = orbitRef.current;
      if (!drag || !o) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const h = canvas.clientHeight || 1;
      if (drag.mode === "orbit") {
        // Winkel je Pixel wie OrbitControls: voller Umlauf über die Viewport-Höhe.
        o.yaw += (2 * Math.PI * dx) / h;
        o.pitch = Math.max(
          -PITCH_LIMIT,
          Math.min(PITCH_LIMIT, o.pitch + (2 * Math.PI * dy) / h),
        );
      } else {
        // Pan in der Bildebene: Welt-Meter je Pixel aus Distanz + Sichtwinkel;
        // Ziel entgegen der Mausrichtung verschieben (Szene folgt dem Cursor).
        const worldPerPx = (2 * o.dist * Math.tan(FOV_Y / 2)) / h;
        const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
        // Kamera-Basis aus dem Orbit: f = Blickrichtung, s = rechts, u = Kamera-oben.
        const f = [
          -Math.cos(pitch) * Math.cos(o.yaw),
          -Math.sin(pitch),
          -Math.cos(pitch) * Math.sin(o.yaw),
        ];
        const s = [Math.sin(o.yaw), 0, -Math.cos(o.yaw)];
        const u = [
          s[1] * f[2] - s[2] * f[1],
          s[2] * f[0] - s[0] * f[2],
          s[0] * f[1] - s[1] * f[0],
        ];
        o.target[0] += (-s[0] * dx + u[0] * dy) * worldPerPx;
        o.target[1] += (-s[1] * dx + u[1] * dy) * worldPerPx;
        o.target[2] += (-s[2] * dx + u[2] * dy) * worldPerPx;
      }
      redraw();
    };

    const endDrag = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };

    const onWheel = (e: WheelEvent) => {
      const o = orbitRef.current;
      if (!o) return;
      e.preventDefault();
      // Exponentielles Dolly (rad-deltaY ≈ ±100 je Rastung → ~14 % je Schritt).
      o.dist = Math.max(0.2, Math.min(2000, o.dist * Math.exp(e.deltaY * 0.0013)));
      redraw();
    };

    // Browser-Kontextmenü unterdrücken (RECHTS ist fürs App-Menü reserviert).
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [ready, render]);

  return (
    <div className="viewport">
      {/* Canvas-Anzeigegröße kommt aus `.viewport canvas` (styles.css); die
          Renderauflösung (DPR) gleicht der Hook je Frame ab. */}
      <canvas ref={canvasRef} data-engine="render3d" />
      {failed && (
        <div className="viewport-fallback">
          <strong>{t("viewport3d.engineUnavailable")}</strong>
          <span>{t("viewport3d.engineUnavailableHint")}</span>
        </div>
      )}
    </div>
  );
}
