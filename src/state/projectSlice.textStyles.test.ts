/**
 * Textstil-Bibliothek — Store-Aktionen (`patchTextStyle`/`addTextStyle`/
 * `deleteTextStyle`). Die reine Anwendungslogik (`applyPreset`) ist bereits in
 * `text/richText.test.ts` getestet; hier geht es um die CRUD-Verdrahtung im
 * Projekt-Store, analog `projectSlice.penSets.test.ts`. `Project.textStyles`
 * ist optional (additiv, Fallback `DEFAULT_PRESETS`) — die Aktionen müssen
 * daher auch OHNE vorher gesetztes Feld funktionieren (starten dann vom
 * Fallback statt von einem leeren Array).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { DEFAULT_PRESETS } from "../text/richText";

beforeEach(() => {
  setState({
    project: { ...sampleProject, textStyles: undefined },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("addTextStyle — startet vom Fallback, wenn `textStyles` noch fehlt", () => {
  it("legt einen neuen Stil an, seed mit den 4 Default-Presets davor", () => {
    getState().addTextStyle();
    const styles = getState().project.textStyles!;
    expect(styles.length).toBe(DEFAULT_PRESETS.length + 1);
    expect(styles.slice(0, DEFAULT_PRESETS.length)).toEqual(DEFAULT_PRESETS);
    expect(styles[styles.length - 1].marks.sizePt).toBe(10);
  });
});

describe("patchTextStyle — merged Marks statt zu ersetzen", () => {
  it("ändert nur das gepatchte Marks-Feld, lässt die übrigen unverändert", () => {
    getState().addTextStyle();
    const id = getState().project.textStyles![DEFAULT_PRESETS.length].id;
    getState().patchTextStyle(id, { marks: { bold: true } });
    getState().patchTextStyle(id, { marks: { italic: true } });
    const style = getState().project.textStyles!.find((s) => s.id === id)!;
    expect(style.marks.bold).toBe(true);
    expect(style.marks.italic).toBe(true);
    expect(style.marks.sizePt).toBe(10); // unverändert vom Anlegen
  });

  it("ändert den Namen (label) unabhängig von marks", () => {
    getState().addTextStyle();
    const id = getState().project.textStyles![DEFAULT_PRESETS.length].id;
    getState().patchTextStyle(id, { label: "Firmenstil" });
    expect(getState().project.textStyles!.find((s) => s.id === id)?.label).toBe("Firmenstil");
  });
});

describe("deleteTextStyle — entfernt genau den einen Stil", () => {
  it("löscht einen selbst angelegten Stil, lässt die Default-Presets unberührt", () => {
    getState().addTextStyle();
    const id = getState().project.textStyles![DEFAULT_PRESETS.length].id;
    getState().deleteTextStyle(id);
    const styles = getState().project.textStyles!;
    expect(styles.length).toBe(DEFAULT_PRESETS.length);
    expect(styles.find((s) => s.id === id)).toBeUndefined();
  });

  it("kann auch einen der geseedeten Default-Presets löschen (kein Lösch-Schutz — v1 nicht live-verknüpft)", () => {
    getState().addTextStyle(); // seedet textStyles zuerst mit DEFAULT_PRESETS
    const titleId = getState().project.textStyles!.find((s) => s.id === "title")!.id;
    getState().deleteTextStyle(titleId);
    expect(getState().project.textStyles!.find((s) => s.id === "title")).toBeUndefined();
  });
});
