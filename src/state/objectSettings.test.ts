// [218] Doppelklick auf einen Raumstempel öffnet die Objekteinstellungen mit fokussiertem Abschnitt „Raumstempel"
// (Taste T dagegen mit dem ersten Abschnitt der Auswahl).
import { beforeEach, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { getInfoGroupState, resetInfoGroupsForTest } from "../panels/objectInfo/infoGroupState";
import { getSettingsArea } from "../panels/objectSettings/areaState";
import { getState, setState } from "./appStore";
import { openObjectSettings } from "./objectSettings";
import { EMPTY_SELECTION } from "./selection";

describe("openObjectSettings [218]", () => {
  let revealed: (string | null)[] = [];
  const deps = { activeTool: "select", revealObjectSettings: (g: string | null) => void revealed.push(g) };
  beforeEach(() => {
    revealed = [];
    resetInfoGroupsForTest();
    getState().loadProject(buildComplexSampleProject());
  });

  it("Raum gewählt: T zeigt den Abschnitt „Raum“, der Doppelklick auf den Stempel „Raumstempel“", () => {
    setState({ selection: { ...EMPTY_SELECTION, rooms: [getState().project.rooms![0].id] } });
    expect(openObjectSettings(deps)).toBe(true);
    expect(revealed).toEqual(["room"]);
    expect(openObjectSettings(deps, "roomStamp")).toBe(true);
    expect(revealed).toEqual(["room", "roomStamp"]);
    expect(getInfoGroupState().focus?.id).toBe("roomStamp");
    expect(getSettingsArea()).toBe("object");
  });

  it("ein Abschnitt, den die Auswahl nicht hat, wird nicht erzwungen", () => {
    setState({ selection: { ...EMPTY_SELECTION, walls: [getState().project.walls[0].id] } });
    openObjectSettings(deps, "roomStamp");
    expect(revealed).toEqual(["wall"]);
  });
});
