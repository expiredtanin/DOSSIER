// [213] Begehen im 3D (WASD): reine Bewegungsrechnung auf dem Orbit-Zustand des Viewports, ohne React und Engine.
//
// Der Orbit-Zustand (`OrbitState`, world Y-oben) beschreibt die Kamera als Blickziel + Abstand + Winkel. Den Augpunkt
// verschieben heisst, das Blickziel um denselben Vektor verschieben — Abstand und Winkel bleiben. Vorwärts und
// seitwärts laufen in der Horizontalen (Augenhöhe bleibt, auch bei geneigtem Blick); Q/E bewegen senkrecht.
// Umschauen dreht die Blickrichtung um den Augpunkt (nicht um das Ziel wie der Orbit).

import { PITCH_LIMIT } from "./cameraBridge";
import type { OrbitState, V3 } from "./cameraBridge";
import { STEP_UP, type WalkWorld } from "./walkCollision";

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
  if ((active as HTMLElement).isContentEditable) return false;
  // [249] Liegt der Fokus in einem modalen Dialog, gehören die Tasten dem Dialog (kein Gehen im Hintergrund).
  return !(typeof active.closest === "function" && active.closest('[aria-modal="true"]'));
}

// ── [245] Kollision und Bodenfolge ─────────────────────────────────────────────────────────────────────────────

/** Standard-Augenhöhe über dem Boden (m) und erlaubter Bereich für Q/E. */
export const EYE_HEIGHT = 1.6;
export const EYE_MIN = 0.5;
export const EYE_MAX = 2.3;
/** Glättung der Fusshöhe (1/s): Aufstieg zügig, Abstieg sanfter; höchste Fallgeschwindigkeit (m/s). */
const RISE_RATE = 14;
const FALL_RATE = 6;
const MAX_FALL_SPEED = 5;
/** Unter dieser Restdifferenz (m) gilt die Fusshöhe als angekommen. */
const SETTLE = 0.002;

/** Zustand der Person im Begehen mit Kollision. */
export interface WalkBody {
  /** Fusshöhe (geglättet, daraus ergibt sich die Augenhöhe). */
  feetY: number;
  /** Höhe des Bodens unter der Person (ungeglättet, Bezug für Stufen und Kollision). */
  groundY: number;
  /** Auge über den Füssen (Q/E ändern sie). */
  eyeHeight: number;
}

/** Person aus dem aktuellen Augpunkt: Boden darunter suchen; ohne Boden bleibt die Höhe stehen. */
export function initBody(o: OrbitState, world: WalkWorld): WalkBody {
  const eye = orbitEye(o);
  const ground = world.groundAt(eye[0], eye[2], eye[1]);
  const eyeHeight = ground !== null && eye[1] - ground >= EYE_MIN && eye[1] - ground <= EYE_MAX ? eye[1] - ground : EYE_HEIGHT;
  const feetY = eye[1] - eyeHeight;
  return { feetY, groundY: ground !== null ? ground : feetY, eyeHeight };
}

/** Ist die Fusshöhe noch unterwegs zum Boden (dann läuft der Takt auch ohne Taste weiter)? */
export const bodySettling = (b: WalkBody): boolean => Math.abs(b.feetY - b.groundY) > SETTLE;

/** Fusshöhe auf den Boden zu: nach oben schnell, nach unten sanft mit Fallgrenze; ohne Ruckeln bei Stufen. */
function smoothFeet(feet: number, ground: number, dt: number): number {
  const diff = ground - feet;
  if (Math.abs(diff) <= SETTLE) return ground;
  if (diff > 0) return feet + diff * (1 - Math.exp(-RISE_RATE * dt));
  const drop = Math.min(-diff * (1 - Math.exp(-FALL_RATE * dt)), MAX_FALL_SPEED * dt, -diff);
  return feet - drop;
}

/**
 * Ein Zeitschritt des Begehens mit Kollision: horizontal gleitend an Wänden, Fusshöhe folgt dem Boden (Stufen bis
 * `STEP_UP` geglättet, Absturz sanft), Q/E ändern die Augenhöhe. Der Augpunkt wandert um denselben Vektor wie das Ziel
 * (Blickrichtung bleibt). Ohne Taste und ohne offene Höhenanpassung derselbe Zustand.
 */
export function stepWalkCollide(
  o: OrbitState,
  body: WalkBody,
  keys: WalkKeys,
  dt: number,
  speed: number,
  world: WalkWorld,
): { orbit: OrbitState; body: WalkBody } {
  if (!(dt > 0) || !Number.isFinite(dt) || !(speed > 0)) return { orbit: o, body };
  const s = Math.min(dt, MAX_DT);
  const eye = orbitEye(o);
  const v = walkVelocity(keys, o.yaw, speed);
  let x = eye[0];
  let z = eye[2];
  if (v[0] !== 0 || v[2] !== 0) [x, z] = world.move(x, z, v[0] * s, v[2] * s, body.groundY);
  // Boden an der neuen Stelle: höchstens eine Stufe höher als bisher; fällt der Boden weg, der nächste darunter.
  const g = world.groundAt(x, z, body.groundY + STEP_UP);
  const groundY = g !== null ? g : body.groundY;
  const eyeHeight = Math.max(EYE_MIN, Math.min(EYE_MAX, body.eyeHeight + v[1] * s));
  const feetY = smoothFeet(body.feetY, groundY, s);
  const ny = feetY + eyeHeight;
  const d: V3 = [x - eye[0], ny - eye[1], z - eye[2]];
  const orbit = d[0] === 0 && d[1] === 0 && d[2] === 0 ? o : { ...o, target: [o.target[0] + d[0], o.target[1] + d[1], o.target[2] + d[2]] as V3 };
  return { orbit, body: { feetY, groundY, eyeHeight } };
}
