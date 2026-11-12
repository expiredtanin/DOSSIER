import { describe, expect, it } from "vitest";
import { orbitCamera } from "./cameraBridge";
import type { OrbitState } from "./cameraBridge";
import { NO_KEYS, lookAround, orbitEye, speedFactor, stepWalk, walkKeyAllowed, walkKeyOf, walkVelocity } from "./walk";

const orbit = (over: Partial<OrbitState> = {}): OrbitState => ({
  yaw: 0,
  pitch: 0.4,
  dist: 10,
  target: [0, 1.6, 0],
  ortho: false,
  orthoHalfHeight: 5,
  ...over,
});

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], -Math.log10(eps)));

describe("[213] Begehen: Tasten", () => {
  it("W/A/S/D, Pfeile und Q/E; alles andere ist keine Bewegung", () => {
    expect(walkKeyOf("KeyW")).toBe("forward");
    expect(walkKeyOf("ArrowUp")).toBe("forward");
    expect(walkKeyOf("KeyS")).toBe("back");
    expect(walkKeyOf("ArrowLeft")).toBe("left");
    expect(walkKeyOf("KeyD")).toBe("right");
    expect(walkKeyOf("KeyQ")).toBe("down");
    expect(walkKeyOf("KeyE")).toBe("up");
    expect(walkKeyOf("KeyT")).toBeNull();
    expect(walkKeyOf("Digit3")).toBeNull();
  });

  it("Shift schneller, Alt langsamer, beide gleichen sich teils aus", () => {
    expect(speedFactor(false, false)).toBe(1);
    expect(speedFactor(true, false)).toBe(4);
    expect(speedFactor(false, true)).toBe(0.25);
    expect(speedFactor(true, true)).toBe(1);
  });

  it("Befehls-Modifikator oder Textfeld sperren das Begehen", () => {
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, null)).toBe(true);
    expect(walkKeyAllowed({ ctrlKey: true, metaKey: false }, null)).toBe(false);
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: true }, null)).toBe(false);
    const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, el("INPUT"))).toBe(false);
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, el("TEXTAREA"))).toBe(false);
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, el("DIV", true))).toBe(false);
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, el("DIV"))).toBe(true);
    expect(walkKeyAllowed({ ctrlKey: false, metaKey: false }, el("CANVAS"))).toBe(true);
  });
});

describe("[213] Begehen: Bewegung", () => {
  it("vorwärts läuft in der Blickrichtung, waagrecht (Augenhöhe bleibt trotz Neigung)", () => {
    // yaw 0: Augpunkt liegt bei +x vom Ziel, Blick geht nach −x.
    const v = walkVelocity({ ...NO_KEYS, forward: true }, 0, 3);
    near(v, [-3, 0, 0]);
    const o = orbit({ pitch: 0.9 });
    const eye0 = orbitEye(o);
    const n = stepWalk(o, { ...NO_KEYS, forward: true }, 1 / 60);
    const eye1 = orbitEye(n);
    expect(eye1[1]).toBeCloseTo(eye0[1], 12);
    expect(eye1[0]).toBeLessThan(eye0[0]);
    // Abstand, Winkel und Projektion bleiben.
    expect(n.dist).toBe(o.dist);
    expect(n.pitch).toBe(o.pitch);
    expect(n.yaw).toBe(o.yaw);
  });

  it("seitwärts steht senkrecht auf der Blickrichtung; rechts ist rechts", () => {
    // Blick nach −x (yaw 0), Weltoben +y: rechts ist −z.
    near(walkVelocity({ ...NO_KEYS, right: true }, 0, 2), [0, 0, -2]);
    near(walkVelocity({ ...NO_KEYS, left: true }, 0, 2), [0, 0, 2]);
    // Gedreht um 90°: Blick nach −z, rechts ist +x.
    near(walkVelocity({ ...NO_KEYS, forward: true }, Math.PI / 2, 2), [0, 0, -2]);
    near(walkVelocity({ ...NO_KEYS, right: true }, Math.PI / 2, 2), [2, 0, 0]);
  });

  it("diagonal ist nicht schneller; Gegentasten heben sich auf; Q/E senkrecht", () => {
    const d = walkVelocity({ ...NO_KEYS, forward: true, right: true }, 0.3, 3);
    expect(Math.hypot(d[0], d[2])).toBeCloseTo(3, 12);
    near(walkVelocity({ ...NO_KEYS, forward: true, back: true }, 0.3, 3), [0, 0, 0]);
    near(walkVelocity({ ...NO_KEYS, up: true }, 0.3, 3), [0, 3, 0]);
    near(walkVelocity({ ...NO_KEYS, down: true }, 0.3, 3), [0, -3, 0]);
  });

  it("Weg = Tempo × Zeit; langer Zeitschritt wird gekappt; ohne Taste oder dt bleibt der Zustand", () => {
    const o = orbit();
    const n = stepWalk(o, { ...NO_KEYS, forward: true }, 0.05, 4);
    expect(n.target[0]).toBeCloseTo(-0.2, 12);
    const slow = stepWalk(o, { ...NO_KEYS, forward: true }, 5, 4);
    expect(slow.target[0]).toBeCloseTo(-0.4, 12); // höchstens 0.1 s
    expect(stepWalk(o, NO_KEYS, 1)).toBe(o);
    expect(stepWalk(o, { ...NO_KEYS, forward: true }, 0)).toBe(o);
    expect(stepWalk(o, { ...NO_KEYS, forward: true }, NaN)).toBe(o);
    expect(stepWalk(o, { ...NO_KEYS, forward: true }, 1, 0)).toBe(o);
  });

  it("die Kamera zeigt nach dem Gehen weiter in dieselbe Richtung", () => {
    const o = orbit({ yaw: 1.2, pitch: 0.3 });
    const c0 = orbitCamera(o);
    const c1 = orbitCamera(stepWalk(o, { ...NO_KEYS, forward: true, right: true }, 0.08));
    const dir = (c: { eye: number[]; target: number[] }) => {
      const d = [c.target[0] - c.eye[0], c.target[1] - c.eye[1], c.target[2] - c.eye[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      return d.map((x) => x / l);
    };
    near(dir(c1), dir(c0), 1e-9);
  });
});

describe("[213] Begehen: Umschauen", () => {
  it("der Augpunkt bleibt stehen, die Blickrichtung dreht", () => {
    const o = orbit({ yaw: 0.7, pitch: 0.2 });
    const eye = orbitEye(o);
    const n = lookAround(o, 120, -40);
    near(orbitEye(n), eye, 1e-9);
    expect(n.yaw).toBeGreaterThan(o.yaw); // Maus nach rechts → Blick nach rechts
    expect(n.pitch).toBeLessThan(o.pitch); // Maus nach oben → Blick hebt sich
    expect(n.dist).toBe(o.dist);
  });

  it("Neigung ist geklemmt; ohne Bewegung bleibt der Zustand", () => {
    const o = orbit();
    const steep = lookAround(o, 0, 1e6);
    expect(steep.pitch).toBeLessThan(Math.PI / 2);
    expect(steep.pitch).toBeGreaterThan(1.5);
    expect(lookAround(o, 0, 0)).toBe(o);
    expect(lookAround(o, NaN, 3)).toBe(o);
  });
});
