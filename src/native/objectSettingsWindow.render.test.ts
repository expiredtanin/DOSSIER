// [195b] Das native Fenster rendert dieselben Abschnitte wie das schwebende Panel, nur mit gespiegeltem Store und
// weiterleitendem Host (`remoteHost`). Ohne DOM: Server-Render des Panels im Fenster-Aufbau.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { getState } from "../state/appStore";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { EMPTY_SELECTION } from "../state/selection";
import { PanelHostProvider } from "../panels/host";
import type { PanelHost } from "../panels/types";
import { ObjectSettingsPanel } from "../panels/objectSettings/ObjectSettingsPanel";
import { setChangeSink } from "../state/changeSink";
import { mirrorIntoStore, remoteHost, type ObjectSettingsSnapshot } from "./objectSettingsSync";

afterEach(() => setChangeSink(null));

describe("Fenster Objekteinstellungen rendert die Panel-Abschnitte [195b]", () => {
  it("Wand gewählt: Bereiche Objekt + Darstellung, Inhalt statt „Keine Auswahl“", () => {
    const project = JSON.parse(JSON.stringify(buildComplexSampleProject())) as ObjectSettingsSnapshot["project"];
    const wall = project.walls[0];
    const snap: ObjectSettingsSnapshot = {
      project,
      ui: {
        selection: { ...EMPTY_SELECTION, walls: [wall.id] },
        activeLevelId: wall.floorId,
        host: { activeTool: "select", sectionLine: null },
        handlers: ["onSetWallType"],
        focus: null,
      },
    };
    mirrorIntoStore(null, snap);
    setChangeSink(() => {});
    const host = remoteHost(snap.ui, () => {}) as unknown as PanelHost;
    const html = renderToString(createElement(PanelHostProvider, { value: host }, createElement(ObjectSettingsPanel)));
    expect(getState().project).toBe(project);
    expect(html).toContain('data-area="object"');
    expect(html).toContain('data-area="appearance"');
    expect(html).not.toContain("objset-empty");
  });
});
