// [99] Fokus-Regeln des Esc/Enter-Verteilers.
import { describe, expect, it } from "vitest";
import { commandKeyAction } from "./commandKeys";

const el = (tagName: string, inDialog = false, editable = false) =>
  ({ tagName, isContentEditable: editable, closest: () => (inDialog ? {} : null) }) as unknown as EventTarget;
const ev = (key: string, target: EventTarget | null, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  target,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  ...extra,
});

describe("commandKeyAction", () => {
  it("Körper, Zeichenfläche, Knopf: Esc = escape, Enter = confirm", () => {
    for (const t of [null, el("BODY"), el("CANVAS"), el("BUTTON"), el("DIV")]) {
      expect(commandKeyAction(ev("Escape", t), true)).toBe("escape");
      expect(commandKeyAction(ev("Enter", t), true)).toBe("confirm");
    }
  });
  it("ohne laufenden Befehl, in Feldern, Dialogen, mit Modifikator oder schon behandelt: nicht zuständig", () => {
    expect(commandKeyAction(ev("Escape", el("BODY")), false)).toBe(null);
    expect(commandKeyAction(ev("Escape", el("INPUT")), true)).toBe(null);
    expect(commandKeyAction(ev("Enter", el("TEXTAREA")), true)).toBe(null);
    expect(commandKeyAction(ev("Enter", el("DIV", false, true)), true)).toBe(null);
    expect(commandKeyAction(ev("Escape", el("BUTTON", true)), true)).toBe(null);
    expect(commandKeyAction(ev("Enter", el("BODY"), { metaKey: true }), true)).toBe(null);
    expect(commandKeyAction(ev("Escape", el("BODY"), { defaultPrevented: true }), true)).toBe(null);
    expect(commandKeyAction(ev("a", el("BODY")), true)).toBe(null);
  });
  it("gehaltene Taste wird geschluckt (kein Esc-Esc-Abbruch durch Wiederholung)", () => {
    expect(commandKeyAction(ev("Escape", el("BODY"), { repeat: true }), true)).toBe("swallow");
  });
});
