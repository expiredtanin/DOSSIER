// [249] Reine Logik der Dialog-Fokushülle: Tab-Falle, Enter-Felder, Hintergrund-Kürzel-Sperre, Walk-Sperre im Dialog.
// Ohne DOM (Umgebung node): Elemente sind Attrappen mit `closest`/`tagName`.
import { describe, expect, it } from "vitest";
import { enterConfirmsDialog, enterTriggersPrimary, trapTarget } from "./modalFocus";
import { isInModalDialog } from "../state/modalScope";
import { walkKeyAllowed } from "../viewport/walk";

const el = (tag: string, inModal: boolean, extra: Record<string, unknown> = {}) =>
  ({
    tagName: tag,
    isContentEditable: false,
    closest: (sel: string) => (inModal && sel === '[aria-modal="true"]' ? {} : null),
    ...extra,
  }) as unknown as Element;

describe("trapTarget (Tab-Falle)", () => {
  it("springt vom letzten zum ersten und mit Umschalt vom ersten zum letzten", () => {
    expect(trapTarget(4, 3, false)).toBe(0);
    expect(trapTarget(4, 0, true)).toBe(3);
  });
  it("lässt den Browser innerhalb der Liste springen", () => {
    expect(trapTarget(4, 1, false)).toBeNull();
    expect(trapTarget(4, 2, true)).toBeNull();
  });
  it("Fokus ausserhalb (Dokument): Tab → erstes, Umschalt+Tab → letztes", () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });
  it("ein einziges Element hält den Fokus fest, keine Elemente: Fokus bleibt am Dialog", () => {
    expect(trapTarget(1, 0, false)).toBe(0);
    expect(trapTarget(1, 0, true)).toBe(0);
    expect(trapTarget(0, -1, false)).toBe(-1);
  });
});

describe("enterTriggersPrimary", () => {
  it("nur Texteingaben lösen die Hauptaktion aus, nicht Knöpfe, Auswahlfelder, Haken", () => {
    expect(enterTriggersPrimary(el("INPUT", true, { type: "number" }))).toBe(true);
    expect(enterTriggersPrimary(el("INPUT", true, { type: "search" }))).toBe(true);
    expect(enterTriggersPrimary(el("INPUT", true, { type: "checkbox" }))).toBe(false);
    expect(enterTriggersPrimary(el("BUTTON", true))).toBe(false);
    expect(enterTriggersPrimary(el("SELECT", true))).toBe(false);
    expect(enterTriggersPrimary(null)).toBe(false);
  });
});

describe("Hintergrund-Kürzel im modalen Dialog", () => {
  it("isInModalDialog erkennt Ziele im Dialog", () => {
    expect(isInModalDialog(el("BUTTON", true))).toBe(true);
    expect(isInModalDialog(el("BUTTON", false))).toBe(false);
    expect(isInModalDialog(null)).toBe(false);
  });
  it("Begehen-Tasten gehören dem Dialog, solange der Fokus darin liegt", () => {
    const k = { ctrlKey: false, metaKey: false };
    expect(walkKeyAllowed(k, el("BUTTON", true))).toBe(false);
    expect(walkKeyAllowed(k, el("BUTTON", false))).toBe(true);
  });
});

describe("enterConfirmsDialog ([251])", () => {
  const inside = (tag: string, withinButton = false) =>
    ({ tagName: tag, closest: (sel: string) => (withinButton && sel.includes("button") ? {} : null) }) as unknown as Element;
  it("Eingabe-, Auswahlfeld und Dokument bestätigen", () => {
    expect(enterConfirmsDialog(inside("INPUT"))).toBe(true);
    expect(enterConfirmsDialog(inside("SELECT"))).toBe(true);
    expect(enterConfirmsDialog(null)).toBe(true);
  });
  it("Knöpfe (auch Kinder darin) behalten ihre eigene Aktion", () => {
    expect(enterConfirmsDialog(inside("BUTTON", true))).toBe(false);
    expect(enterConfirmsDialog(inside("SPAN", true))).toBe(false);
  });
});
