// [121] Stabiler Panel-Host: Handler als feste Trampoline, neue Identität nur bei geänderten Wert-Feldern.
import { describe, expect, it } from "vitest";
import { stabilizeHost, type StableHost } from "./stableHost";
import { dataEqual } from "../dataEqual";

type Host = { activeLevelId: string; onPick: (id: string) => string; snap: { grid: boolean } };

describe("stabilizeHost", () => {
  it("neuer Bau mit gleichen Wert-Feldern behält die Identität, Handler rufen die neueste Fassung", () => {
    const snap = { grid: true };
    const latest = { current: { activeLevelId: "eg", onPick: (id: string) => `alt:${id}`, snap } as Host };
    const s1 = stabilizeHost<Host>(null, latest.current, latest);
    // Neubau (z. B. nach einer Op): neue Handler-Closures, gleiche Werte.
    latest.current = { activeLevelId: "eg", onPick: (id: string) => `neu:${id}`, snap };
    const s2 = stabilizeHost<Host>(s1, latest.current, latest);
    expect(s2).toBe(s1);
    expect(s2.out.onPick("w1")).toBe("neu:w1");
  });

  it("geändertes Wert-Feld: neue Ausgabe, Trampoline bleiben dieselben", () => {
    const latest = { current: { activeLevelId: "eg", onPick: (id: string) => id, snap: { grid: true } } as Host };
    const s1 = stabilizeHost<Host>(null, latest.current, latest);
    latest.current = { ...latest.current, activeLevelId: "og" };
    const s2: StableHost<Host> = stabilizeHost<Host>(s1, latest.current, latest);
    expect(s2).not.toBe(s1);
    expect(s2.out.activeLevelId).toBe("og");
    expect(s2.out.onPick).toBe(s1.out.onPick);
  });

  it("Feld wechselt zwischen Wert und Handler: neue Ausgabe", () => {
    type H = { f?: (() => void) | null };
    const latest = { current: { f: null } as H };
    const s1 = stabilizeHost<H>(null, latest.current, latest);
    latest.current = { f: () => {} };
    const s2 = stabilizeHost<H>(s1, latest.current, latest);
    expect(s2).not.toBe(s1);
    expect(typeof s2.out.f).toBe("function");
  });
});

describe("dataEqual", () => {
  it("vergleicht Daten strukturell", () => {
    expect(dataEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(dataEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(dataEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(dataEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(dataEqual(null, {})).toBe(false);
    expect(dataEqual(Number.NaN, Number.NaN)).toBe(true);
  });
});
