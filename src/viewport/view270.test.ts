// [270] Blickrichtungen überall gleich: die 3D-Ansicht zeigt das Modell seitenrichtig (Erker im Osten rechts, wenn von
// Süden geblickt), die Orbit-Startlagen der Blickwinkel stimmen mit `render3d::view_dir` überein, und Pick-Strahl,
// Griff-Projektion, Pan und Begehen nehmen dasselbe „rechts“ wie render3d (`math::view_matrix`).

import { describe, expect, it } from "vitest";
import { VIEW3D_ORBIT, modelToWorld, orbitCamera, orbitRight, screenRight, type OrbitState } from "./cameraBridge";
import { cameraRay, worldToScreen } from "./raycast3d";
import { lookAround, orbitEye, walkVelocity, NO_KEYS } from "./walk";
import type { View3d } from "../model/viewTypes";

/** Testhaus (Modell x = Ost, y = Nord): Erker im Osten, Garage im Westen, Nordflügel. */
const ERKER = modelToWorld([6, 0, 1]);
const GARAGE = modelToWorld([-6, 0, 1]);
const NORD = modelToWorld([0, 6, 1]);
const SUED = modelToWorld([0, -6, 1]);

const orbit = (view: View3d): OrbitState => ({ ...VIEW3D_ORBIT[view], dist: 40, target: [0, 1, 0], ortho: false, orthoHalfHeight: 10 });

function screen(view: View3d, p: readonly number[]) {
  const c = orbitCamera(orbit(view));
  const s = worldToScreen({ eye: c.eye, target: c.target, up: c.up, fovY: Math.PI / 4, perspective: true, orthoHalfHeight: 10 }, p as [number, number, number], 800, 600);
  if (!s) throw new Error("hinter der Kamera");
  return s;
}

describe("[270] 3D-Ansicht seitenrichtig", () => {
  it("Blickwinkel stehen in der Himmelsrichtung der gemeinsamen Tabelle (vorne = Süd, rechts = Ost, iso = Südost)", () => {
    // Richtung zum Betrachter (Modell Ost, Nord) je Blickwinkel, wie `render3d::view_dir`.
    const want: Record<View3d, [number, number]> = {
      front: [0, -1], back: [0, 1], side: [1, 0], left: [-1, 0], top: [0, -1],
      iso: [1, -1], isoFrontLeft: [-1, -1], isoBackRight: [1, 1], isoBackLeft: [-1, 1], perspective: [1, -1],
    };
    for (const [view, [e, n]] of Object.entries(want) as [View3d, [number, number]][]) {
      const eye = orbitEye(orbit(view));
      const toViewer = [eye[0], eye[2]]; // world (x, ·, z) = Modell (Ost, Nord)
      expect(Math.sign(Math.round(toViewer[0] * 1e6)), view).toBe(Math.sign(e));
      expect(Math.sign(Math.round(toViewer[1] * 1e6)), view).toBe(Math.sign(n));
    }
  });

  it("Erker im Osten erscheint von Süden/Südost rechts, von Norden/Nordwest links; Draufsicht mit Norden oben", () => {
    for (const v of ["front", "iso", "isoFrontLeft", "perspective"] as View3d[]) {
      expect(screen(v, ERKER).x, v).toBeGreaterThan(screen(v, GARAGE).x);
    }
    for (const v of ["back", "isoBackLeft", "isoBackRight"] as View3d[]) {
      expect(screen(v, ERKER).x, v).toBeLessThan(screen(v, GARAGE).x);
    }
    expect(screen("side", NORD).x).toBeGreaterThan(screen("side", SUED).x); // von Osten: Norden rechts
    expect(screen("top", NORD).y).toBeLessThan(screen("top", SUED).y); // Bild-y wächst nach unten
    expect(screen("top", ERKER).x).toBeGreaterThan(screen("top", GARAGE).x);
  });

  it("Pick-Strahl ist die Umkehrung der Griff-Projektion (rechts = oben × Blick)", () => {
    const c = orbitCamera(orbit("iso"));
    const cam = { eye: c.eye, target: c.target, up: c.up, fovY: Math.PI / 4, perspective: true, orthoHalfHeight: 10 };
    const s = worldToScreen(cam, ERKER as [number, number, number], 800, 600)!;
    const ray = cameraRay(cam, (s.x / 800) * 2 - 1, 1 - (s.y / 600) * 2, 800 / 600);
    const toP = ERKER.map((v, i) => v - ray.origin[i]);
    const t = toP[0] * ray.dir[0] + toP[1] * ray.dir[1] + toP[2] * ray.dir[2];
    const miss = Math.hypot(...toP.map((v, i) => v - ray.dir[i] * t));
    expect(miss).toBeLessThan(1e-6);
  });

  it("orbitRight = screenRight der Orbit-Kamera; Begehen und Umschauen drehen nach rechts im Bild", () => {
    for (const yaw of [0, 0.7, -2.1]) {
      const o: OrbitState = { yaw, pitch: 0.3, dist: 10, target: [0, 0, 0], ortho: false, orthoHalfHeight: 5 };
      const c = orbitCamera(o);
      const f = c.target.map((v, i) => v - c.eye[i]);
      const r = screenRight(f, c.up);
      orbitRight(yaw).forEach((v, i) => expect(v).toBeCloseTo(r[i], 9));
      // Seitwärts rechts läuft entlang Bild-rechts.
      const w = walkVelocity({ ...NO_KEYS, right: true }, yaw, 1);
      expect(w[0] * r[0] + w[2] * r[2]).toBeCloseTo(1, 9);
      // Umschauen mit der Maus nach rechts: die neue Blickrichtung hat einen Anteil nach Bild-rechts.
      const n = orbitCamera(lookAround(o, 50, 0));
      const nf = n.target.map((v, i) => v - n.eye[i]);
      expect(nf[0] * r[0] + nf[2] * r[2]).toBeGreaterThan(0);
    }
  });
});
