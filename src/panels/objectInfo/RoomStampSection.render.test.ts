// [218] Raumstempel als Abschnitt der Objekteinstellungen (kein Dialog im Fenster): Abschnitt vorhanden, Schrift je Zeile,
// „gemischt" bei Mehrfachauswahl, eine Änderung für alle Räume in einem Undo-Schritt; Bezugspunkt und Masse nur im
// Objekt-Info-Panel, nicht im Fenster. Ohne DOM: Server-Render der Panels.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { setStampFontAttr } from "../../model/roomStamp";
import { editRoomStamps } from "../../state/roomStampEdit";
import { getState, setState } from "../../state/appStore";
import { EMPTY_SELECTION } from "../../state/selection";
import { PanelHostProvider } from "../host";
import type { PanelHost } from "../types";
import { ObjectInfoPanel } from "../ObjectInfoPanel";
import { ObjectSettingsPanel } from "../objectSettings/ObjectSettingsPanel";

const host = { activeTool: "select", sectionLine: null, displayMode: { mode: "all", setMode: () => {} } } as unknown as PanelHost;
const wrap = (el: ReturnType<typeof createElement>) => renderToString(createElement(PanelHostProvider, { value: host }, el));
const windowHtml = () => wrap(createElement(ObjectSettingsPanel));
const panelHtml = () => wrap(createElement(ObjectInfoPanel));

function twoRooms() {
  getState().loadProject(buildComplexSampleProject());
  const rooms = getState().project.rooms!;
  return [rooms[0].id, rooms[1].id] as const;
}

describe("Raumstempel in den Objekteinstellungen [218]", () => {
  it("Raum gewählt: Abschnitt „Raumstempel“ mit Schrift je Zeile, kein Overlay-Dialog", () => {
    const [a] = twoRooms();
    setState({ selection: { ...EMPTY_SELECTION, rooms: [a] } });
    const html = windowHtml();
    expect(html).toContain('data-group="roomStamp"');
    expect(html).toContain('data-testid="roomstamp-section"');
    for (const k of ["font", "nameFont", "line2Font", "numberFont", "areaFont", "usageFont"]) expect(html).toContain(`data-testid="roomstamp-font-${k}"`);
    expect(html).not.toContain("texteditor-overlay");
    expect(html).not.toContain('role="dialog"');
  });

  it("Bezugspunkt und Masse nur im Objekt-Info-Panel, nicht im Fenster (Raum und Wand)", () => {
    const p = buildComplexSampleProject();
    getState().loadProject(p);
    for (const sel of [{ rooms: [p.rooms![0].id] }, { walls: [p.walls[0].id] }]) {
      setState({ selection: { ...EMPTY_SELECTION, ...sel } });
      const panel = panelHtml();
      expect(panel).toContain("objinfo-cube");
      expect(panel).toContain("objinfo-refrow");
      const win = windowHtml();
      expect(win).not.toContain("objinfo-cube");
      expect(win).not.toContain("objinfo-refrow");
      expect(win).not.toContain("objinfo-xyzcol");
      expect(win).not.toContain('data-testid="objinfo-dim"');
    }
  });

  it("zwei Räume mit abweichender Namensschrift: „gemischt“, bei gleicher nicht", () => {
    const [a, b] = twoRooms();
    editRoomStamps([a], (st) => ({ ...st, nameFont: { sizePt: 20 } }), "k1");
    editRoomStamps([b], (st) => ({ ...st, nameFont: { sizePt: 14 } }), "k2");
    setState({ selection: { ...EMPTY_SELECTION, rooms: [a, b] } });
    expect(windowHtml()).toContain('data-mixed="font-nameFont"');
    // Nummer und Namen bleiben je Raum eigen: gesperrt.
    expect(windowHtml()).toMatch(/data-testid="roomstamp-number"[^>]*disabled/);
    setState({ selection: { ...EMPTY_SELECTION, rooms: [a] } });
    expect(windowHtml()).not.toContain('data-mixed="font-nameFont"');
  });

  it("Schrift für alle gewählten Räume in EINEM Undo-Schritt", () => {
    const [a, b] = twoRooms();
    setState({ selection: { ...EMPTY_SELECTION, rooms: [a, b] } });
    const before = JSON.stringify(getState().project.rooms!.map((r) => r.stamp ?? null));
    editRoomStamps([a, b], (s) => setStampFontAttr(setStampFontAttr(s, "nameFont", "family", "Jost"), "nameFont", "sizePt", 18), "stamp:test");
    const sizes = () => getState().project.rooms!.filter((r) => r.id === a || r.id === b).map((r) => [r.stamp?.nameFont?.family, r.stamp?.nameFont?.sizePt]);
    expect(sizes()).toEqual([["Jost", 18], ["Jost", 18]]);
    getState().undo();
    expect(JSON.stringify(getState().project.rooms!.map((r) => r.stamp ?? null))).toBe(before);
  });
});
