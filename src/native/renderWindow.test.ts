// [277] Brücke des Rendering-Fensters: nur Geändertes geht über die Leitung (Fortschritt ohne Bild/Vorgaben), Lage des Fensters
// wird robust gelesen, Vorschau-Kodierung rundet sich.
import { describe, expect, it } from "vitest";
import { applyStateDelta, stateDelta } from "./windowBridge";
import { RENDER_WINDOW_SIZE, bytesToBase64, parseWindowGeometry, type RenderSyncState } from "./renderWindow";
import { IDLE_RENDER_JOB, type RenderSetupInfo } from "../state/renderJob";

const INFO: RenderSetupInfo = {
  defaultWhenMs: 1_000_000,
  latLon: { lat: 47.4, lon: 8.5 },
  cameras: [{ id: "k1", name: "Eingang", camera: { preset: "front" }, sunWhenMs: 2_000_000 }],
  livePreset: "iso",
  view: { view: {}, labels: { renovation: null, combination: null } },
  layouts: [{ id: "l1", name: "Blatt 1" }],
  defaultLayoutId: "l1",
  blenderPath: "",
};
const base = (): RenderSyncState => ({ info: INFO, job: { ...IDLE_RENDER_JOB, phase: "running", status: "Sample 1 von 8", fraction: 0.1 }, image: null });

describe("Sync-Zustand des Rendering-Fensters", () => {
  it("Fortschritt: nur `job` im Patch, Vorgaben und Bild bleiben draussen", () => {
    const a = base();
    const b: RenderSyncState = { ...a, job: { ...a.job, fraction: 0.5, status: "Sample 4 von 8" } };
    const d = stateDelta(a, b);
    expect(d).not.toBeNull();
    expect(d).not.toBe("full");
    const delta = d as Exclude<typeof d, null | "full">;
    expect(Object.keys(delta.set)).toEqual(["job"]);
    expect(applyStateDelta(a, delta)).toEqual(b);
  });

  it("neu aufgebaute, inhaltlich gleiche Vorgaben: nichts senden", () => {
    const a = base();
    const b: RenderSyncState = { ...a, info: JSON.parse(JSON.stringify(INFO)) as RenderSetupInfo };
    expect(stateDelta(a, b)).toBeNull();
  });

  it("fertiges Bild kommt einmal als eigenes Feld; danach ändert sich nichts mehr", () => {
    const a = base();
    const done: RenderSyncState = { ...a, job: { ...a.job, phase: "done", hasImage: true, imageSeq: 1 }, image: "AAAA" };
    const d = stateDelta(a, done) as Exclude<ReturnType<typeof stateDelta>, null | "full">;
    expect(Object.keys(d.set).sort()).toEqual(["image", "job"]);
    expect(stateDelta(done, { ...done })).toBeNull();
    // Zurücksetzen: Bild fällt wieder auf null (kein `undefined`, das JSON verlöre).
    const again: RenderSyncState = { ...done, job: { ...done.job, phase: "setup", hasImage: false, imageSeq: 2 }, image: null };
    const d2 = stateDelta(done, again) as Exclude<ReturnType<typeof stateDelta>, null | "full">;
    expect(d2.set.image).toBeNull();
    expect(applyStateDelta(done, d2)).toEqual(again);
  });

  it("der ganze Zustand übersteht JSON (Tauri-Ereignis)", () => {
    const s = base();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("Lage des Fensters", () => {
  const ok = { x: 100, y: 80, width: 520, height: 700 };
  it("gültige Lage wird gelesen und gerundet", () => {
    expect(parseWindowGeometry(JSON.stringify({ ...ok, x: 100.4 }))).toEqual(ok);
    expect(parseWindowGeometry(JSON.stringify({ ...ok, x: -300 }))?.x).toBe(-300); // zweiter Bildschirm links
  });
  it("Unsinn gibt null", () => {
    expect(parseWindowGeometry(null)).toBeNull();
    expect(parseWindowGeometry("kaputt")).toBeNull();
    expect(parseWindowGeometry(JSON.stringify({ ...ok, width: 10 }))).toBeNull();
    expect(parseWindowGeometry(JSON.stringify({ ...ok, height: RENDER_WINDOW_SIZE.minHeight - 1 }))).toBeNull();
    expect(parseWindowGeometry(JSON.stringify({ ...ok, x: "1" }))).toBeNull();
    expect(parseWindowGeometry(JSON.stringify({ ...ok, y: 1e9 }))).toBeNull();
  });
});

describe("Vorschau-Kodierung", () => {
  it("Base64 grosser Puffer entspricht Buffer.from", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});
