// [246] Kamerafahrt: reine Interpolation durch die Kameras des Projekts (Listenreihenfolge), ohne React und Engine.
// Standpunkt und Ziel laufen entweder als Catmull-Rom-Spline durch alle Kameras („flüssig", Endpunkte doppelt, also
// sanftes Anfahren/Abbremsen) oder je Abschnitt linear mit Smoothstep („geglättet", Halt an jeder Kamera). Der
// Bildwinkel (und die Sichthöhe bei Axonometrie) ist in beiden Fällen linear je Abschnitt. Kameras ändern sich dabei nie:
// die Fahrt ist Ansichtszustand.

import type { Camera, Project } from "../model/types";
import type { V3, ViewCamera } from "./cameraBridge";
import { cameraEye, cameraTarget, clampFov } from "./cameraView";

export type TourMode = "catmull" | "smooth";

export const TOUR_DEFAULT_SECONDS = 4;
export const TOUR_MIN_SECONDS = 0.5;
export const TOUR_MAX_SECONDS = 60;

/** Eine Kamera als Stützpunkt der Fahrt (Modell-Koordinaten, z oben). */
export interface TourKey {
  position: V3;
  target: V3;
  fovDeg: number;
  orthoHeight: number;
  ortho: boolean;
}

/** Zwischenstand der Fahrt zu einem Zeitpunkt. */
export type TourSample = TourKey;

/** Dauer je Abschnitt auf den erlaubten Bereich klemmen (NaN → Vorgabe). */
export function clampSeconds(s: number): number {
  return Number.isFinite(s) ? Math.min(TOUR_MAX_SECONDS, Math.max(TOUR_MIN_SECONDS, s)) : TOUR_DEFAULT_SECONDS;
}

/** Stützpunkte aus den Kameras in Listenreihenfolge; unbrauchbare (nicht endlich, Standpunkt = Ziel) fallen weg. */
export function tourKeys(project: Project, cameras: readonly Camera[]): TourKey[] {
  const keys: TourKey[] = [];
  for (const c of cameras) {
    const position = cameraEye(project, c);
    const target = cameraTarget(c);
    if (![...position, ...target].every(Number.isFinite)) continue;
    if (!(Math.hypot(target[0] - position[0], target[1] - position[1], target[2] - position[2]) > 1e-9)) continue;
    const oh = c.orthoHeight;
    keys.push({
      position,
      target,
      fovDeg: clampFov(c.fovDeg),
      orthoHeight: typeof oh === "number" && Number.isFinite(oh) && oh > 0 ? oh : 10,
      ortho: c.projection !== "perspective",
    });
  }
  return keys;
}

/** Gesamtdauer in Sekunden: (Anzahl − 1) Abschnitte; 0 bei höchstens einer Kamera. */
export function tourDuration(count: number, secondsPerSegment: number): number {
  return Math.max(0, count - 1) * clampSeconds(secondsPerSegment);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Catmull-Rom (gleichförmig) durch p1 → p2, t in [0, 1]. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
const catmull3 = (a: V3, b: V3, c: V3, d: V3, t: number): V3 => [
  catmull(a[0], b[0], c[0], d[0], t),
  catmull(a[1], b[1], c[1], d[1], t),
  catmull(a[2], b[2], c[2], d[2], t),
];

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Zustand der Fahrt zur Zeit `time` (Sekunden ab Start, ausserhalb auf [0, Dauer] geklemmt). Bei Beginn, an jeder
 * Abschnittsgrenze und am Ende sind die Stützpunkte exakt getroffen. Null ohne Stützpunkte; eine Kamera hält ihre Sicht.
 */
export function sampleTour(keys: readonly TourKey[], secondsPerSegment: number, mode: TourMode, time: number): TourSample | null {
  const n = keys.length;
  if (n === 0) return null;
  if (n === 1) return { ...keys[0]! };
  const seg = clampSeconds(secondsPerSegment);
  const total = (n - 1) * seg;
  const tt = Number.isFinite(time) ? Math.min(total, Math.max(0, time)) : 0;
  let i = Math.min(n - 2, Math.floor(tt / seg));
  let u = (tt - i * seg) / seg;
  if (tt >= total) {
    i = n - 2;
    u = 1;
  }
  const a = keys[i]!;
  const b = keys[i + 1]!;
  if (u <= 0) return { ...a };
  if (u >= 1) return { ...b };
  let position: V3;
  let target: V3;
  if (mode === "catmull") {
    const k0 = keys[Math.max(0, i - 1)]!;
    const k3 = keys[Math.min(n - 1, i + 2)]!;
    position = catmull3(k0.position, a.position, b.position, k3.position, u);
    target = catmull3(k0.target, a.target, b.target, k3.target, u);
  } else {
    const e = smoothstep(u);
    position = lerp3(a.position, b.position, e);
    target = lerp3(a.target, b.target, e);
  }
  const f = mode === "smooth" ? smoothstep(u) : u;
  return {
    position,
    target,
    fovDeg: lerp(a.fovDeg, b.fovDeg, f),
    orthoHeight: lerp(a.orthoHeight, b.orthoHeight, f),
    ortho: u < 0.5 ? a.ortho : b.ortho,
  };
}

/** Sample → Sicht des Viewports (Blickrichtung, Up senkrecht dazu aus der Modell-Senkrechten). Null bei Standpunkt = Ziel. */
export function sampleToView(s: TourSample, aspect = 16 / 9): ViewCamera | null {
  const d: V3 = [s.target[0] - s.position[0], s.target[1] - s.position[1], s.target[2] - s.position[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-9) || !Number.isFinite(len)) return null;
  const dir: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const ref: V3 = Math.abs(dir[2]) > 0.9999 ? [0, 1, 0] : [0, 0, 1];
  const k = ref[0] * dir[0] + ref[1] * dir[1] + ref[2] * dir[2];
  const upRaw: V3 = [ref[0] - dir[0] * k, ref[1] - dir[1] * k, ref[2] - dir[2] * k];
  const ul = Math.hypot(upRaw[0], upRaw[1], upRaw[2]);
  return {
    kind: s.ortho ? "orthogonal" : "perspective",
    position: [...s.position],
    direction: dir,
    up: [upRaw[0] / ul, upRaw[1] / ul, upRaw[2] / ul],
    fovDeg: clampFov(s.fovDeg),
    orthoHeight: s.orthoHeight,
    aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9,
  };
}
