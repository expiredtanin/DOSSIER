import { describe, expect, it } from "vitest";
import type { Camera, Project } from "../model/types";
import { emptyProject } from "../model/sampleProject";
import {
  cameraEye,
  cameraFromView,
  cameraToView,
  clampFov,
  floorForHeight,
  focalFromFov,
  fovFromFocal,
  isometricAim,
  nextCameraName,
} from "./cameraView";
import { camera3dFromViewCamera, viewCameraFromCamera3d } from "./cameraBridge";

const level = (id: string, baseElevation: number, kind: "floor" | "section" = "floor") =>
  ({ id, name: id, kind, visible: true, locked: false, baseElevation, floorHeight: 2.8 }) as Project["drawingLevels"][number];

const project = (): Project => ({
  ...emptyProject,
  drawingLevels: [level("eg", 0), level("og", 3), level("schnitt", 0, "section")],
});

const cam = (over: Partial<Camera> = {}): Camera => ({
  id: "k1",
  type: "camera",
  name: "Süd",
  floorId: "og",
  categoryCode: "92",
  position: { x: 2, y: -3 },
  eyeHeight: 1.6,
  target: { x: 2, y: 7 },
  targetHeight: 4.6,
  fovDeg: 50,
  projection: "perspective",
  ...over,
});

describe("[213] Kamera → Ansicht", () => {
  it("Augenhöhe liegt über der Geschoss-OK; Blickrichtung zeigt zum Ziel", () => {
    const p = project();
    expect(cameraEye(p, cam())).toEqual([2, -3, 4.6]);
    const v = cameraToView(p, cam())!;
    expect(v.kind).toBe("perspective");
    expect(v.position).toEqual([2, -3, 4.6]);
    expect(v.direction[0]).toBeCloseTo(0, 12);
    expect(v.direction[1]).toBeCloseTo(1, 12);
    expect(v.direction[2]).toBeCloseTo(0, 12);
    expect(v.fovDeg).toBe(50);
    // Up steht senkrecht zur Blickrichtung und zeigt nach oben.
    expect(v.up[2]).toBeCloseTo(1, 12);
    expect(v.up[0] * v.direction[0] + v.up[1] * v.direction[1] + v.up[2] * v.direction[2]).toBeCloseTo(0, 12);
  });

  it("geneigter Blick: Up bleibt senkrecht und normiert", () => {
    const v = cameraToView(project(), cam({ targetHeight: 0 }))!;
    expect(v.direction[2]).toBeLessThan(0);
    expect(Math.hypot(...v.up)).toBeCloseTo(1, 12);
    expect(v.up[0] * v.direction[0] + v.up[1] * v.direction[1] + v.up[2] * v.direction[2]).toBeCloseTo(0, 12);
    expect(v.up[2]).toBeGreaterThan(0);
  });

  it("senkrechter Blick nach unten: Up ist Norden (Grundriss-Lage)", () => {
    const v = cameraToView(project(), cam({ target: { x: 2, y: -3 }, targetHeight: 0 }))!;
    expect(v.direction[2]).toBeCloseTo(-1, 12);
    expect(v.up[1]).toBeCloseTo(1, 9);
  });

  it("Axonometrie und Parallel sind orthogonal mit Sichthöhe; Bildwinkel wird geklemmt", () => {
    const a = cameraToView(project(), cam({ projection: "axonometric", orthoHeight: 8 }))!;
    expect(a.kind).toBe("orthogonal");
    expect(a.orthoHeight).toBe(8);
    expect(cameraToView(project(), cam({ projection: "parallel" }))!.orthoHeight).toBe(10);
    expect(cameraToView(project(), cam({ fovDeg: 500 }))!.fovDeg).toBe(120);
    expect(clampFov(NaN)).toBe(50);
  });

  it("Standpunkt gleich Ziel oder NaN: keine Ansicht", () => {
    expect(cameraToView(project(), cam({ target: { x: 2, y: -3 }, targetHeight: 4.6 }))).toBeNull();
    expect(cameraToView(project(), cam({ position: { x: NaN, y: 0 } }))).toBeNull();
  });

  it("liefert dieselbe Struktur wie die aktive 3D-Ansicht: Umweg über die Viewport-Kamera ist verlustfrei", () => {
    const v = cameraToView(project(), cam({ targetHeight: 2 }), 1.5)!;
    const c3 = camera3dFromViewCamera(v, 10)!;
    const back = viewCameraFromCamera3d(c3, 1.5)!;
    expect(back.kind).toBe(v.kind);
    back.position.forEach((x, i) => expect(x).toBeCloseTo(v.position[i], 9));
    back.direction.forEach((x, i) => expect(x).toBeCloseTo(v.direction[i], 9));
    back.up.forEach((x, i) => expect(x).toBeCloseTo(v.up[i], 9));
    expect(back.fovDeg).toBeCloseTo(v.fovDeg, 9);
    expect(back.aspect).toBe(1.5);
  });
});

describe("[213] Ansicht → Kamera", () => {
  it("Standpunkt bestimmt Geschoss und Augenhöhe; Ziel liegt auf der Blickachse", () => {
    const p = project();
    const view = cameraToView(p, cam({ targetHeight: 3.6 }))!;
    const made = cameraFromView(p, view, { id: "k2", name: "Neu", fallbackFloorId: "eg", distance: Math.hypot(10, 1) });
    expect(made.floorId).toBe("og");
    expect(made.eyeHeight).toBeCloseTo(1.6, 9);
    expect(made.position).toEqual({ x: 2, y: -3 });
    expect(made.target.x).toBeCloseTo(2, 9);
    expect(made.target.y).toBeCloseTo(7, 9);
    expect(made.targetHeight).toBeCloseTo(3.6, 9);
    expect(made.projection).toBe("perspective");
    expect(made.categoryCode).toBe("92");
    expect(made.type).toBe("camera");
    // Wieder in die Ansicht: dieselbe Kamera.
    const again = cameraToView(p, made)!;
    again.position.forEach((x, i) => expect(x).toBeCloseTo(view.position[i], 9));
    again.direction.forEach((x, i) => expect(x).toBeCloseTo(view.direction[i], 9));
  });

  it("orthografische Ansicht wird zur Parallelprojektion mit Sichthöhe", () => {
    const p = project();
    const view = cameraToView(p, cam({ projection: "axonometric", orthoHeight: 12 }))!;
    const made = cameraFromView(p, view, { id: "k3", name: "Ortho", fallbackFloorId: "eg" });
    expect(made.projection).toBe("parallel");
    expect(made.orthoHeight).toBe(12);
  });

  it("Geschoss zu einer Höhe: höchstes mit OK ≤ z, sonst das unterste, Schnitte zählen nicht", () => {
    const p = project();
    expect(floorForHeight(p, 4.6, "x")).toBe("og");
    expect(floorForHeight(p, 2.99, "x")).toBe("eg");
    expect(floorForHeight(p, -5, "x")).toBe("eg");
    expect(floorForHeight(p, NaN, "x")).toBe("x");
    expect(floorForHeight({ ...p, drawingLevels: [] }, 1, "fallback")).toBe("fallback");
  });

  it("Namen zählen hoch", () => {
    const p = { ...project(), cameras: [cam({ name: "Kamera 1" }), cam({ id: "k2", name: "Kamera 2" })] };
    expect(nextCameraName(p, "Kamera")).toBe("Kamera 3");
    expect(nextCameraName(project(), "Kamera")).toBe("Kamera 1");
  });
});

describe("[213] Brennweite und Axonometrie", () => {
  it("Brennweite ↔ Bildwinkel (24 mm Sensorhöhe)", () => {
    expect(fovFromFocal(focalFromFov(50))).toBeCloseTo(50, 9);
    expect(fovFromFocal(35)).toBeCloseTo(37.85, 1);
  });

  it("Isometrie-Ausrichtung behält das Ziel im Blick und neigt 35.264°", () => {
    const p = project();
    const c = cam({ projection: "axonometric" });
    const aim = isometricAim(p, c);
    const next = { ...c, ...aim };
    const v = cameraToView(p, next)!;
    // Blick nach oben-rechts hinten: 45° im Grundriss, 35.264° nach unten.
    expect(v.direction[0]).toBeCloseTo(Math.SQRT1_2 * Math.cos(Math.atan(1 / Math.SQRT2)), 6);
    expect(v.direction[1]).toBeCloseTo(Math.SQRT1_2 * Math.cos(Math.atan(1 / Math.SQRT2)), 6);
    expect(v.direction[2]).toBeCloseTo(-Math.sin(Math.atan(1 / Math.SQRT2)), 6);
  });
});
