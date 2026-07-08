// Unit-Tests der Override-Regel-Engine (reine Auswertung, src/overrides/engine.ts):
// Operatoren, Reihenfolge (oberste Regel gewinnt pro Feld), additive
// Teilaktionen, deaktivierte Regeln, layer_name gegen Name UND Code.

import { describe, it, expect } from "vitest";
import type { OverrideRule } from "../model/types";
import {
  EMPTY_OVERRIDES,
  effectiveOverrides,
  hasOverrides,
  matchesCondition,
} from "./engine";

/** Kurzform: Regel mit Defaults. */
function rule(partial: Partial<OverrideRule> & Pick<OverrideRule, "condition" | "actions">): OverrideRule {
  return {
    id: partial.id ?? "r",
    name: partial.name ?? "Regel",
    enabled: partial.enabled ?? true,
    condition: partial.condition,
    actions: partial.actions,
  };
}

const WALL_SUBJECT = { layerName: "Wände", layerCode: "20", objectName: "AW 24" };

describe("overrides/engine — matchesCondition", () => {
  it("equals: case-insensitiv, trimmt den Regelwert", () => {
    expect(
      matchesCondition(
        { type: "layer_name", operator: "equals", value: "  wände " },
        WALL_SUBJECT,
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        { type: "layer_name", operator: "equals", value: "Decken" },
        WALL_SUBJECT,
      ),
    ).toBe(false);
  });

  it("layer_name matcht Namen ODER Code der Ebene", () => {
    expect(
      matchesCondition(
        { type: "layer_name", operator: "equals", value: "20" },
        WALL_SUBJECT,
      ),
    ).toBe(true);
  });

  it("contains und starts_with auf dem Objektnamen", () => {
    expect(
      matchesCondition(
        { type: "object_name", operator: "contains", value: "24" },
        WALL_SUBJECT,
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        { type: "object_name", operator: "starts_with", value: "aw" },
        WALL_SUBJECT,
      ),
    ).toBe(true);
    expect(
      matchesCondition(
        { type: "object_name", operator: "starts_with", value: "24" },
        WALL_SUBJECT,
      ),
    ).toBe(false);
  });

  it("not_equals trifft nur, wenn WEDER Name noch Code gleich sind", () => {
    expect(
      matchesCondition(
        { type: "layer_name", operator: "not_equals", value: "20" },
        WALL_SUBJECT,
      ),
    ).toBe(false);
    expect(
      matchesCondition(
        { type: "layer_name", operator: "not_equals", value: "Wände" },
        WALL_SUBJECT,
      ),
    ).toBe(false);
    expect(
      matchesCondition(
        { type: "layer_name", operator: "not_equals", value: "Decken" },
        WALL_SUBJECT,
      ),
    ).toBe(true);
  });

  it("fehlende Subjekt-Eigenschaft: positive Operatoren treffen nicht, not_equals schon", () => {
    expect(
      matchesCondition(
        { type: "object_name", operator: "contains", value: "x" },
        { layerName: "Wände", layerCode: "20" },
      ),
    ).toBe(false);
    expect(
      matchesCondition(
        { type: "object_name", operator: "not_equals", value: "x" },
        { layerName: "Wände", layerCode: "20" },
      ),
    ).toBe(true);
  });
});

describe("overrides/engine — effectiveOverrides", () => {
  it("ohne Regeln (oder undefined) kommt EMPTY_OVERRIDES zurück", () => {
    expect(effectiveOverrides(undefined, WALL_SUBJECT)).toBe(EMPTY_OVERRIDES);
    expect(effectiveOverrides([], WALL_SUBJECT)).toBe(EMPTY_OVERRIDES);
    expect(hasOverrides(EMPTY_OVERRIDES)).toBe(false);
  });

  it("oberste Regel gewinnt pro Aktions-Feld", () => {
    const rules = [
      rule({
        id: "top",
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { color: "#ff0000" },
      }),
      rule({
        id: "below",
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { color: "#00ff00" },
      }),
    ];
    expect(effectiveOverrides(rules, WALL_SUBJECT).color).toBe("#ff0000");
  });

  it("additive Teilaktionen: untere Regeln füllen offene Felder", () => {
    const rules = [
      rule({
        id: "color-only",
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { color: "#ff0000" },
      }),
      rule({
        id: "weight-only",
        condition: { type: "object_name", operator: "starts_with", value: "AW" },
        actions: { lineweight: 0.7, color: "#0000ff" },
      }),
    ];
    const eff = effectiveOverrides(rules, WALL_SUBJECT);
    // Farbe aus der obersten Regel, Strichstärke additiv aus der zweiten.
    expect(eff).toEqual({ color: "#ff0000", lineweight: 0.7 });
  });

  it("deaktivierte Regeln werden übersprungen", () => {
    const rules = [
      rule({
        id: "off",
        enabled: false,
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { color: "#ff0000" },
      }),
      rule({
        id: "on",
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { color: "#00ff00" },
      }),
    ];
    expect(effectiveOverrides(rules, WALL_SUBJECT).color).toBe("#00ff00");
  });

  it("nicht matchende Regeln tragen nichts bei", () => {
    const rules = [
      rule({
        id: "other-layer",
        condition: { type: "layer_name", operator: "equals", value: "30" },
        actions: { color: "#ff0000" },
      }),
    ];
    expect(effectiveOverrides(rules, WALL_SUBJECT)).toBe(EMPTY_OVERRIDES);
  });

  it("linetypeId wird wie die anderen Felder aufgelöst", () => {
    const rules = [
      rule({
        id: "lt",
        condition: { type: "layer_name", operator: "contains", value: "wän" },
        actions: { linetypeId: "dashed" },
      }),
    ];
    expect(effectiveOverrides(rules, WALL_SUBJECT).linetypeId).toBe("dashed");
  });
});
