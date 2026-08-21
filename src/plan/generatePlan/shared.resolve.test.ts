/**
 * `resolveForeground`/`resolveBackground`/`resolveHatchId`/`resolveStrokeWeight`
 * — By-Layer/By-Object-Auflösung. Der Resolver selbst bleibt „Nach Bauteil"
 * (Component) als Default, wenn `source` fehlt/`"object"` ist — das liefert
 * bei Wand/Decke die neutrale SIA-Poché-Konvention (weisser Grund, schwarzer
 * Vordergrund), NICHT die rohe Ebenenfarbe (Nutzer-Bestätigung: „eine Wand
 * usw soll weiterhin nach Bauteil haben"). Ein Drawing2D hat kein eigenes
 * Bauteil und bietet „Nach Bauteil" im Attribut-Panel gar nicht an — DORT
 * mappt der Aufrufer (`selectionInfo.ts`) ein fehlendes Source-Feld explizit
 * auf `"layer"`, bevor er diese Resolver aufruft (separat unten geprüft).
 */

import { describe, it, expect } from "vitest";
import {
  resolveForeground,
  resolveBackground,
  resolveHatchId,
  resolveStrokeWeight,
} from "./shared";
import type { Component, LayerCategory } from "../../model/types";

const comp: Component = {
  id: "c1",
  name: "Beton",
  color: "#888888",
  foreground: "#111111",
  background: "#222222",
  hatchId: "sia-concrete",
  joinPriority: 10,
};

const category: LayerCategory = {
  code: "20",
  name: "Wände",
  color: "#0a0a0a",
  lw: 0.5,
  visible: true,
  locked: false,
  hatch: "sia-wall",
};

describe("resolveForeground/resolveBackground — Default bleibt 'Nach Bauteil'", () => {
  it("kein Override, Source fehlt: liefert weiterhin die Bauteilfarbe (Default unverändert)", () => {
    expect(resolveForeground(comp, undefined, category, undefined)).toBe(comp.foreground);
    expect(resolveBackground(comp, undefined, category, undefined)).toBe(comp.background);
  });

  it("kein Override, Source explizit 'object': unverändert die Bauteilfarbe", () => {
    expect(resolveForeground(comp, undefined, category, "object")).toBe(comp.foreground);
    expect(resolveBackground(comp, undefined, category, "object")).toBe(comp.background);
  });

  it("kein Override, Source explizit 'layer': liefert die Kategorie-Farbe", () => {
    expect(resolveForeground(comp, undefined, category, "layer")).toBe(category.color);
    expect(resolveBackground(comp, undefined, category, "layer")).toBe(category.color);
  });

  it("ein gesetzter Override gewinnt immer, unabhängig von der Source", () => {
    expect(resolveForeground(comp, "#ff00ff", category, "layer")).toBe("#ff00ff");
    expect(resolveForeground(comp, "#ff00ff", category, undefined)).toBe("#ff00ff");
  });
});

describe("resolveHatchId — Default bleibt 'Nach Bauteil'", () => {
  it("kein Override, Source fehlt: liefert den Fallback (Bauteil-Schraffur)", () => {
    expect(resolveHatchId(undefined, undefined, category, comp.hatchId)).toBe(comp.hatchId);
  });
  it("kein Override, Source explizit 'layer': liefert die Kategorie-Schraffur", () => {
    expect(resolveHatchId(undefined, "layer", category, comp.hatchId)).toBe(category.hatch);
  });
});

describe("resolveStrokeWeight — Default bleibt 'Nach Bauteil'", () => {
  it("kein Override, Source fehlt: liefert den Fallback", () => {
    expect(resolveStrokeWeight(undefined, undefined, category, 0.13)).toBe(0.13);
  });
  it("kein Override, Source explizit 'layer': liefert die Kategorie-Strichstärke", () => {
    expect(resolveStrokeWeight(undefined, "layer", category, 0.13)).toBe(category.lw);
  });
});

describe("Drawing2D-Panel-Vorschau (selectionInfo.ts) — mappt fehlende Source explizit auf 'layer'", () => {
  it("simuliert das Aufrufer-Mapping `d.foregroundSource ?? \"layer\"`: liefert die Kategorie-Farbe für ein Drawing2D ohne Bauteil", () => {
    const noComponent: Component = { id: "", name: "", color: "#000", hatchId: "", joinPriority: 0 };
    const drawingSource: "layer" | undefined = undefined; // wie ein frisches Drawing2D
    expect(resolveForeground(noComponent, undefined, category, drawingSource ?? "layer")).toBe(
      category.color,
    );
  });
});
