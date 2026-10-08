/**
 * `elementClipboardSerialize` — OS-Zwischenablage-Text-Serialisierung für
 * `ElementClipboard` (`serializeClipboardText`/`parseClipboardText`). Deckt
 * den Roundtrip sowie die defensive Ablehnung fremder/kaputter Texte ab
 * (Grundvoraussetzung dafür, dass ein `navigator.clipboard.readText()`-
 * Ergebnis mit BELIEBIGEM Inhalt niemals `pasteElementClipboard` zum
 * Absturz bringt).
 */
import { describe, it, expect } from "vitest";
import { serializeClipboardText, parseClipboardText } from "./elementClipboardSerialize";
import { EMPTY_CLIPBOARD } from "./elementClipboard";
import type { ElementClipboard } from "./elementClipboard";
import type { Wall } from "../model/types";

function wall(id: string): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    wallTypeId: "wt1",
    height: 2.6,
  };
}

function sampleClip(): ElementClipboard {
  return { ...EMPTY_CLIPBOARD, walls: [wall("w1")] };
}

describe("elementClipboardSerialize — Roundtrip", () => {
  it("serialize → parse ergibt eine äquivalente ElementClipboard", () => {
    const clip = sampleClip();
    expect(parseClipboardText(serializeClipboardText(clip))).toEqual(clip);
  });

  it("Roundtrip funktioniert auch für eine leere Zwischenablage", () => {
    expect(parseClipboardText(serializeClipboardText(EMPTY_CLIPBOARD))).toEqual(EMPTY_CLIPBOARD);
  });
});

describe("elementClipboardSerialize — parseClipboardText lehnt Fremdtext defensiv ab", () => {
  it("liefert null für kein JSON", () => {
    expect(parseClipboardText("Hallo, das ist normaler Text")).toBeNull();
  });

  it("liefert null für gültiges JSON ohne unsere Marke", () => {
    expect(parseClipboardText(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("liefert null für JSON mit falscher Marke", () => {
    expect(
      parseClipboardText(JSON.stringify({ __dossier: "irgendwas-anderes", clip: EMPTY_CLIPBOARD })),
    ).toBeNull();
  });

  it("liefert null, wenn 'clip' fehlt", () => {
    expect(parseClipboardText(JSON.stringify({ __dossier: "dossier-element-clipboard-v1" }))).toBeNull();
  });

  it("liefert null, wenn ein Bauteil-Feld kein Array ist (verformte Daten)", () => {
    const broken = { __dossier: "dossier-element-clipboard-v1", clip: { ...EMPTY_CLIPBOARD, walls: "kaputt" } };
    expect(parseClipboardText(JSON.stringify(broken))).toBeNull();
  });

  it("liefert null für leeren String / primitive Werte", () => {
    expect(parseClipboardText("")).toBeNull();
    expect(parseClipboardText("42")).toBeNull();
    expect(parseClipboardText("null")).toBeNull();
    expect(parseClipboardText('"nur ein String"')).toBeNull();
  });
});
