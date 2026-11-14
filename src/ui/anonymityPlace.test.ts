// Fundstellen-Zerlegung des Anonymitäts-Dialogs: Pfade des Kerns -> Elementart, Name, Feld (de/en).
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { anonymityPlaceParts } from "./anonymityPlace";

afterEach(() => setLanguage("de"));

describe("anonymityPlaceParts", () => {
  it("typische Pfade auf Deutsch", () => {
    setLanguage("de");
    expect(anonymityPlaceParts("materials", "Wärmedämmung.name")).toEqual({ kind: "Material", item: "Wärmedämmung", field: "Name" });
    expect(anonymityPlaceParts("rooms", "Küche.note")).toEqual({ kind: "Raum", item: "Küche", field: "Notiz" });
    expect(anonymityPlaceParts("drawingLevels", "EG.name")).toEqual({ kind: "Geschoss", item: "EG", field: "Name" });
    expect(anonymityPlaceParts("layers", "Wände.layers.Anna.name")).toEqual({ kind: "Ebene / Klasse", item: "Wände › Anna", field: "Name" });
    expect(anonymityPlaceParts("drawings2d", "0.text")).toEqual({ kind: "Zeichnung", item: "0", field: "Text" });
    expect(anonymityPlaceParts("layouts", "Plan.titleBlock.sheetName")).toEqual({ kind: "Blatt", item: "Plan", field: "Titelblock · Blattname" });
    expect(anonymityPlaceParts("layouts", "Plan.images.logo.png.name")).toEqual({ kind: "Blatt", item: "Plan › logo.png", field: "Name" });
  });
  it("Englisch, unbekanntes Feld und Zusatztext", () => {
    setLanguage("en");
    expect(anonymityPlaceParts("materials", "Insulation.name")).toEqual({ kind: "Material", item: "Insulation", field: "Name" });
    expect(anonymityPlaceParts("rooms", "Kitchen.weird")).toEqual({ kind: "Room", item: "Kitchen", field: "weird" });
    expect(anonymityPlaceParts("export", "Dateiname")).toEqual({ kind: "Output", item: "", field: "Dateiname" });
  });
});
