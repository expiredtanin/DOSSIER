// [213] Kamera-Element (`Project.cameras`) ↔ Sicht des 3D-Viewports. Reine Funktionen, ohne React und Engine.
//
// `cameraToView` liefert dieselbe Struktur wie die aktive 3D-Ansicht (`getCamera()` der `cameraBridge`: Modell-
// Koordinaten, z oben) — damit setzt „Kamera öffnen" den Viewport exakt, und das Rendering ([211]) kann eine
// gespeicherte Kamera wie die Live-Ansicht verwenden. `cameraFromView` legt umgekehrt aus der Live-Ansicht ein
// Kamera-Element an (Standpunkt → Geschoss + Augenhöhe).

import type { Camera, DrawingLevel, Project, Vec2 } from "../model/types";
import { CAMERA_CATEGORY } from "../model/derivedCategories";
import type { V3, ViewCamera } from "./cameraBridge";

/** Vorgaben wie im Kern (`camera.rs`). */
export const DEFAULT_EYE_HEIGHT = 1.6;
export const DEFAULT_FOV_DEG = 50;
export const DEFAULT_ORTHO_HEIGHT = 10;
export const MIN_FOV_DEG = 5;
export const MAX_FOV_DEG = 120;
/** Sensorhöhe für die Kleinbild-Brennweite (mm), wie im Kern. */
export const SENSOR_HEIGHT_MM = 24;
/** Blickweite beim Anlegen aus einer Ansicht, wenn der Viewport keinen Zielabstand meldet (m). */
export const DEFAULT_AIM_DISTANCE = 10;

/** Kleinbild-Brennweite (mm) zum vertikalen Bildwinkel (Grad). */
export function focalFromFov(fovDeg: number): number {
  return SENSOR_HEIGHT_MM / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** Vertikaler Bildwinkel (Grad) zur Kleinbild-Brennweite (mm). */
export function fovFromFocal(mm: number): number {
  return (2 * Math.atan(SENSOR_HEIGHT_MM / 2 / mm) * 180) / Math.PI;
}

export function clampFov(fovDeg: number): number {
  return Number.isFinite(fovDeg) && fovDeg > 0 ? Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, fovDeg)) : DEFAULT_FOV_DEG;
}

const finite = (...v: number[]): boolean => v.every(Number.isFinite);

/** Höhe der Geschoss-OK (m), 0 ohne Angabe. */
export function floorBase(project: Project, floorId: string): number {
  const z = project.drawingLevels.find((l) => l.id === floorId)?.baseElevation;
  return typeof z === "number" && Number.isFinite(z) ? z : 0;
}

/** Augpunkt der Kamera in Modell-Koordinaten (Meter, z oben). */
export function cameraEye(project: Project, cam: Camera): V3 {
  return [cam.position.x, cam.position.y, floorBase(project, cam.floorId) + (Number.isFinite(cam.eyeHeight) ? cam.eyeHeight : DEFAULT_EYE_HEIGHT)];
}

/** Ziel der Kamera in Modell-Koordinaten. */
export function cameraTarget(cam: Camera): V3 {
  return [cam.target.x, cam.target.y, cam.targetHeight];
}

/**
 * Die Sicht der Kamera: Standpunkt, normierte Blickrichtung und Up-Vektor (senkrecht zur Blickrichtung, aus der
 * Modell-Senkrechten; bei exakt senkrechtem Blick gilt die Grundriss-Richtung „oben = Norden"). Perspektive →
 * `perspective`, Axonometrie und Parallel → `orthogonal`. Null bei Standpunkt = Ziel oder nicht endlichen Zahlen.
 */
export function cameraToView(project: Project, cam: Camera, aspect = 16 / 9): ViewCamera | null {
  const eye = cameraEye(project, cam);
  const tgt = cameraTarget(cam);
  if (!finite(...eye, ...tgt)) return null;
  const d: V3 = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-9)) return null;
  const dir: V3 = [d[0] / len, d[1] / len, d[2] / len];
  // Up aus der Modell-Senkrechten; ist der Blick (fast) senkrecht, aus der Nordrichtung.
  const ref: V3 = Math.abs(dir[2]) > 0.9999 ? [0, 1, 0] : [0, 0, 1];
  const k = ref[0] * dir[0] + ref[1] * dir[1] + ref[2] * dir[2];
  const upRaw: V3 = [ref[0] - dir[0] * k, ref[1] - dir[1] * k, ref[2] - dir[2] * k];
  const ul = Math.hypot(upRaw[0], upRaw[1], upRaw[2]);
  const up: V3 = [upRaw[0] / ul, upRaw[1] / ul, upRaw[2] / ul];
  const ortho = cam.projection !== "perspective";
  return {
    kind: ortho ? "orthogonal" : "perspective",
    position: eye,
    direction: dir,
    up,
    fovDeg: clampFov(cam.fovDeg),
    orthoHeight: cam.orthoHeight && cam.orthoHeight > 0 ? cam.orthoHeight : DEFAULT_ORTHO_HEIGHT,
    aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9,
  };
}

/** Geschoss, auf dem ein Standpunkt der Höhe `z` steht: das höchste Geschoss mit OK ≤ z (sonst das unterste, sonst `fallback`). */
export function floorForHeight(project: Project, z: number, fallback: string): string {
  const floors = project.drawingLevels.filter((l: DrawingLevel) => l.kind === "floor");
  if (!floors.length || !Number.isFinite(z)) return fallback;
  const base = (l: DrawingLevel) => (typeof l.baseElevation === "number" && Number.isFinite(l.baseElevation) ? l.baseElevation : 0);
  const sorted = [...floors].sort((a, b) => base(a) - base(b));
  let hit = sorted[0];
  for (const l of sorted) if (base(l) <= z + 1e-6) hit = l;
  return hit.id;
}

/** Nächster freier Name „Kamera 1", „Kamera 2" … (`label` = Namensstamm). */
export function nextCameraName(project: Project, label: string): string {
  const used = new Set((project.cameras ?? []).map((c) => c.name));
  for (let n = 1; ; n++) if (!used.has(`${label} ${n}`)) return `${label} ${n}`;
}

export interface CameraFromViewOptions {
  id: string;
  name: string;
  /** Geschoss des Symbols; fehlt = das Geschoss, auf dem der Standpunkt steht. */
  floorId?: string;
  /** Rückfall-Geschoss, wenn das Projekt kein Geschoss kennt (aktive Ebene). */
  fallbackFloorId: string;
  /** Abstand des Ziels vom Standpunkt (m); fehlt = 10 m (orthografisch: die Sichthöhe). */
  distance?: number;
  categoryCode?: string;
}

/**
 * Kamera-Element aus der Sicht des Viewports (Modell-Koordinaten): Standpunkt → Geschoss + Augenhöhe, Ziel auf
 * der Blickachse im Abstand `distance`. Orthografische Sichten werden zu „parallel" (das Preset-Verhalten der
 * Axonometrie ist eine Ausrichtung, kein eigener Zustand der Sicht).
 */
export function cameraFromView(project: Project, view: ViewCamera, o: CameraFromViewOptions): Camera {
  const [px, py, pz] = view.position;
  const floorId = o.floorId ?? floorForHeight(project, pz, o.fallbackFloorId);
  const ortho = view.kind === "orthogonal";
  const dist = o.distance !== undefined && Number.isFinite(o.distance) && o.distance > 0 ? o.distance : ortho ? Math.max(view.orthoHeight, 1) : DEFAULT_AIM_DISTANCE;
  const target: Vec2 = { x: px + view.direction[0] * dist, y: py + view.direction[1] * dist };
  const cam: Camera = {
    id: o.id,
    type: "camera",
    name: o.name,
    floorId,
    categoryCode: o.categoryCode ?? CAMERA_CATEGORY,
    position: { x: px, y: py },
    eyeHeight: pz - floorBase(project, floorId),
    target,
    targetHeight: pz + view.direction[2] * dist,
    fovDeg: clampFov(view.fovDeg),
    projection: ortho ? "parallel" : "perspective",
  };
  if (ortho) cam.orthoHeight = view.orthoHeight;
  return cam;
}

/** Axonometrie-Ausrichtung („Isometrie"): Blick aus Südwest von oben (45° Azimut, 35.264° Neigung) auf dasselbe Ziel. */
export function isometricAim(project: Project, cam: Camera): Pick<Camera, "position" | "eyeHeight"> {
  const eye = cameraEye(project, cam);
  const tgt = cameraTarget(cam);
  const dist = Math.max(Math.hypot(tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]), 5);
  const pitch = Math.atan(1 / Math.SQRT2);
  const horiz = dist * Math.cos(pitch);
  const from: V3 = [tgt[0] - horiz * Math.SQRT1_2, tgt[1] - horiz * Math.SQRT1_2, tgt[2] + dist * Math.sin(pitch)];
  return { position: { x: from[0], y: from[1] }, eyeHeight: from[2] - floorBase(project, cam.floorId) };
}
