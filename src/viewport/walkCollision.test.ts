// [245] Kollision und Bodenfolge mit einfachen synthetischen Modellen (keine Engine, kein Kern).
import { describe, expect, it } from "vitest";
import type { OrbitState } from "./cameraBridge";
import { EYE_HEIGHT, NO_KEYS, bodySettling, initBody, orbitEye, stepWalkCollide, type WalkKeys } from "./walk";
import { PERSON_RADIUS, STEP_UP, WalkWorld, type WalkModelInput, type WalkSlab, type WalkWall } from "./walkCollision";

/** Wand entlang der x-Achse bei z = 0, 10 m lang, 0.2 m dick, 2.6 m hoch. */
const wall = (holes: WalkWall["holes"] = []): WalkWall => ({ start: [-5, 0], end: [5, 0], thickness: 0.2, height: 2.6, baseElevation: 0, holes });
const floorSlab = (x0: number, x1: number, top: number, bottom = top - 0.3, z = 20): WalkSlab => ({
  outline: [[x0, -z], [x1, -z], [x1, z], [x0, z]],
  zBottom: bottom,
  zTop: top,
});
const world = (m: Partial<WalkModelInput>) => new WalkWorld({ walls: [], slabs: [], meshes: [], ...m });

describe("Kollision", () => {
  it("eine Wand blockiert: die Person bleibt mit ihrem Radius davor", () => {
    const w = world({ walls: [wall()] });
    let [x, z] = [0, -2];
    for (let i = 0; i < 50; i++) [x, z] = w.move(x, z, 0, 0.1, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(-(0.1 + PERSON_RADIUS), 3);
    expect(w.isFree(x, z, 0)).toBe(true);
  });

  it("schnelle Schritte tunneln nicht durch die Wand", () => {
    const w = world({ walls: [wall()] });
    const [, z] = w.move(0, -1, 0, 3, 0);
    expect(z).toBeLessThan(0);
  });

  it("an der Wand schräg gehen gleitet entlang statt zu stoppen", () => {
    const w = world({ walls: [wall()] });
    let [x, z] = [-3, -(0.1 + PERSON_RADIUS)];
    for (let i = 0; i < 20; i++) [x, z] = w.move(x, z, 0.1, 0.1, 0);
    expect(x).toBeGreaterThan(-3 + 1.5);
    expect(z).toBeLessThanOrEqual(-(0.1 + PERSON_RADIUS) + 1e-6);
  });

  it("Türöffnung (Loch bis zur Wand-UK) ist frei, daneben ist die Wand", () => {
    const w = world({ walls: [wall([{ from: 6, to: 7, zBottom: 0, zTop: 2.1 }])] }); // x = 1 … 2
    expect(w.move(1.5, -1, 0, 2, 0)[1]).toBeGreaterThan(0.5);
    expect(w.move(0.2, -1, 0, 2, 0)[1]).toBeLessThan(0);
  });

  it("Fenster (Brüstung 0.9) sperrt, auch ein bodennahes Fenster mit Glasebene", () => {
    const w = world({ walls: [wall([{ from: 8, to: 9, zBottom: 0.9, zTop: 2.1 }, { from: 1, to: 2, zBottom: 0.1, zTop: 2.4 }])] });
    expect(w.move(3.5, -1, 0, 2, 0)[1]).toBeLessThan(0);
    expect(w.move(-3.5, -1, 0, 2, 0)[1]).toBeLessThan(0);
  });

  it("Sturz über der Tür stört nicht (Körper 1.8 m, Sturz ab 2.1 m)", () => {
    const w = world({ walls: [wall([{ from: 6, to: 7, zBottom: 0, zTop: 2.1 }])] });
    expect(w.isFree(1.5, 0, 0)).toBe(true);
  });

  it("Hindernisse unter der Stufenhöhe oder über dem Kopf zählen nicht", () => {
    const low = world({ walls: [{ ...wall(), height: 0.2 }] });
    expect(low.move(0, -1, 0, 2, 0)[1]).toBeGreaterThan(0.5);
    const high = world({ walls: [{ ...wall(), baseElevation: 2.2 }] });
    expect(high.move(0, -1, 0, 2, 0)[1]).toBeGreaterThan(0.5);
  });

  it("Wand auf einem anderen Geschoss (Füsse oben) stört nicht", () => {
    const w = world({ walls: [wall()] });
    expect(w.move(0, -1, 0, 2, 3)[1]).toBeGreaterThan(0.5);
  });

  it("senkrechte Netzdreiecke (Stütze) blockieren", () => {
    // Quadratische Stütze 0.4 m bei (0,0), Höhe 3 m: nur die vier Seiten (je zwei Dreiecke), Modell-Koordinaten (x, y, z=Höhe).
    const q = (a: [number, number], b: [number, number]) => [a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], 3, a[0], a[1], 3];
    const pos = [...q([-0.2, -0.2], [0.2, -0.2]), ...q([0.2, -0.2], [0.2, 0.2]), ...q([0.2, 0.2], [-0.2, 0.2]), ...q([-0.2, 0.2], [-0.2, -0.2])];
    const indices: number[] = [];
    for (let i = 0; i < 4; i++) indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    const w = world({ meshes: [{ positions: pos, indices }] });
    expect(w.move(0.05, -2, 0, 4, 0)[1]).toBeLessThan(-0.4);
    expect(w.move(1, -2, 0, 4, 0)[1]).toBeGreaterThan(1);
  });
});

describe("Boden", () => {
  it("Decken-Oberseite ist Boden, nichts darüber: Boden höchstens eine Stufe über den Füssen", () => {
    const w = world({ slabs: [floorSlab(-10, 10, 0), floorSlab(-10, 10, 3)] });
    expect(w.groundAt(0, 0, 0 + STEP_UP)).toBe(0);
    expect(w.groundAt(0, 0, 3.1)).toBe(3);
    expect(w.groundAt(30, 0, 5)).toBeNull();
  });

  it("Dreiecksnetz (Rampe) liefert die interpolierte Höhe", () => {
    // Rampe in Modell-Koordinaten (x, y, z=Höhe): z = 0.5 * x über x in [0, 4].
    const positions = [0, 0, 0, 4, 0, 2, 4, 4, 2, 0, 4, 0];
    const w = world({ meshes: [{ positions, indices: [0, 1, 2, 0, 2, 3], kind: "extrusion" }] });
    expect(w.groundAt(2, 1, 10)).toBeCloseTo(1, 6);
    expect(w.groundAt(3, 3, 10)).toBeCloseTo(1.5, 6);
  });

  it("Gelände-Netze haben die Nord-Negation (world-z = −y)", () => {
    const positions = [-5, -5, 0.5, 5, -5, 0.5, 5, 5, 0.5, -5, 5, 0.5];
    const w = world({ meshes: [{ positions, indices: [0, 1, 2, 0, 2, 3], kind: "terrain" }] });
    expect(w.groundAt(0, 3, 10)).toBeCloseTo(0.5, 6);
    expect(w.groundAt(0, -3, 10)).toBeCloseTo(0.5, 6);
  });
});

const orbitAt = (x: number, eyeY: number, z: number, yaw = Math.PI): OrbitState => {
  // yaw = π: Blick nach +x (Vorwärts = (−cos yaw, 0, −sin yaw) = (1, 0, 0)).
  const dist = 3;
  return { yaw, pitch: 0, dist, target: [x - dist * Math.cos(yaw), eyeY, z - dist * Math.sin(yaw)], ortho: false, orthoHalfHeight: 5 };
};
const fwd: WalkKeys = { ...NO_KEYS, forward: true };
function run(w: WalkWorld, o: OrbitState, keys: WalkKeys, seconds: number, speed = 3) {
  let body = initBody(o, w);
  let orbit = o;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) ({ orbit, body } = stepWalkCollide(orbit, body, keys, dt, speed, w));
  return { orbit, body, eye: orbitEye(orbit) };
}

const stairTreads = (): WalkSlab[] => {
  // 12 Tritte als Decken-Prismen, Auftritt 0.3 m, ab x = 1, Steigung 0.18 m.
  const treads: WalkSlab[] = [];
  for (let i = 0; i < 12; i++) treads.push({ outline: [[1 + i * 0.3, -1], [1.3 + i * 0.3, -1], [1.3 + i * 0.3, 1], [1 + i * 0.3, 1]], zBottom: 0, zTop: 0.18 * (i + 1) });
  return treads;
};

describe("Begehen mit Bodenfolge", () => {
  it("auf einer Treppe steigt man mit, ohne hängenzubleiben", () => {
    const w = world({ slabs: [floorSlab(-10, 1, 0), ...stairTreads(), floorSlab(4.6, 12, 2.16)] });
    const r = run(w, orbitAt(-1, EYE_HEIGHT, 0), fwd, 3);
    expect(r.eye[0]).toBeGreaterThan(5);
    expect(r.body.feetY).toBeCloseTo(2.16, 2);
    expect(r.eye[1]).toBeCloseTo(2.16 + EYE_HEIGHT, 2);
  });

  it("auf der Treppe ist die Augenhöhe stetig: pro Bild nur ein Bruchteil der Stufe", () => {
    const w = world({ slabs: [floorSlab(-10, 1, 0), ...stairTreads()] });
    let o = orbitAt(0, EYE_HEIGHT, 0);
    let body = initBody(o, w);
    let maxJump = 0;
    for (let i = 0; i < 200; i++) {
      const before = orbitEye(o)[1];
      ({ orbit: o, body } = stepWalkCollide(o, body, fwd, 1 / 60, 2, w));
      maxJump = Math.max(maxJump, Math.abs(orbitEye(o)[1] - before));
    }
    expect(orbitEye(o)[1]).toBeGreaterThan(EYE_HEIGHT + 1);
    expect(maxJump).toBeLessThan(0.1);
  });

  it("eine Stufe von 0.4 m blockiert, 0.2 m nicht", () => {
    const high = world({ slabs: [floorSlab(-10, 2, 0), floorSlab(2, 10, 0.4)] });
    const a = run(high, orbitAt(0, EYE_HEIGHT, 0), fwd, 3);
    expect(a.eye[0]).toBeLessThan(2 - PERSON_RADIUS + 0.01);
    expect(a.body.feetY).toBeCloseTo(0, 2);
    const low = world({ slabs: [floorSlab(-10, 2, 0), floorSlab(2, 10, 0.2)] });
    const b = run(low, orbitAt(0, EYE_HEIGHT, 0), fwd, 3);
    expect(b.eye[0]).toBeGreaterThan(5);
    expect(b.body.feetY).toBeCloseTo(0.2, 2);
  });

  it("fällt der Boden weg, sinkt man sanft bis zum nächsten Boden (nicht in einem Bild)", () => {
    const w = world({ slabs: [floorSlab(-10, 2, 3), floorSlab(2, 12, 0)] });
    let o = orbitAt(0, 3 + EYE_HEIGHT, 0);
    let body = initBody(o, w);
    expect(body.feetY).toBeCloseTo(3, 6);
    let maxDrop = 0;
    for (let i = 0; i < 300; i++) {
      const before = orbitEye(o)[1];
      ({ orbit: o, body } = stepWalkCollide(o, body, fwd, 1 / 60, 3, w));
      maxDrop = Math.max(maxDrop, before - orbitEye(o)[1]);
    }
    expect(orbitEye(o)[0]).toBeGreaterThan(3);
    expect(body.feetY).toBeCloseTo(0, 2);
    expect(maxDrop).toBeGreaterThan(0);
    expect(maxDrop).toBeLessThanOrEqual(5 / 60 + 1e-9);
    expect(bodySettling(body)).toBe(false);
  });

  it("Q/E ändern die Augenhöhe begrenzt; ohne Boden bleibt die Höhe stehen", () => {
    const w = world({ slabs: [floorSlab(-10, 10, 0)] });
    const up = run(w, orbitAt(0, EYE_HEIGHT, 0), { ...NO_KEYS, up: true }, 5);
    expect(up.body.eyeHeight).toBeLessThanOrEqual(2.3);
    expect(up.eye[1]).toBeCloseTo(up.body.eyeHeight, 3);
    const empty = run(world({}), orbitAt(0, 4, 0), fwd, 1);
    expect(empty.eye[1]).toBeCloseTo(4, 6);
  });

  it("läuft gegen eine Wand: Blickrichtung bleibt, Person steht davor", () => {
    const w = world({ walls: [{ start: [3, -5], end: [3, 5], thickness: 0.2, height: 2.6, baseElevation: 0 }], slabs: [floorSlab(-10, 10, 0)] });
    const r = run(w, orbitAt(0, EYE_HEIGHT, 0), fwd, 3);
    expect(r.eye[0]).toBeCloseTo(3 - 0.1 - PERSON_RADIUS, 2);
    expect(r.orbit.yaw).toBe(Math.PI);
  });
});
