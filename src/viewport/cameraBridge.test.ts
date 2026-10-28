// Achsabbildung und Kamera-Rundreisen der Viewport-Brücke. Die Abbildung wird gegen das ECHTE
// geflachte Modell (`projectToModel3d`) belegt, nicht gegen eine Annahme.

import { afterEach, describe, expect, it } from "vitest";
import { projectToModel3d, sampleProject } from "../core";
import {
  FOV_Y,
  camera3dFromViewCamera,
  captureSnapshot,
  getCamera,
  isVerticalSection,
  lerpOrbit,
  modelToWorld,
  orbitCamera,
  orbitFromCamera3d,
  registerViewportCamera,
  sectionToWorld,
  setCamera,
  setSection,
  viewCameraFromCamera3d,
  viewportAvailable,
  worldToModel,
  type OrbitState,
  type V3,
  type ViewCamera,
  type ViewportCameraApi,
} from "./cameraBridge";
import type { Camera3d } from "./useWasm3dRenderer";

const close = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

afterEach(() => registerViewportCamera(null));

describe("Achsabbildung Modell ↔ world", () => {
  it("tauscht y und z und ist ihre eigene Umkehrung", () => {
    expect(modelToWorld([1, 2, 3])).toEqual([1, 3, 2]);
    expect(worldToModel(modelToWorld([4.5, -2, 7]))).toEqual([4.5, -2, 7]);
  });

  it("deckt sich mit der Lage der Wände im geflachten Modell (world = (x, Höhe, y), ohne Negation)", () => {
    const project = sampleProject;
    const model = projectToModel3d(project);
    const w2 = project.walls.find((w) => w.id === "W2")!; // von (5, 0) nach (5, 4): y wächst
    expect([w2.start.y, w2.end.y]).toEqual([0, 4]);
    // Die Schichtbänder weichen nur um die halbe Wanddicke von der Achse ab. Modell-y bleibt positiv:
    // render3d bekommt `end[1]` ≈ +4 und macht daraus world-z ≈ +4 (mesh.rs: `end[1] − start[1]`).
    const bands = model.walls.filter((m) => Math.abs(m.start[0] - 5) < 0.6 && Math.abs(m.end[0] - 5) < 0.6 && m.end[1] > 3.3 && m.start[1] < 0.6);
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) {
      expect(Math.abs(b.start[1])).toBeLessThan(0.6);
      expect(Math.abs(b.end[1] - 4)).toBeLessThan(0.6);
      // Der Fusspunkt des Bandes im Modell (x, y, Höhe) ↔ world, wie ihn der Renderer aufbaut.
      expect(modelToWorld([b.end[0], b.end[1], b.baseElevation + b.height])).toEqual([b.end[0], b.baseElevation + b.height, b.end[1]]);
    }
  });
});

describe("Orbit ↔ Kamera ↔ Modell-Sicht", () => {
  const iso: OrbitState = { yaw: Math.PI / 4, pitch: Math.asin(1 / Math.sqrt(3)), dist: 20, target: [3, 1.5, -2], ortho: false, orthoHalfHeight: 9 };

  it("Orbit → Kamera → Orbit ergibt denselben Zustand", () => {
    const back = orbitFromCamera3d(orbitCamera(iso))!;
    expect(back.yaw).toBeCloseTo(iso.yaw, 9);
    expect(back.pitch).toBeCloseTo(iso.pitch, 9);
    expect(back.dist).toBeCloseTo(iso.dist, 9);
    close(back.target, iso.target);
    expect(back.ortho).toBe(false);
  });

  it("Blick aus Süd-Ost-oben in Modell-Koordinaten: Position und Richtung sind gespiegelte world-Werte", () => {
    const cam = orbitCamera(iso);
    const vc = viewCameraFromCamera3d(cam, 1.6)!;
    // eye (world) → Modell: y und z getauscht
    close(vc.position, [cam.eye[0], cam.eye[2], cam.eye[1]]);
    // Das Ziel liegt in Blickrichtung vor der Kamera: position + dir·dist = target (Modell).
    const t = [vc.position[0] + vc.direction[0] * iso.dist, vc.position[1] + vc.direction[1] * iso.dist, vc.position[2] + vc.direction[2] * iso.dist];
    close(t, [iso.target[0], iso.target[2], iso.target[1]]);
    // Der Blick geht abwärts (Modell-z der Richtung < 0), Up zeigt aufwärts.
    expect(vc.direction[2]).toBeLessThan(0);
    expect(vc.up[2]).toBeGreaterThan(0);
    // Up steht senkrecht auf der Blickrichtung, beide normiert.
    expect(vc.direction[0] * vc.up[0] + vc.direction[1] * vc.up[1] + vc.direction[2] * vc.up[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(...vc.up)).toBeCloseTo(1, 9);
    expect(Math.hypot(...vc.direction)).toBeCloseTo(1, 9);
    expect(vc.fovDeg).toBeCloseTo(50, 9);
    expect(vc.aspect).toBe(1.6);
  });

  it("getCamera → setCamera ergibt dieselbe Kamera (perspektivisch)", () => {
    const cam = orbitCamera(iso);
    const vc = viewCameraFromCamera3d(cam, 1.5)!;
    const back = camera3dFromViewCamera(vc, iso.dist)!;
    close(back.eye, cam.eye);
    close(back.target, cam.target);
    expect(back.perspective).toBe(true);
    expect(back.fovY).toBeCloseTo(FOV_Y, 9);
    // Up ist orthogonalisiert, steht aber in derselben Ebene wie (0,1,0) und die Blickrichtung.
    expect(back.up[0] * (cam.target[0] - cam.eye[0]) + back.up[1] * (cam.target[1] - cam.eye[1]) + back.up[2] * (cam.target[2] - cam.eye[2])).toBeCloseTo(0, 9);
    const o2 = orbitFromCamera3d(back)!;
    expect(o2.yaw).toBeCloseTo(iso.yaw, 9);
    expect(o2.pitch).toBeCloseTo(iso.pitch, 9);
  });

  it("orthografisch: Sichthöhe wird als volle Höhe geführt und kommt als Halbhöhe zurück", () => {
    const o: OrbitState = { ...iso, ortho: true, orthoHalfHeight: 7.25 };
    const vc = viewCameraFromCamera3d(orbitCamera(o), 2)!;
    expect(vc.kind).toBe("orthogonal");
    expect(vc.orthoHeight).toBeCloseTo(14.5, 9);
    const back = camera3dFromViewCamera(vc, 20)!;
    expect(back.perspective).toBe(false);
    expect(back.orthoHalfHeight).toBeCloseTo(7.25, 9);
  });

  it("Blick von oben (Grundriss): Up liegt in der Grundrissebene", () => {
    const top: OrbitState = { yaw: Math.PI / 2, pitch: Math.PI / 2, dist: 30, target: [5, 0, 5], ortho: true, orthoHalfHeight: 12 };
    const vc = viewCameraFromCamera3d(orbitCamera(top), 1)!;
    expect(vc.direction[2]).toBeLessThan(-0.9999999);
    expect(Math.abs(vc.up[2])).toBeLessThan(2e-4);
    expect(Math.hypot(vc.up[0], vc.up[1])).toBeGreaterThan(0.99);
  });

  it("entartete Kameras ergeben null statt NaN", () => {
    const cam: Camera3d = { eye: [1, 1, 1], target: [1, 1, 1], up: [0, 1, 0], perspective: true, fovY: 0.8, orthoHalfHeight: 5 };
    expect(viewCameraFromCamera3d(cam, 1)).toBeNull();
    expect(orbitFromCamera3d(cam)).toBeNull();
    const nan: ViewCamera = { kind: "perspective", position: [NaN, 0, 0], direction: [1, 0, 0], up: [0, 0, 1], fovDeg: 50, orthoHeight: 5, aspect: 1 };
    expect(camera3dFromViewCamera(nan, 10)).toBeNull();
    const zero: ViewCamera = { ...nan, position: [0, 0, 0], direction: [0, 0, 0] };
    expect(camera3dFromViewCamera(zero, 10)).toBeNull();
  });

  it("lerpOrbit nimmt den kurzen Weg über ±π", () => {
    const a: OrbitState = { ...iso, yaw: Math.PI - 0.1 };
    const b: OrbitState = { ...iso, yaw: -Math.PI + 0.1 };
    const mid = lerpOrbit(a, b, 0.5);
    expect(Math.cos(mid.yaw)).toBeCloseTo(-1, 6);
    expect(lerpOrbit(a, b, 1).ortho).toBe(b.ortho);
  });
});

describe("Schnittebene", () => {
  it("vertikale Ebene: Punkt und Normale wandern nach world, schräge wird abgelehnt", () => {
    const s = { location: [2, 3, 1] as V3, direction: [0, 2, 0] as V3 };
    expect(isVerticalSection(s)).toBe(true);
    const w = sectionToWorld(s)!;
    close(w.point, [2, 1, 3]);
    close(w.normal, [0, 0, 1]);
    expect(isVerticalSection({ location: [0, 0, 0], direction: [0, 0, 1] })).toBe(false);
    expect(sectionToWorld({ location: [0, 0, 0], direction: [0, 0, 0] })).toBeNull();
  });
});

describe("Registrierung", () => {
  function fakeViewport() {
    const state = { cam: orbitCamera({ yaw: 0.4, pitch: 0.3, dist: 15, target: [1, 2, 3], ortho: false, orthoHalfHeight: 8 }), written: null as Camera3d | null, section: undefined as unknown };
    const a: ViewportCameraApi = {
      read: () => ({ camera: state.cam, aspect: 2 }),
      write: (c) => {
        state.written = c;
        state.cam = c;
        return true;
      },
      snapshot: async () => new Uint8Array([0x89, 0x50]),
      section: (p) => {
        state.section = p;
      },
      fit: () => {},
    };
    return { state, a };
  }

  it("ohne Viewport: null/false, kein Fehler", async () => {
    expect(viewportAvailable()).toBe(false);
    expect(getCamera()).toBeNull();
    expect(await captureSnapshot()).toBeNull();
    expect(setSection(null)).toBe(false);
    const vc: ViewCamera = { kind: "perspective", position: [0, 0, 0], direction: [1, 0, 0], up: [0, 0, 1], fovDeg: 50, orthoHeight: 5, aspect: 1 };
    expect(setCamera(vc)).toBe(false);
  });

  it("getCamera → setCamera am angemeldeten Viewport lässt die Kamera unverändert", () => {
    const { state, a } = fakeViewport();
    registerViewportCamera(a);
    expect(viewportAvailable()).toBe(true);
    const before = state.cam;
    const vc = getCamera()!;
    expect(vc.aspect).toBe(2);
    expect(setCamera(vc)).toBe(true);
    close(state.written!.eye, before.eye);
    // Blickrichtung identisch (das Ziel darf auf der Achse wandern)
    const dir = (c: Camera3d) => {
      const d = [c.target[0] - c.eye[0], c.target[1] - c.eye[1], c.target[2] - c.eye[2]];
      const l = Math.hypot(...d);
      return d.map((x) => x / l);
    };
    close(dir(state.written!), dir(before));
  });

  it("Schnitt setzen und aufheben, Snapshot durchreichen", async () => {
    const { state, a } = fakeViewport();
    registerViewportCamera(a);
    expect(setSection({ location: [0, 5, 0], direction: [0, -1, 0] })).toBe(true);
    expect(state.section).toMatchObject({ point: [0, 0, 5] });
    expect(setSection({ location: [0, 0, 0], direction: [0, 0, 1] })).toBe(false);
    expect(setSection(null)).toBe(true);
    expect(state.section).toBeNull();
    expect(Array.from((await captureSnapshot())!)).toEqual([0x89, 0x50]);
  });

  it("Abmelden entfernt nur die eigene Registrierung", () => {
    const { a } = fakeViewport();
    const off = registerViewportCamera(a);
    const { a: b } = fakeViewport();
    registerViewportCamera(b);
    off(); // a ist nicht mehr angemeldet → b bleibt
    expect(viewportAvailable()).toBe(true);
  });
});
