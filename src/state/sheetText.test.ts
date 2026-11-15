// [208] Freie Textspalte auf einem Layout-Blatt: die Textspalte entsteht auf der Blatt-Ebene (Papier 1:1, Schrift
// 3.5 mm, Breite aus dem Rahmen), Text und Ausrichtung (Blocksatz) sind Ops, jede Änderung ist ein Undo-Schritt,
// und die Blatt-Elemente tragen ihre Klasse (Kategorie), über die sie sich ausblenden lassen.
import { beforeEach, describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { createLayout, createSheetLevel } from "../model/layoutModel";
import { addItems, patchItem } from "../core/opsBuild";
import { textboxCommand } from "../commands/cmds/textbox";
import { SHEET_TEXT_HEIGHT_M, sheetTextHeightM } from "../commands/createCore";
import type { CommandContext } from "../commands/types";
import type { Drawing2D, RichTextDoc } from "../model/types";

const st = () => getState();

beforeEach(() => {
  st().loadProject(structuredClone(sampleProject));
  st().clearHistory();
});

const doc = (text: string, align?: "left" | "justify"): RichTextDoc => ({
  version: 1,
  paragraphs: [{ runs: [{ text, marks: { font: "Work Sans", sizePt: 14, bold: true } }], ...(align ? { align } : {}) }],
});

describe("Textspalte auf dem Blatt", () => {
  it("Vorgabe-Schrifthöhe wächst mit dem Blatt (A3 3.5 mm, A2 5, A1 7, A0 10; unbekanntes Blatt 3.5)", () => {
    const p = { layouts: [createLayout("a3", "A3", "a3", "landscape"), createLayout("a2", "A2", "a2", "portrait"), createLayout("a1", "A1", "a1", "landscape"), createLayout("a0", "A0", "a0", "landscape")], masterLayouts: [] };
    expect([...["a3", "a2", "a1", "a0", "?"]].map((id) => sheetTextHeightM(p, id))).toEqual([0.0035, 0.005, 0.007, 0.01, SHEET_TEXT_HEIGHT_M]);
  });

  it("Rahmen aufziehen → Textelement auf der Blatt-Ebene; Text und Blocksatz als Ops mit Undo", () => {
    const layout = createLayout("L1", "Plakat", "a3", "landscape");
    st().applyChange([...addItems("layouts", [layout]), ...addItems("drawingLevels", [createSheetLevel("sheet-L1", layout)])]);
    const sheet = st().project.drawingLevels.find((l) => l.layoutId === "L1")!;
    const ctx: CommandContext = {
      project: st().project,
      level: sheet,
      defaultCategoryCode: st().project.layers[0].code,
      activeLineStyleId: "solid",
      activeWallTypeId: st().project.wallTypes[0].id,
      lastPoint: null,
      selection: { wallIds: [], drawingId: null },
    };
    // Papier-mm (100, 200) → (400, 350): Rahmen 300 mm breit, 150 mm hoch (y nach unten = −y).
    const [s1] = textboxCommand.onInput(textboxCommand.init(), { kind: "point", point: { x: 0.1, y: -0.2 } }, ctx);
    const [, res] = textboxCommand.onInput(s1, { kind: "point", point: { x: 0.4, y: -0.35 } }, ctx);
    expect(res.focusDrawingId).toBeTruthy();
    expect(res.focusMinHeightM).toBeCloseTo(0.15, 9);
    const depth = st().undoDepth;
    st().setProject(res.commit as never);
    expect(st().undoDepth).toBe(depth + 1);
    const created = st().project.drawings2d.find((d) => d.id === res.focusDrawingId) as Drawing2D;
    expect(created.levelId).toBe(sheet.id);
    expect(created.geom.shape).toBe("text");
    if (created.geom.shape !== "text") return;
    const g = created.geom;
    expect(created.geom.width).toBeCloseTo(0.3, 9); // 300 mm Spaltenbreite
    expect(created.geom.height).toBeCloseTo(SHEET_TEXT_HEIGHT_M, 9);
    expect(created.categoryCode).toBeTruthy(); // gehört zu einer Klasse/Ebene und lässt sich darüber ausblenden

    // Text tippen (Rich-Text, Schrift/Grösse/Fett in den Marks) und Blocksatz.
    st().applyChange((p) => patchItem(p, "drawings2d", created.id, { geom: { ...g, text: "Der Hof", doc: doc("Der Hof öffnet sich nach Süden.", "justify") } }));
    const now = st().project.drawings2d.find((d) => d.id === created.id)!;
    expect(now.geom.shape === "text" && now.geom.doc?.paragraphs[0].align).toBe("justify");
    expect(now.geom.shape === "text" && now.geom.doc?.paragraphs[0].runs[0].marks.font).toBe("Work Sans");
    // Eine Änderung = ein Schritt: zuerst der Text weg, dann die Textspalte.
    st().undo();
    const back = st().project.drawings2d.find((d) => d.id === created.id)!;
    expect(back.geom.shape === "text" && back.geom.doc?.paragraphs[0]?.align).not.toBe("justify");
    st().undo();
    expect(st().project.drawings2d.some((d) => d.id === created.id)).toBe(false);
    st().redo();
    st().redo();
    const again = st().project.drawings2d.find((d) => d.id === created.id)!;
    expect(again.geom.shape === "text" && again.geom.doc?.paragraphs[0].align).toBe("justify");
  });
});
