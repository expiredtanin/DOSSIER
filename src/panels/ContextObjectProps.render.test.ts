// [212] Material des Geländes in der Objekt-Info: Auswahl der Bauteile (Standard Wiese), die Änderung ist ein Op mit
// einem Undo-Schritt und kommt im 3D als Textur-Ebene am Gelände an. Ohne DOM: Server-Render des Abschnitts.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { TerrainMesh } from "../model/types";
import { getState } from "../state/appStore";
import { projectToModel3d, wallMaterialColorMaps } from "../plan/toWalls3d";
import { t } from "../i18n";
import { PanelHostProvider } from "./host";
import type { PanelHost } from "./types";
import { ContextObjectProps } from "./ContextObjectProps";

const host = {} as unknown as PanelHost;
const terrain = () => getState().project.context!.find((o): o is TerrainMesh => o.type === "terrainMesh")!;
const html = () => renderToString(createElement(PanelHostProvider, { value: host }, createElement(ContextObjectProps, { obj: terrain(), quantities: [] })));
const terrainLayer = () => projectToModel3d(getState().project).meshes.find((m) => m.kind === "terrain")!.materialIndex;

describe("[212] Gelände-Material in der Objekt-Info", () => {
  it("Auswahl mit allen Bauteilen, ohne Bauteil „Wiese (Standard)“", () => {
    getState().loadProject(buildComplexSampleProject());
    const out = html();
    expect(out).toContain('data-testid="terrain-material"');
    expect(out).toContain(t("site.terrain.material.none"));
    for (const c of getState().project.components ?? []) expect(out).toContain(`value="${c.id}"`);
  });

  it("Bauteil wählen: ein Op, im 3D die Textur-Ebene seiner Farbkarte; Undo stellt zurück", () => {
    getState().loadProject(buildComplexSampleProject());
    const kies = (getState().project.components ?? []).find((c) => c.material?.color?.includes("Gravel043"))!;
    const id = terrain().id;
    expect(terrainLayer()).toBeUndefined();
    const depth = getState().undoDepth;
    getState().patchContextObject(id, { componentId: kies.id });
    expect(terrain().componentId).toBe(kies.id);
    expect(getState().undoDepth).toBe(depth + 1);
    expect(terrainLayer()).toBe(wallMaterialColorMaps(getState().project).indexOf(kies.material!.color!) + 1);
    expect(html()).toMatch(new RegExp(`<option selected="" value="${kies.id}"|value="${kies.id}" selected=""`));
    // Zurück auf „Wiese“: Feld entfällt.
    getState().patchContextObject(id, { componentId: undefined });
    expect("componentId" in terrain() && terrain().componentId !== undefined).toBe(false);
    getState().undo();
    expect(terrain().componentId).toBe(kies.id);
    getState().undo();
    expect(terrain().componentId).toBeUndefined();
    expect(terrainLayer()).toBeUndefined();
  });
});
