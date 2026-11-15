// [118] Kamera-Brücke ohne lebenden Renderer: Lesen/Setzen geht, Bilder liefern null.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureImage, captureSnapshot, getCamera, registerViewportCamera, setCamera, viewportAvailable, type OrbitState, type ViewCamera } from "./cameraBridge";
import { cameraAfterReady, createViewportCameraApi, type ViewportCameraHost } from "./viewportCameraApi";

beforeEach(() => {
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("requestAnimationFrame", () => 1);
});
afterEach(() => {
  registerViewportCamera(null);
  vi.unstubAllGlobals();
});

const orbit0: OrbitState = { yaw: 0.5, pitch: 0.4, dist: 20, target: [0, 0, 0], ortho: false, orthoHalfHeight: 5 };

function deadHost() {
  const st = { orbit: orbit0 as OrbitState | null, redraws: 0, orbitMode: false };
  const host: ViewportCameraHost = {
    getOrbit: () => st.orbit,
    setOrbit: (o) => {
      st.orbit = o;
    },
    getRect: () => ({ width: 800, height: 400 }),
    useOrbitRedraw: () => {
      st.orbitMode = true;
    },
    redraw: () => {
      st.redraws++;
    },
    snapshot: async () => null,
    exportImage: async () => null,
    setSection: () => {},
    fit: () => {},
    canvas: () => null,
  };
  return { st, host };
}

describe("Kamera-Brücke ohne GPU-Renderer", () => {
  it("Kamera lesbar und setzbar, Bilder null", async () => {
    const { st, host } = deadHost();
    const { api } = createViewportCameraApi(host);
    registerViewportCamera(api);
    expect(viewportAvailable()).toBe(true);
    const vc = getCamera()!;
    expect(vc.aspect).toBe(2);
    const next: ViewCamera = { ...vc, position: [10, 20, 5], direction: [0, 1, 0], up: [0, 0, 1] };
    expect(setCamera(next)).toBe(true);
    expect(st.orbitMode).toBe(true);
    const back = getCamera()!;
    expect(back.position[0]).toBeCloseTo(10, 6);
    expect(back.position[1]).toBeCloseTo(20, 6);
    expect(back.position[2]).toBeCloseTo(5, 6);
    expect(await captureSnapshot()).toBeNull();
    expect(await captureImage({ width: 10, height: 10 })).toBeNull();
  });

  it("Neu anmelden ohne Lücke: die alte Abmeldung entfernt die neue Anmeldung nicht", () => {
    const a = createViewportCameraApi(deadHost().host);
    const offA = registerViewportCamera(a.api);
    const b = createViewportCameraApi(deadHost().host);
    registerViewportCamera(b.api);
    offA();
    expect(viewportAvailable()).toBe(true);
    expect(getCamera()).not.toBeNull();
  });
});

describe("Kamera nach Neuaufbau des Renderers ([118])", () => {
  it("Preset nur beim ersten Aufbau oder bei Wechsel, sonst bleibt der Orbit", () => {
    expect(cameraAfterReady({ hasOrbit: false, appliedPreset: null, view3d: "iso", orbitMode: false })).toBe("preset");
    expect(cameraAfterReady({ hasOrbit: true, appliedPreset: "iso", view3d: "iso", orbitMode: true })).toBe("redraw");
    expect(cameraAfterReady({ hasOrbit: true, appliedPreset: "iso", view3d: "front", orbitMode: true })).toBe("preset");
    expect(cameraAfterReady({ hasOrbit: true, appliedPreset: "iso", view3d: "iso", orbitMode: false })).toBe("preset");
  });
});
