// BCF-Kamera: Rundreise Viewport → BCF → Viewport, mit und ohne Standort-Bezug (LV95-Versatz).

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import type { BcfViewpoint } from "../io/bcf";
import { addTopic, emptyBcf, newTopic, newViewpoint, parseBcf, writeBcf } from "../io/bcf";
import {
  bcfCameraFromView,
  bcfClippingFromSection,
  firstViewpointWithCamera,
  sectionFromBcfClipping,
  viewCameraFromBcf,
  viewpointForTopic,
} from "./bcfView";
import { orbitCamera, orbitFromCamera3d, viewCameraFromCamera3d, camera3dFromViewCamera, type OrbitState, type ViewCamera } from "../viewport/cameraBridge";

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const origin = { e: 2_600_000, n: 1_200_000 };

const orbit: OrbitState = { yaw: 1.1, pitch: 0.45, dist: 18, target: [12, 3, -7], ortho: false, orthoHalfHeight: 8 };

describe("BCF-Kamera", () => {
  it("Modell → BCF addiert den LV95-Versatz auf x/y, nicht auf z", () => {
    const vc = viewCameraFromCamera3d(orbitCamera(orbit), 1.5)!;
    const bc = bcfCameraFromView(vc, origin);
    expect(bc.kind).toBe("perspective");
    expect(bc.position[0]).toBeCloseTo(vc.position[0] + origin.e, 6);
    expect(bc.position[1]).toBeCloseTo(vc.position[1] + origin.n, 6);
    expect(bc.position[2]).toBeCloseTo(vc.position[2], 9);
    // Richtungen werden nicht verschoben
    close(bc.direction, vc.direction, 12);
    close(bc.up, vc.up, 12);
    expect(bc.aspectRatio).toBeCloseTo(1.5, 9);
    expect(bc.fieldOfView).toBeCloseTo(50, 9);
  });

  it("Rundreise perspektivisch mit Bezug: Viewport → BCF → Viewport gibt dieselbe Kamera", () => {
    const cam = orbitCamera(orbit);
    const vc = viewCameraFromCamera3d(cam, 1.78)!;
    // über die Datei-Grenze: JSON wie `bcf_write`/`bcf_read`
    const bc = JSON.parse(JSON.stringify(bcfCameraFromView(vc, origin)));
    const back = viewCameraFromBcf(bc, origin, 1.78)!;
    close(back.position, vc.position, 6);
    close(back.direction, vc.direction, 9);
    close(back.up, vc.up, 9);
    expect(back.fovDeg).toBeCloseTo(vc.fovDeg, 9);
    const cam2 = camera3dFromViewCamera(back, orbit.dist)!;
    close(cam2.eye, cam.eye, 6);
    close(cam2.target, cam.target, 6);
    const o2 = orbitFromCamera3d(cam2)!;
    expect(o2.yaw).toBeCloseTo(orbit.yaw, 7);
    expect(o2.pitch).toBeCloseTo(orbit.pitch, 7);
  });

  it("Rundreise ohne Bezug (Versatz null)", () => {
    const vc = viewCameraFromCamera3d(orbitCamera(orbit), 1)!;
    const bc = bcfCameraFromView(vc, null);
    close(bc.position, vc.position, 12);
    close(viewCameraFromBcf(bc, null, 1)!.position, vc.position, 12);
  });

  it("orthografisch: ViewToWorldScale ist die Breite, die Rückrechnung nimmt das Seitenverhältnis des Viewports", () => {
    const o: OrbitState = { ...orbit, ortho: true, orthoHalfHeight: 6 };
    const vc = viewCameraFromCamera3d(orbitCamera(o), 2)!;
    const bc = bcfCameraFromView(vc, origin);
    expect(bc.kind).toBe("orthogonal");
    expect(bc.viewToWorldScale).toBeCloseTo(12 * 2, 9); // Höhe 12 m × Seitenverhältnis 2
    // BCF schreibt für Ortho kein AspectRatio zurück (0) → Viewport-Verhältnis zählt
    const back = viewCameraFromBcf({ ...bc, aspectRatio: 0 }, origin, 2)!;
    expect(back.kind).toBe("orthogonal");
    expect(back.orthoHeight).toBeCloseTo(12, 9);
    // Anderes Fenster beim Empfänger (Breite bleibt, Höhe ändert sich)
    expect(viewCameraFromBcf({ ...bc, aspectRatio: 0 }, origin, 3)!.orthoHeight).toBeCloseTo(8, 9);
  });

  it("fehlender oder unsinniger Öffnungswinkel fällt auf den Standard, Nullrichtung ergibt null", () => {
    const base = bcfCameraFromView(viewCameraFromCamera3d(orbitCamera(orbit), 1)!, null);
    expect(viewCameraFromBcf({ ...base, fieldOfView: 0 }, null, 1)!.fovDeg).toBe(60);
    expect(viewCameraFromBcf({ ...base, direction: [0, 0, 0] }, null, 1)).toBeNull();
    expect(viewCameraFromBcf({ ...base, position: [NaN, 0, 0] }, null, 1)).toBeNull();
  });

  it("zu einer ViewCamera aus BCF passt dasselbe Objekt wieder zurück (Modell → BCF → Modell)", () => {
    const vc: ViewCamera = { kind: "perspective", position: [3, 4, 5], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45, orthoHeight: 0, aspect: 1.2 };
    const back = viewCameraFromBcf(bcfCameraFromView(vc, origin), origin, 1.2)!;
    close(back.position, vc.position);
    close(back.direction, vc.direction);
    close(back.up, vc.up);
    expect(back.fovDeg).toBeCloseTo(45, 9);
  });
});

describe("BCF-Schnittebenen", () => {
  it("Modell ↔ BCF mit Versatz, schräge Ebenen werden nicht übernommen", () => {
    const bc = bcfClippingFromSection({ location: [1, 2, 3], direction: [0, 1, 0] }, origin);
    expect(bc.location).toEqual([1 + origin.e, 2 + origin.n, 3]);
    const back = sectionFromBcfClipping(bc, origin)!;
    close(back.location, [1, 2, 3]);
    expect(sectionFromBcfClipping({ location: [0, 0, 0], direction: [0, 0, 1] }, null)).toBeNull();
  });
});

describe("Viewpoint-Wahl", () => {
  const vp = (guid: string, withCam: boolean): BcfViewpoint => {
    const v = newViewpoint(guid, []);
    if (withCam) v.camera = { kind: "perspective", position: [0, 0, 0], direction: [1, 0, 0], up: [0, 0, 1], fieldOfView: 60, viewToWorldScale: 0, aspectRatio: 1 };
    return v;
  };
  it("erster Viewpoint mit Kamera; sonst null", () => {
    const topic = { viewpoints: [vp("a", false), vp("b", true), vp("c", true)] };
    expect(firstViewpointWithCamera(topic)?.guid).toBe("b");
    expect(firstViewpointWithCamera({ viewpoints: [vp("a", false)] })).toBeNull();
  });
  it("viewpointForTopic füllt Kamera, Snapshot und Auswahl", () => {
    const cam = viewCameraFromCamera3d(orbitCamera(orbit), 1)!;
    const v = viewpointForTopic({ guid: "g1", ifcGuids: ["AAAAAAAAAAAAAAAAAAAAAA"], camera: cam, snapshotPng: new Uint8Array([1, 2, 3]), origin });
    expect(v.guid).toBe("g1");
    expect(v.camera?.kind).toBe("perspective");
    expect(v.snapshot).toBe("AQID"); // Base64 von 01 02 03
    expect(v.selection.map((c) => c.ifcGuid)).toEqual(["AAAAAAAAAAAAAAAAAAAAAA"]);
    const none = viewpointForTopic({ guid: "g2", ifcGuids: [], camera: null, snapshotPng: null, origin: null });
    expect(none.camera).toBeNull();
    expect(none.snapshot).toBe("");
  });
});

describe("Rundreise über die .bcfzip (Rust)", () => {
  it("Kamera + Schnittebene überstehen Schreiben und Lesen, auch mit LV95-Versatz", async () => {
    const cam = viewCameraFromCamera3d(orbitCamera(orbit), 1.6)!;
    const section = { location: [4, 2, 0] as [number, number, number], direction: [0, -1, 0] as [number, number, number] };
    const vp = viewpointForTopic({ guid: "11111111-1111-4111-8111-111111111111", ifcGuids: [], camera: cam, snapshotPng: null, origin, section });
    for (const version of ["2.1", "3.0"] as const) {
      const file = addTopic(emptyBcf("p", "T"), newTopic({ guid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "t", author: "a", now: "2026-10-28T10:00:00Z", viewpoints: [vp] }));
      const back = await parseBcf(await writeBcf(file, version));
      const v = back.topics[0].viewpoints[0];
      const restored = viewCameraFromBcf(v.camera!, origin, 1.6)!;
      close(restored.position, cam.position, 4); // Text-Zahlen der Datei: mm genügen
      close(restored.direction, cam.direction, 6);
      close(restored.up, cam.up, 6);
      expect(restored.fovDeg).toBeCloseTo(cam.fovDeg, 6);
      const sec = sectionFromBcfClipping(v.clippingPlanes[0], origin)!;
      close(sec.location, section.location, 4);
      close(sec.direction, section.direction, 6);
    }
  });

  it("orthogonale Kamera: ViewToWorldScale kommt zurück, Seitenverhältnis liefert der Viewport", async () => {
    const o: OrbitState = { ...orbit, ortho: true, orthoHalfHeight: 5 };
    const cam = viewCameraFromCamera3d(orbitCamera(o), 2)!;
    const vp = viewpointForTopic({ guid: "22222222-2222-4222-8222-222222222222", ifcGuids: [], camera: cam, snapshotPng: null, origin: null });
    const file = addTopic(emptyBcf("p", "T"), newTopic({ guid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "t", author: "a", now: "2026-10-28T10:00:00Z", viewpoints: [vp] }));
    const back = await parseBcf(await writeBcf(file, "2.1"));
    const restored = viewCameraFromBcf(back.topics[0].viewpoints[0].camera!, null, 2)!;
    expect(restored.kind).toBe("orthogonal");
    expect(restored.orthoHeight).toBeCloseTo(10, 6);
  });
});
