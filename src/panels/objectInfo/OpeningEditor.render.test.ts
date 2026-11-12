// [195b] Der Fenster-/Türeditor ist Abschnitt des Bereichs „Objekt" (früher modaler Dialog) und die Abschnitte
// zeigen „gemischt" bei abweichenden Werten der Mehrfachauswahl. Ohne DOM: Server-Render des Panels.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { getState, setState } from "../../state/appStore";
import { EMPTY_SELECTION } from "../../state/selection";
import { PanelHostProvider } from "../host";
import type { PanelHost } from "../types";
import { ObjectSettingsPanel } from "../objectSettings/ObjectSettingsPanel";

const host = { activeTool: "select", sectionLine: null, displayMode: { mode: "all", setMode: () => {} } } as unknown as PanelHost;
const render = () => renderToString(createElement(PanelHostProvider, { value: host }, createElement(ObjectSettingsPanel)));

describe("Objekteinstellungen: Öffnung [195b]", () => {
  it("Wandöffnung gewählt: Abschnitt „Fenster-/Türeditor“ mit dem Editor im Bereich Objekt", () => {
    getState().loadProject(buildComplexSampleProject());
    const o = getState().project.openings!.find((x) => !x.hostRoofId && !x.hostCeilingId)!;
    setState({ selection: { ...EMPTY_SELECTION, openings: [o.id] } });
    const html = render();
    expect(html).toContain('data-group="openingEditor"');
    expect(html).toContain('data-testid="opening-editor"');
    expect(html).not.toContain("imp-overlay");
  });

  it("zwei Öffnungen mit abweichender Breite: „gemischt“ am Breitenfeld", () => {
    const p = buildComplexSampleProject();
    const [a, b] = p.openings!.filter((x) => !x.hostRoofId && !x.hostCeilingId);
    const q = { ...p, openings: p.openings!.map((x) => (x.id === a.id ? { ...x, width: 1 } : x.id === b.id ? { ...x, width: 1.4 } : x)) };
    getState().loadProject(q);
    setState({ selection: { ...EMPTY_SELECTION, openings: [a.id, b.id] } });
    expect(render()).toContain('data-mixed="width"');
    setState({ selection: { ...EMPTY_SELECTION, openings: [a.id] } });
    expect(render()).not.toContain('data-mixed="width"');
  });

  it("zwei Treppen mit abweichender Breite: Treppen-Abschnitt mit „gemischt“; zwei Dächer ohne Gauben-/Kantenabschnitt", () => {
    const p = buildComplexSampleProject();
    const [a, b] = p.stairs!;
    getState().loadProject({ ...p, stairs: p.stairs!.map((x) => (x.id === a.id ? { ...x, width: 1 } : x.id === b.id ? { ...x, width: 1.3 } : x)) });
    setState({ selection: { ...EMPTY_SELECTION, stairs: [a.id, b.id] } });
    expect(render()).toContain('data-mixed="width"');
    const [r1, r2] = getState().project.roofs!;
    setState({ selection: { ...EMPTY_SELECTION, roofs: [r1.id] } });
    const single = render();
    setState({ selection: { ...EMPTY_SELECTION, roofs: [r1.id, r2.id] } });
    const multi = render();
    expect(multi).not.toContain("objinfo-dormer");
    expect(multi.length).toBeLessThan(single.length);
  });
});
