// Unit-Tests der reinen Ausschnitt-Logik (src/state/viewSnapshots.ts):
// Capture aus einem Zustand → ViewSnapshot mit allen Feldern; Read →
// Kernzustand; Roundtrip capture→read; Override-Aktiv-Menge wiederherstellen;
// Robustheit gegen fehlende optionale Felder (Alt-/Fremd-Snapshots).

import { describe, it, expect } from "vitest";
import type { OverrideRule, ViewSnapshot } from "../model/types";
import {
  captureViewSnapshot,
  readViewSnapshot,
  applyOverrideRuleEnabled,
  snapshotMatchesLiveState,
  boolMapEqual,
  matchingComboName,
  type ViewSnapshotState,
} from "./viewSnapshots";

/** Ein voll besetzter Beispiel-Kernzustand. */
function sampleState(): ViewSnapshotState {
  return {
    viewType: "perspektive",
    view3d: "iso",
    fov: 42,
    scaleDenominator: 50,
    detail: "fein",
    activeLevelId: "floor-2",
    layerVisibility: { "20": true, "30": false },
    drawingVisibility: { "floor-1": true, "floor-2": false },
    enabledOverrideRuleIds: ["r1", "r3"],
  };
}

describe("viewSnapshots — captureViewSnapshot", () => {
  it("erfasst alle Felder + Meta (id/name)", () => {
    const snap = captureViewSnapshot("vs-1", "Nord EG", sampleState());
    expect(snap).toMatchObject({
      id: "vs-1",
      name: "Nord EG",
      viewType: "perspektive",
      view3d: "iso",
      fov: 42,
      scaleDenominator: 50,
      detail: "fein",
      activeLevelId: "floor-2",
      layerVisibility: { "20": true, "30": false },
      drawingVisibility: { "floor-1": true, "floor-2": false },
      enabledOverrideRuleIds: ["r1", "r3"],
    });
    expect(snap.folder).toBeUndefined();
  });

  it("übernimmt einen (getrimmten) Ordner, ignoriert Leerstrings", () => {
    expect(captureViewSnapshot("a", "n", sampleState(), "  Pläne  ").folder).toBe(
      "Pläne",
    );
    expect(captureViewSnapshot("a", "n", sampleState(), "   ").folder).toBeUndefined();
  });

  it("koppelt die Maps/Arrays vom Live-Zustand ab (Kopie, keine Referenz)", () => {
    const st = sampleState();
    const snap = captureViewSnapshot("a", "n", st);
    st.layerVisibility["20"] = false;
    st.drawingVisibility["floor-1"] = false;
    st.enabledOverrideRuleIds.push("r9");
    expect(snap.layerVisibility["20"]).toBe(true);
    expect(snap.drawingVisibility["floor-1"]).toBe(true);
    expect(snap.enabledOverrideRuleIds).toEqual(["r1", "r3"]);
  });
});

describe("viewSnapshots — Kamera (cameraCenter/cameraPxPerMeter)", () => {
  it("captureViewSnapshot übernimmt eine gegebene Kamera", () => {
    const st = { ...sampleState(), cameraCenter: { x: 3, y: -4 }, cameraPxPerMeter: 72 };
    const snap = captureViewSnapshot("vs-1", "Mit Kamera", st);
    expect(snap.cameraCenter).toEqual({ x: 3, y: -4 });
    expect(snap.cameraPxPerMeter).toBe(72);
  });

  it("captureViewSnapshot lässt die Kamera weg, wenn sie im Kernzustand fehlt", () => {
    const snap = captureViewSnapshot("vs-1", "Ohne Kamera", sampleState());
    expect(snap.cameraCenter).toBeUndefined();
    expect(snap.cameraPxPerMeter).toBeUndefined();
  });

  it("koppelt cameraCenter vom Live-Zustand ab (Kopie, keine Referenz)", () => {
    const camera = { x: 1, y: 2 };
    const st = { ...sampleState(), cameraCenter: camera, cameraPxPerMeter: 50 };
    const snap = captureViewSnapshot("a", "n", st);
    camera.x = 999;
    expect(snap.cameraCenter).toEqual({ x: 1, y: 2 });
  });

  it("Roundtrip capture → read erhält die Kamera", () => {
    const st = { ...sampleState(), cameraCenter: { x: 3, y: -4 }, cameraPxPerMeter: 72 };
    const snap = captureViewSnapshot("vs-1", "Mit Kamera", st);
    expect(readViewSnapshot(snap)).toEqual(st);
  });

  it("readViewSnapshot liefert undefined für einen Alt-Ausschnitt ohne Kamera (kein Crash)", () => {
    const legacy: ViewSnapshot = {
      id: "old",
      name: "Alt",
      viewType: "grundriss",
      view3d: "perspective",
      scaleDenominator: 100,
      detail: "mittel",
      activeLevelId: "floor-1",
      layerVisibility: {},
      drawingVisibility: {},
    };
    const st = readViewSnapshot(legacy);
    expect(st.cameraCenter).toBeUndefined();
    expect(st.cameraPxPerMeter).toBeUndefined();
  });

  it("snapshotMatchesLiveState ignoriert eine abweichende Kamera (bewusst ausgenommen)", () => {
    const snap = { ...sampleState(), cameraCenter: { x: 0, y: 0 }, cameraPxPerMeter: 50 };
    const live = { ...sampleState(), cameraCenter: { x: 999, y: 999 }, cameraPxPerMeter: 5 };
    expect(snapshotMatchesLiveState(snap, live)).toBe(true);
  });
});

describe("viewSnapshots — readViewSnapshot", () => {
  it("Roundtrip: capture → read ergibt denselben Kernzustand", () => {
    const st = sampleState();
    const snap = captureViewSnapshot("vs-1", "Nord EG", st);
    expect(readViewSnapshot(snap)).toEqual(st);
  });

  it("füllt fehlende optionale Felder defensiv auf (Alt-Snapshot ohne fov/overrides)", () => {
    const legacy: ViewSnapshot = {
      id: "old",
      name: "Alt",
      viewType: "grundriss",
      view3d: "perspective",
      scaleDenominator: 100,
      detail: "mittel",
      activeLevelId: "floor-1",
      layerVisibility: {},
      drawingVisibility: {},
      // fov + enabledOverrideRuleIds absichtlich weggelassen
    };
    const st = readViewSnapshot(legacy);
    expect(st.fov).toBe(50);
    expect(st.enabledOverrideRuleIds).toEqual([]);
  });
});

describe("viewSnapshots — applyOverrideRuleEnabled", () => {
  const mk = (id: string, enabled: boolean): OverrideRule => ({
    id,
    name: id,
    enabled,
    condition: { type: "layer_name", operator: "equals", value: id },
    actions: {},
  });

  it("setzt enabled genau auf die gespeicherte Aktiv-Menge", () => {
    const rules = [mk("r1", false), mk("r2", true), mk("r3", false)];
    const next = applyOverrideRuleEnabled(rules, ["r1", "r3"]);
    expect(next.map((r) => [r.id, r.enabled])).toEqual([
      ["r1", true],
      ["r2", false],
      ["r3", true],
    ]);
  });

  it("ignoriert unbekannte (inzwischen gelöschte) Ids", () => {
    const rules = [mk("r1", false)];
    const next = applyOverrideRuleEnabled(rules, ["r1", "ghost"]);
    expect(next[0].enabled).toBe(true);
    expect(next).toHaveLength(1);
  });

  it("liefert dieselbe Referenz zurück, wenn nichts zu ändern ist (No-Op)", () => {
    const rules = [mk("r1", true), mk("r2", false)];
    expect(applyOverrideRuleEnabled(rules, ["r1"])).toBe(rules);
  });
});

describe("viewSnapshots — snapshotMatchesLiveState", () => {
  it("identischer Zustand → true", () => {
    expect(snapshotMatchesLiveState(sampleState(), sampleState())).toBe(true);
  });

  it("Override-Ids in anderer Reihenfolge → weiterhin true (Menge zählt)", () => {
    const live = { ...sampleState(), enabledOverrideRuleIds: ["r3", "r1"] };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(true);
  });

  // Jedes einzelne abweichende Feld muss zu false führen.
  it("viewType weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), viewType: "grundriss" }),
    ).toBe(false);
  });
  it("view3d weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), view3d: "perspective" }),
    ).toBe(false);
  });
  it("fov weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), fov: 43 }),
    ).toBe(false);
  });
  it("scaleDenominator weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), scaleDenominator: 100 }),
    ).toBe(false);
  });
  it("detail weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), detail: "grob" }),
    ).toBe(false);
  });
  it("activeLevelId weicht ab → false", () => {
    expect(
      snapshotMatchesLiveState(sampleState(), { ...sampleState(), activeLevelId: "floor-9" }),
    ).toBe(false);
  });
  it("layerVisibility-Wert weicht ab → false", () => {
    const live = { ...sampleState(), layerVisibility: { "20": true, "30": true } };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(false);
  });
  it("layerVisibility-Key fehlt/kommt hinzu → false", () => {
    const live = { ...sampleState(), layerVisibility: { "20": true } };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(false);
    const live2 = {
      ...sampleState(),
      layerVisibility: { "20": true, "30": false, "40": true },
    };
    expect(snapshotMatchesLiveState(sampleState(), live2)).toBe(false);
  });
  it("drawingVisibility weicht ab → false", () => {
    const live = {
      ...sampleState(),
      drawingVisibility: { "floor-1": true, "floor-2": true },
    };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(false);
  });
  it("enabledOverrideRuleIds weicht ab (eine Regel mehr) → false", () => {
    const live = { ...sampleState(), enabledOverrideRuleIds: ["r1", "r3", "r4"] };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(false);
  });
  it("enabledOverrideRuleIds weicht ab (andere Regel) → false", () => {
    const live = { ...sampleState(), enabledOverrideRuleIds: ["r1", "r2"] };
    expect(snapshotMatchesLiveState(sampleState(), live)).toBe(false);
  });
});

describe("viewSnapshots — boolMapEqual", () => {
  it("gleiche Keys/Werte → true, unabhängig von der Einfüge-Reihenfolge", () => {
    expect(boolMapEqual({ a: true, b: false }, { b: false, a: true })).toBe(true);
  });
  it("unterschiedliche Werte → false", () => {
    expect(boolMapEqual({ a: true }, { a: false })).toBe(false);
  });
  it("unterschiedliche Key-Menge → false", () => {
    expect(boolMapEqual({ a: true, b: true }, { a: true })).toBe(false);
  });
});

describe("viewSnapshots — matchingComboName (Grundlage der Ausschnitt-Tab-Auto-Benennung)", () => {
  const combos: Record<string, Record<string, boolean>> = {
    "Nur EG": { eg: true, og: false },
    "Alles": { eg: true, og: true },
  };
  const load = (name: string) => combos[name] ?? null;
  const names = () => Object.keys(combos);

  it("findet den Namen der exakt passenden Kombination", () => {
    expect(matchingComboName(names(), load, { eg: true, og: false })).toBe("Nur EG");
  });
  it("liefert null, wenn keine Kombination exakt passt", () => {
    expect(matchingComboName(names(), load, { eg: false, og: false })).toBeNull();
  });
  it("liefert null bei leerer Kombinationsliste", () => {
    expect(matchingComboName([], load, { eg: true })).toBeNull();
  });
});
