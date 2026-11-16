// [263] Dock-Gruppen einklappen: Zustand liegt im Layout und überlebt Speichern/Laden.
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileLayout } from "../state/layoutSlice";
import "./builtinPanels";
import { defaultLayout, loadLayout, saveLayout, setActiveTab, toggleGroupCollapsed } from "./layout";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe("[263] Gruppen einklappen", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  });

  it("standardmässig ist nichts eingeklappt", () => {
    for (const g of defaultLayout().right.groups) expect(g.collapsed ?? false).toBe(false);
  });

  it("toggleGroupCollapsed klappt nur die gewählte Gruppe ein und wieder aus", () => {
    const l0 = defaultLayout();
    const l1 = toggleGroupCollapsed(l0, "right", 1);
    expect(l1.right.groups[1].collapsed).toBe(true);
    expect(l1.right.groups[0].collapsed ?? false).toBe(false);
    expect(l0.right.groups[1].collapsed ?? false).toBe(false); // immutabel
    const l2 = toggleGroupCollapsed(l1, "right", 1);
    expect(l2.right.groups[1].collapsed ?? false).toBe(false);
  });

  it("ungültiger Index lässt das Layout unverändert", () => {
    const l = defaultLayout();
    expect(toggleGroupCollapsed(l, "right", 9)).toBe(l);
  });

  it("ein Klick auf einen Tab einer eingeklappten Gruppe klappt sie auf", () => {
    let l = toggleGroupCollapsed(defaultLayout(), "right", 1);
    l = setActiveTab(l, "right", "layers");
    expect(l.right.groups[1].activeTab).toBe("layers");
    expect(l.right.groups[1].collapsed ?? false).toBe(false);
    // auch beim bereits aktiven Tab
    l = toggleGroupCollapsed(l, "right", 1);
    l = setActiveTab(l, "right", "layers");
    expect(l.right.groups[1].collapsed ?? false).toBe(false);
  });

  it("bleibt nach Speichern und Laden erhalten", () => {
    const l = toggleGroupCollapsed(defaultLayout(), "right", 0);
    expect(saveLayout(l)).toBe(true);
    const back = loadLayout();
    expect(back.right.groups[0].collapsed).toBe(true);
    expect(back.right.groups[1].collapsed ?? false).toBe(false);
  });

  it("reconcileLayout (Start der App) behält den eingeklappten Zustand", () => {
    const l = toggleGroupCollapsed(defaultLayout(), "right", 1);
    const r = reconcileLayout(loadLayoutRoundTrip(l));
    expect(r.right.groups[1].collapsed).toBe(true);
    expect(r.right.groups[0].collapsed ?? false).toBe(false);
  });
});

function loadLayoutRoundTrip(l: ReturnType<typeof defaultLayout>) {
  saveLayout(l);
  return loadLayout();
}
