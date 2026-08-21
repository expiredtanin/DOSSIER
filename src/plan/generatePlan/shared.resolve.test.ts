/**
 * `resolveForeground`/`resolveBackground`/`resolveHatchId`/`resolveStrokeWeight`
 * — By-Layer/By-Object-Auflösung. Nutzer-Report: ein neu erzeugtes Element
 * (Source-Feld nie gesetzt) zeigte im Attribut-Panel „Nach Bauteil" als
 * Default, obwohl „Nach Ebene" der gewünschte Standard ist. Fix: `source`
 * fehlend/`"layer"` liefert jetzt die Kategorie, NUR ein explizites
 * `"object"` fällt auf das Bauteil zurück (vorher umgekehrt).
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

describe("resolveForeground/resolveBackground — Default fehlender Source ist jetzt 'Nach Ebene'", () => {
  it("kein Override, Source fehlt: liefert die Kategorie-Farbe (nicht mehr die Bauteilfarbe)", () => {
    expect(resolveForeground(comp, undefined, category, undefined)).toBe(category.color);
    expect(resolveBackground(comp, undefined, category, undefined)).toBe(category.color);
  });

  it("kein Override, Source explizit 'layer': unverändert die Kategorie-Farbe", () => {
    expect(resolveForeground(comp, undefined, category, "layer")).toBe(category.color);
    expect(resolveBackground(comp, undefined, category, "layer")).toBe(category.color);
  });

  it("kein Override, Source explizit 'object': fällt weiterhin auf die Bauteilfarbe zurück", () => {
    expect(resolveForeground(comp, undefined, category, "object")).toBe(comp.foreground);
    expect(resolveBackground(comp, undefined, category, "object")).toBe(comp.background);
  });

  it("ein gesetzter Override gewinnt immer, unabhängig von der Source", () => {
    expect(resolveForeground(comp, "#ff00ff", category, "object")).toBe("#ff00ff");
    expect(resolveForeground(comp, "#ff00ff", category, undefined)).toBe("#ff00ff");
  });

  it("ohne Kategorie fällt 'Nach Ebene' auf die Bauteilfarbe zurück (kein Crash)", () => {
    expect(resolveForeground(comp, undefined, undefined, undefined)).toBe(comp.foreground);
  });
});

describe("resolveHatchId — Default fehlender Source ist jetzt 'Nach Ebene'", () => {
  it("kein Override, Source fehlt: liefert die Kategorie-Schraffur", () => {
    expect(resolveHatchId(undefined, undefined, category, comp.hatchId)).toBe(category.hatch);
  });
  it("kein Override, Source explizit 'object': liefert den Fallback (Bauteil-Schraffur)", () => {
    expect(resolveHatchId(undefined, "object", category, comp.hatchId)).toBe(comp.hatchId);
  });
});

describe("resolveStrokeWeight — Default fehlender Source ist jetzt 'Nach Ebene'", () => {
  it("kein Override, Source fehlt: liefert die Kategorie-Strichstärke", () => {
    expect(resolveStrokeWeight(undefined, undefined, category, 0.13)).toBe(category.lw);
  });
  it("kein Override, Source explizit 'object': liefert den Fallback", () => {
    expect(resolveStrokeWeight(undefined, "object", category, 0.13)).toBe(0.13);
  });
});
