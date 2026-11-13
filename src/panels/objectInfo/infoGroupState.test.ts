// [239] Einklappbare Abschnitte der Objekt-Info: Standard, Merken je Abschnitts-Art, Fokus-Anfrage, Server-Render.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { getState, setState } from "../../state/appStore";
import { EMPTY_SELECTION } from "../../state/selection";
import { PanelHostProvider } from "../host";
import type { PanelHost } from "../types";
import { ObjectInfoPanel } from "../ObjectInfoPanel";
import { InfoGroup } from "./InfoGroup";
import { INFO_GROUP_DEFAULT_COLLAPSED, type InfoGroupId } from "./groups";
import {
  expandAndFocusInfoGroup, getInfoGroupState, isInfoGroupOpen, resetInfoGroupsForTest, toggleInfoGroup,
} from "./infoGroupState";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  };
  resetInfoGroupsForTest();
});

const open = (id: InfoGroupId) => isInfoGroupOpen(getInfoGroupState(), id);

describe("Abschnitte einklappen [239]", () => {
  it("Standard: alles offen ausser der Auskunfts-Gruppe Georeferenzierung", () => {
    expect([...INFO_GROUP_DEFAULT_COLLAPSED]).toEqual(["georef"]);
    expect(open("wall")).toBe(true);
    expect(open("refpoint")).toBe(true);
    expect(open("georef")).toBe(false);
  });

  it("Umschalten gilt je Abschnitts-Art und wird gemerkt (nur Abweichungen vom Standard)", () => {
    toggleInfoGroup("dimensions");
    toggleInfoGroup("georef");
    expect(open("dimensions")).toBe(false);
    expect(open("georef")).toBe(true);
    expect(open("wall")).toBe(true);
    expect(JSON.parse(store.get("dossier.objinfo.groups")!)).toEqual({ dimensions: false, georef: true });
    resetInfoGroupsForTest(true); // neues Fenster / neuer Start liest den Speicher
    expect(open("dimensions")).toBe(false);
    expect(open("georef")).toBe(true);
    toggleInfoGroup("dimensions"); // zurück auf Standard: kein Eintrag mehr
    expect(JSON.parse(store.get("dossier.objinfo.groups")!)).toEqual({ georef: true });
  });

  it("Fokus-Anfrage (Taste T) klappt den Abschnitt auf", () => {
    toggleInfoGroup("wall");
    expect(open("wall")).toBe(false);
    expandAndFocusInfoGroup("wall");
    expect(open("wall")).toBe(true);
    expect(getInfoGroupState().focus?.id).toBe("wall");
  });

  it("Kopf ist ein Knopf (Enter/Leertaste) mit aria-expanded; zugeklappt fehlt der Rumpf", () => {
    const html = () => renderToString(createElement(InfoGroup, { id: "dimensions", children: createElement("i", { id: "body" }) }));
    expect(html()).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(html()).toContain('id="body"');
    toggleInfoGroup("dimensions");
    expect(html()).toMatch(/aria-expanded="false"/);
    expect(html()).not.toContain('id="body"');
  });

  it("Objekt-Info: Bezugspunkt und Masse sind Abschnitte, zugeklappt bleibt der Kopf", () => {
    const p = buildComplexSampleProject();
    getState().loadProject(p);
    setState({ selection: { ...EMPTY_SELECTION, walls: [p.walls[0].id] } });
    const host = { activeTool: "select", sectionLine: null, displayMode: { mode: "all", setMode: () => {} } } as unknown as PanelHost;
    const html = () => renderToString(createElement(PanelHostProvider, { value: host }, createElement(ObjectInfoPanel)));
    expect(html()).toContain('data-group="refpoint"');
    expect(html()).toContain('data-group="dimensions"');
    expect(html()).toContain("objinfo-cube");
    toggleInfoGroup("refpoint");
    expect(html()).toContain('data-group="refpoint"');
    expect(html()).not.toContain("objinfo-cube");
  });
});
