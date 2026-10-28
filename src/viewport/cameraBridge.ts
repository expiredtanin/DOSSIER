// Kamera-Brücke des 3D-Viewports (BCF-Viewpoints, später Szenen/Animation): Lesen und Setzen der
// Orbit-Kamera von aussen, Schnappschuss des 3D-Bildes, Live-Schnittebene von aussen.
//
// AUSSENSICHT = MODELL-Koordinaten: x/y Grundriss, z = Höhe, Meter, rechtshändig wie das IFC im
// Export (`exportIfc.ts` schreibt Modell-(x, y, Höhe) unverändert; mit Standort-Bezug kommt nur
// der LV95-Versatz hinzu, s. `panels/bcfView.ts`). INNENSICHT = render3d-world, Y-oben.
//
// ACHSABBILDUNG: Wände, Decken, Dächer, Zeichnungs-Spuren, Treppen und Stützen liegen im Viewport
// als world = (x, Höhe, y) (`fitTargetDist` in `Wasm3DViewport`, `emitDrawingLineVerts`,
// render3d `mesh.rs`: `start[1]` wird zu world-z). Die Abbildung ist ein Tausch von y und z und
// damit ihre eigene Umkehrung. Geo-Rohdaten (Gelände, Punktwolken) negieren dagegen y
// (world = (x, z, −y), `append_context_mesh`) — für die Kamera zählt die Abbildung der
// Bauteile, weil nur diese im IFC-Export stehen. `cameraBridge.test.ts` belegt die Abbildung
// gegen `projectToModel3d`.
//
// Der Viewport (`Wasm3DViewport`) meldet sich beim Einhängen an (`registerViewportCamera`) und
// ab, wenn er verschwindet. Ohne Viewport (kein 3D geöffnet, nativer macOS-Pfad) liefern
// `getCamera`/`captureSnapshot` null und `setCamera` false — kein Fehler.

import type { Camera3d } from "./useWasm3dRenderer";

export type V3 = [number, number, number];

/** Vertikaler Öffnungswinkel der freien Orbit-Kamera (wie render3d `default_fov`: 50°). */
export const FOV_Y = (50 * Math.PI) / 180;
/** Pitch-Klemme gegen den Gimbal-Flip. Knapp unter dem Pol (0,006°), damit senkrechte Blicke von
 *  oben/unten (Grundriss-Viewpoints aus BCF) praktisch exakt bleiben; ein Flip tritt erst AM Pol auf,
 *  `look_at` mit Up (0,1,0) bleibt hier stabil (Querprodukt ~1e-4, weit über der f32-Genauigkeit).
 *  (Das native `render3d::math::orbit_eye` klemmt weiter bei 0,01 rad — eigener Pfad.) */
export const PITCH_LIMIT = Math.PI / 2 - 1e-4;

/** Orbit-Zustand der Kamera: Kugelkoordinaten um ein Blickziel (world, Y-oben). */
export interface OrbitState {
  /** Azimut um die Y-Achse (Radiant). */
  yaw: number;
  /** Erhebung über die XZ-Ebene (Radiant, geklemmt). */
  pitch: number;
  /** Abstand vom Ziel (Meter). */
  dist: number;
  /** Blickziel (world). */
  target: V3;
  /** Soll die freie Kamera orthografisch bleiben? (Presets ausser `perspective`.) */
  ortho: boolean;
  /** Orthografische Bild-Halbhöhe (Meter), unabhängig von `dist` geführt. */
  orthoHalfHeight: number;
  /** Vertikaler Öffnungswinkel (Radiant); fehlt = `FOV_Y`. Gesetzt von `setCamera` (BCF). */
  fovY?: number;
}

/** Kamera in MODELL-Koordinaten (Meter, z oben) — die Sprache der Aussenwelt (BCF u. a.). */
export interface ViewCamera {
  kind: "perspective" | "orthogonal";
  position: V3;
  /** Blickrichtung, normiert. */
  direction: V3;
  /** Up-Vektor, normiert und senkrecht zur Blickrichtung. */
  up: V3;
  /** Vertikaler Öffnungswinkel in Grad (perspektivisch). */
  fovDeg: number;
  /** Sichthöhe in Metern (orthografisch; volle Höhe, nicht halbe). */
  orthoHeight: number;
  /** Bildverhältnis Breite/Höhe des Viewports. */
  aspect: number;
}

/** Live-Schnittebene in MODELL-Koordinaten; `direction` zeigt auf die weggeschnittene Seite. */
export interface ViewSection {
  location: V3;
  direction: V3;
}

// ── Achsabbildung ───────────────────────────────────────────────────────────

/** Modell (x, y, z=Höhe) → render3d-world (x, Höhe, y). */
export const modelToWorld = (p: readonly number[]): V3 => [p[0], p[2], p[1]];
/** render3d-world → Modell; derselbe Tausch, also die eigene Umkehrung. */
export const worldToModel = (p: readonly number[]): V3 => [p[0], p[2], p[1]];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
function norm(a: V3): V3 | null {
  const l = len(a);
  return l > 1e-12 && Number.isFinite(l) ? scale(a, 1 / l) : null;
}
const finite3 = (a: readonly number[]): boolean => a.length >= 3 && a.slice(0, 3).every(Number.isFinite);

// ── Orbit ↔ Kamera ──────────────────────────────────────────────────────────

/** Fertige Kamera aus dem Orbit-Zustand (Konvention wie render3d::math::orbit_eye). */
export function orbitCamera(o: OrbitState): Camera3d {
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
    perspective: !o.ortho,
    fovY: o.fovY ?? FOV_Y,
    orthoHalfHeight: o.orthoHalfHeight,
  };
}

/** Orbit-Zustand aus einer fertigen Kamera (Umkehrung von `orbitCamera`; Roll geht verloren). */
export function orbitFromCamera3d(cam: Camera3d): OrbitState | null {
  const d = norm(sub(cam.target, cam.eye));
  if (!d || !finite3(cam.eye) || !finite3(cam.target)) return null;
  const dist = len(sub(cam.target, cam.eye));
  // eye = target − dist·d, und orbit_eye: eye − target = dist·(cos p·cos yaw, sin p, cos p·sin yaw)
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, -d[1])))));
  const yaw = Math.hypot(d[0], d[2]) < 1e-9 ? Math.PI / 2 : Math.atan2(-d[2], -d[0]);
  return {
    yaw,
    pitch,
    dist,
    target: [cam.target[0], cam.target[1], cam.target[2]],
    ortho: !cam.perspective,
    orthoHalfHeight: cam.orthoHalfHeight,
    fovY: cam.fovY,
  };
}

/** Zwischenstand für sanfte Kamerafahrten: Winkel auf kürzestem Weg, Rest linear. */
export function lerpOrbit(a: OrbitState, b: OrbitState, t: number): OrbitState {
  const l = (x: number, y: number) => x + (y - x) * t;
  let dyaw = b.yaw - a.yaw;
  dyaw = ((((dyaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return {
    yaw: a.yaw + dyaw * t,
    pitch: l(a.pitch, b.pitch),
    dist: l(a.dist, b.dist),
    target: [l(a.target[0], b.target[0]), l(a.target[1], b.target[1]), l(a.target[2], b.target[2])],
    ortho: t < 1 ? a.ortho : b.ortho,
    orthoHalfHeight: l(a.orthoHalfHeight, b.orthoHalfHeight),
    fovY: l(a.fovY ?? FOV_Y, b.fovY ?? FOV_Y),
  };
}

// ── Kamera ↔ Modell-Sicht ───────────────────────────────────────────────────

/** Kamera des Viewports (world, Y-oben) → Modell-Koordinaten (z oben). Null bei entarteter Kamera. */
export function viewCameraFromCamera3d(cam: Camera3d, aspect: number): ViewCamera | null {
  const dirW = norm(sub(cam.target, cam.eye));
  if (!dirW || !finite3(cam.eye) || !finite3(cam.up)) return null;
  // Up orthogonalisieren: der Orbit liefert (0,1,0), das ist bei geneigtem Blick nicht senkrecht.
  const upRaw = sub(cam.up, scale(dirW, dot(cam.up, dirW)));
  const upW = norm(upRaw) ?? norm(sub([0, 1, 0], scale(dirW, dirW[1])));
  if (!upW) return null;
  return {
    kind: cam.perspective ? "perspective" : "orthogonal",
    position: worldToModel(cam.eye),
    direction: worldToModel(dirW),
    up: worldToModel(upW),
    fovDeg: (cam.fovY * 180) / Math.PI,
    orthoHeight: cam.orthoHalfHeight * 2,
    aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 1,
  };
}

/** Modell-Kamera → Kamera des Viewports; `dist` legt das Blickziel auf der Blickachse fest. */
export function camera3dFromViewCamera(vc: ViewCamera, dist: number): Camera3d | null {
  const d = norm(modelToWorld(vc.direction));
  if (!d || !finite3(vc.position) || !finite3(vc.up)) return null;
  const eye = modelToWorld(vc.position);
  const up = modelToWorld(vc.up);
  const dd = Number.isFinite(dist) && dist > 0 ? dist : 10;
  return {
    eye,
    target: [eye[0] + d[0] * dd, eye[1] + d[1] * dd, eye[2] + d[2] * dd],
    up,
    perspective: vc.kind === "perspective",
    fovY: Number.isFinite(vc.fovDeg) && vc.fovDeg > 1 && vc.fovDeg < 170 ? (vc.fovDeg * Math.PI) / 180 : FOV_Y,
    orthoHalfHeight: Number.isFinite(vc.orthoHeight) && vc.orthoHeight > 0 ? vc.orthoHeight / 2 : 5,
  };
}

/** Schnittebene Modell → world (Punkt und Normale, die Normale zeigt auf die weggeschnittene Seite). */
export function sectionToWorld(s: ViewSection): { point: V3; normal: V3 } | null {
  const n = norm(modelToWorld(s.direction));
  if (!n || !finite3(s.location)) return null;
  return { point: modelToWorld(s.location), normal: n };
}

/** Vertikal genug für den Live-Schnitt (render3d unterstützt nur senkrechte Ebenen)? */
export function isVerticalSection(s: ViewSection): boolean {
  const n = norm(s.direction);
  return !!n && Math.abs(n[2]) < 0.02;
}

// ── Registrierung des Viewports ─────────────────────────────────────────────

export interface ViewportCameraApi {
  /** Aktuelle Kamera (world) und Bildverhältnis, oder null (Renderer nicht bereit). */
  read(): { camera: Camera3d; aspect: number } | null;
  /** Kamera setzen (world); mit `animate` als kurze Fahrt. */
  write(cam: Camera3d, animate: boolean): boolean;
  /** Aktuelles 3D-Bild als PNG, höchstens `maxEdge` Pixel auf der langen Seite. */
  snapshot(maxEdge: number): Promise<Uint8Array | null>;
  /** Live-Schnitt von aussen setzen (world) oder aufheben (null). */
  section(plane: { point: V3; normal: V3 } | null): void;
  /** Kamera auf Modell und sichtbare Punktwolken einpassen (aktuelles Preset). */
  fit(): void;
}

let api: ViewportCameraApi | null = null;

/** Der Viewport meldet sich an (und mit null wieder ab). Liefert die Abmeldefunktion. */
export function registerViewportCamera(next: ViewportCameraApi | null): () => void {
  api = next;
  exposeForDebug(next !== null);
  return () => {
    if (api === next) {
      api = null;
      exposeForDebug(false);
    }
  };
}

/** Prüfzugriff für Browser-Tests (Playwright): WebGPU-Frames sind in Containern oft leer, der
 *  Kamerazustand lässt sich so trotzdem lesen und setzen. Nur Lesen/Setzen, keine Modelldaten. */
function exposeForDebug(on: boolean): void {
  try {
    const g = globalThis as { __dossierCamera?: unknown };
    if (on) g.__dossierCamera = { getCamera, setCamera, captureSnapshot, setSection, viewportAvailable };
    else delete g.__dossierCamera;
  } catch {
    /* ohne globalThis-Zugriff kein Debug-Handle */
  }
}

/** Ist ein 3D-Viewport mit Kamera-Zugriff angemeldet? */
export const viewportAvailable = (): boolean => api !== null;

/** Aktuelle Kamera in Modell-Koordinaten, oder null ohne Viewport. */
export function getCamera(): ViewCamera | null {
  const r = api?.read();
  return r ? viewCameraFromCamera3d(r.camera, r.aspect) : null;
}

/** Kamera setzen. `false` ohne Viewport oder bei unbrauchbarer Kamera (NaN, Nullvektor). */
export function setCamera(cam: ViewCamera, opts: { animate?: boolean } = {}): boolean {
  if (!api) return false;
  const cur = api.read();
  // Abstand des Blickziels: Blickachse am bisherigen Ziel (so bleibt Zoom/Pan natürlich), sonst bisheriger Abstand.
  let dist = 10;
  if (cur) {
    const d = norm(modelToWorld(cam.direction));
    const along = d ? dot(sub(cur.camera.target, modelToWorld(cam.position)), d) : 0;
    dist = along >= 1 ? along : len(sub(cur.camera.target, cur.camera.eye)) || 10;
  }
  const c3 = camera3dFromViewCamera(cam, dist);
  return c3 ? api.write(c3, opts.animate === true) : false;
}

/** PNG des aktuellen 3D-Bildes, oder null (kein Viewport, leeres/nicht lesbares Bild). */
export async function captureSnapshot(opts: { maxEdge?: number } = {}): Promise<Uint8Array | null> {
  if (!api) return null;
  try {
    return await api.snapshot(opts.maxEdge ?? 1024);
  } catch {
    return null;
  }
}

/** Live-Schnitt aus einer Ebene in Modell-Koordinaten setzen; null hebt auf. `false` = nicht darstellbar. */
export function setSection(section: ViewSection | null): boolean {
  if (!api) return false;
  if (!section) {
    api.section(null);
    return true;
  }
  if (!isVerticalSection(section)) return false;
  const w = sectionToWorld(section);
  if (!w) return false;
  api.section(w);
  return true;
}

/** Kamera auf Modell und sichtbare Punktwolken einpassen. */
export function fitView(): void {
  api?.fit();
}
