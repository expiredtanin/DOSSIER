// [213] Begehen im 3D (WASD): reine Bewegungsrechnung auf dem Orbit-Zustand des Viewports, ohne React und Engine.
//
// Der Orbit-Zustand (`OrbitState`, world Y-oben) beschreibt die Kamera als Blickziel + Abstand + Winkel. Den Augpunkt
// verschieben heisst, das Blickziel um denselben Vektor verschieben — Abstand und Winkel bleiben. Vorwärts und
// seitwärts laufen in der Horizontalen (Augenhöhe bleibt, auch bei geneigtem Blick); Q/E bewegen senkrecht.
// Umschauen dreht die Blickrichtung um den Augpunkt (nicht um das Ziel wie der Orbit).

import { PITCH_LIMIT } from "./cameraBridge";
import type { OrbitState, V3 } from "./cameraBridge";

/** Gedrückte Bewegungstasten. */
export interface WalkKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export const NO_KEYS: WalkKeys = { forward: false, back: false, left: false, right: false, up: false, down: false };

/** Grundgeschwindigkeit (m/s), Shift ×4, Alt ×0.25. */
export const WALK_SPEED = 3;
export const FAST_FACTOR = 4;
export const SLOW_FACTOR = 0.25;
/** Längster Zeitschritt (s): nach einem Hänger (Tab im Hintergrund) kein Sprung durchs Haus. */
export const MAX_DT = 0.1;
/** Mausempfindlichkeit beim Umschauen (Radiant je Pixel). */
export const LOOK_RAD_PER_PX = 0.0035;

/** Taste (`KeyboardEvent.code`) → Bewegung; `null` für alle anderen. W/S/A/D und Pfeile vor/zurück/seitlich, Q/E runter/hoch. */
export function walkKeyOf(code: string): keyof WalkKeys | null {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "forward";
    case "KeyS":
    case "ArrowDown":
      return "back";
    case "KeyA":
    case "ArrowLeft":
      return "left";
    case "KeyD":
    case "ArrowRight":
      return "right";
    case "KeyQ":
      return "down";
    case "KeyE":
      return "up";
    default:
      return null;
  }
}

/** Ist irgendeine Bewegungstaste gedrückt? */
export const anyKey = (k: WalkKeys): boolean => k.forward || k.back || k.left || k.right || k.up || k.down;

/** Tempo-Faktor aus Shift (schneller) und Alt (langsamer); beide = Grundtempo. */
export function speedFactor(shift: boolean, alt: boolean): number {
  return (shift ? FAST_FACTOR : 1) * (alt ? SLOW_FACTOR : 1);
}

/**
 * Geschwindigkeit (world, m/s) aus den gedrückten Tasten. Vorwärts = horizontale Blickrichtung (die Höhe bleibt),
 * seitwärts = rechts, hoch/runter = world Y. Gegensätzliche Tasten heben sich auf; diagonale Bewegung ist nicht
 * schneller als geradeaus (die waagrechte Richtung wird normiert).
 */
export function walkVelocity(keys: WalkKeys, yaw: number, speed: number): V3 {
  const fwd = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const side = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const vert = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  // Horizontale Blickrichtung f = (−cos yaw, 0, −sin yaw), rechts s = (sin yaw, 0, −cos yaw) (wie im Pan des Viewports).
  const hx = -Math.cos(yaw) * fwd + Math.sin(yaw) * side;
  const hz = -Math.sin(yaw) * fwd - Math.cos(yaw) * side;
  const hl = Math.hypot(hx, hz);
  const k = hl > 1e-12 ? speed / hl : 0;
  return [hx * k, vert * speed, hz * k];
}

/** Orbit-Zustand nach `dt` Sekunden Gehen; derselbe Zustand ohne Taste oder bei unbrauchbarem `dt`. */
export function stepWalk(o: OrbitState, keys: WalkKeys, dt: number, speed: number = WALK_SPEED): OrbitState {
  if (!anyKey(keys) || !(dt > 0) || !Number.isFinite(dt) || !(speed > 0)) return o;
  const v = walkVelocity(keys, o.yaw, speed);
  const s = Math.min(dt, MAX_DT);
  return { ...o, target: [o.target[0] + v[0] * s, o.target[1] + v[1] * s, o.target[2] + v[2] * s] };
}

/** Augpunkt (world) des Orbit-Zustands. */
export function orbitEye(o: OrbitState): V3 {
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
  const r = o.dist * Math.cos(pitch);
  return [o.target[0] + r * Math.cos(o.yaw), o.target[1] + o.dist * Math.sin(pitch), o.target[2] + r * Math.sin(o.yaw)];
}

/**
 * Umschauen um den Augpunkt: Maus nach rechts (`dx` > 0) dreht den Blick nach rechts, Maus nach unten (`dy` > 0)
 * senkt ihn. Der Augpunkt bleibt exakt stehen (das Blickziel wandert auf der neuen Blickachse mit); der Neigungswinkel
 * ist wie beim Orbit geklemmt.
 */
export function lookAround(o: OrbitState, dx: number, dy: number, radPerPx: number = LOOK_RAD_PER_PX): OrbitState {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return o;
  const eye = orbitEye(o);
  const yaw = o.yaw + dx * radPerPx;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch + dy * radPerPx));
  const r = o.dist * Math.cos(pitch);
  return { ...o, yaw, pitch, target: [eye[0] - r * Math.cos(yaw), eye[1] - o.dist * Math.sin(pitch), eye[2] - r * Math.sin(yaw)] };
}

/** Darf die Taste das Begehen starten (kein Textfeld im Fokus, kein Befehls-Modifikator)? */
export function walkKeyAllowed(e: { ctrlKey: boolean; metaKey: boolean }, active: Element | null): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  if (!active) return true;
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  return !(active as HTMLElement).isContentEditable;
}
