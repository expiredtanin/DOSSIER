// Archicad-Morphs im IFC (Körper als IfcBuildingElementProxy mit IfcFacetedBrep, „Brep“): nach dem Import als
// Kontext-Meshes oder als Bauteile im Grundriss per Klick anwählbar (Rückmeldung Maintainer 24.11.: „Morphs aus
// Archicad nicht anwählbar“). Die Datei ist synthetisch (keine Fremd-Testdaten im Repo).
// Eigener Port: E2E_PORT=5193 npx playwright test e2e/ifcMorph.spec.ts
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, test } from "./app";
import type {} from "../src/state/testHooks";

test.use({ viewport: { width: 1600, height: 1000 } });

/** IFC4 in Millimetern: je Morph ein Quader (x0..x0+2000, 0..1500, 0..1200) als IfcFacetedBrep. */
function morphIfc(): string {
  let n = 100;
  const lines: string[] = [];
  const add = (s: string) => {
    lines.push(`#${++n}=${s};`);
    return n;
  };
  const ids: number[] = [];
  const morphs: [string, string, number][] = [
    ["IFCBUILDINGELEMENTPROXY", "Morph-001", 0],
    ["IFCBUILDINGELEMENTPROXY", "Morph-002", 3000],
    ["IFCSLAB", "Morph als Decke", 6000],
  ];
  for (const [cls, name, x] of morphs) {
    const p = (a: number, b: number, c: number) => add(`IFCCARTESIANPOINT((${a}.,${b}.,${c}.))`);
    const c = [p(x, 0, 0), p(x + 2000, 0, 0), p(x + 2000, 1500, 0), p(x, 1500, 0), p(x, 0, 1200), p(x + 2000, 0, 1200), p(x + 2000, 1500, 1200), p(x, 1500, 1200)];
    const faces = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ].map((f) => {
      const loop = add(`IFCPOLYLOOP((${f.map((i) => "#" + c[i]).join(",")}))`);
      return add(`IFCFACE((#${add(`IFCFACEOUTERBOUND(#${loop},.T.)`)}))`);
    });
    const brep = add(`IFCFACETEDBREP(#${add(`IFCCLOSEDSHELL((${faces.map((f) => "#" + f).join(",")}))`)})`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${add(`IFCSHAPEREPRESENTATION(#11,'Body','Brep',(#${brep}))`)}))`);
    const gid = `0Morph${String(ids.length).padStart(16, "0")}`;
    ids.push(add(`${cls}('${gid}',$,'${name}',$,$,#20,#${shape},$,$${cls === "IFCSLAB" ? ",.FLOOR." : ""})`));
  }
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('morph.ifc','2026-11-24T00:00:00',(''),(''),'test','test','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "#1=IFCPROJECT('2gSghlMTXEy89fLpLgWr2V',$,'P',$,$,$,$,(#10),#5);",
    "#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
    "#5=IFCUNITASSIGNMENT((#2));",
    "#6=IFCCARTESIANPOINT((0.,0.,0.));",
    "#9=IFCAXIS2PLACEMENT3D(#6,$,$);",
    "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);",
    "#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);",
    "#12=IFCSITE('1dO00rwNDBrx65X9raH78B',$,'S',$,$,$,$,$,$,$,$,$,$,$);",
    "#13=IFCBUILDING('0YVCIJ92bAnPD0qha$Hv2y',$,'B',$,$,$,$,$,$,$,$,$);",
    "#14=IFCBUILDINGSTOREY('1B9Jjyig9DQAJoq3hLdfi_',$,'EG',$,$,$,$,$,$,0.);",
    "#15=IFCRELAGGREGATES('0ycoshV$nAOOwai78L8JgO',$,$,$,#1,(#12));",
    "#16=IFCRELAGGREGATES('2eZ3_ThDj7cAiHMIq5BkR6',$,$,$,#12,(#13));",
    "#17=IFCRELAGGREGATES('2Ywh6CE3L1Dv5Nd04DMU8p',$,$,$,#13,(#14));",
    "#20=IFCLOCALPLACEMENT($,#9);",
    ...lines,
    `#900=IFCRELCONTAINEDINSPATIALSTRUCTURE('3Morph0000000000000000',$,$,$,(${ids.map((i) => "#" + i).join(",")}),#14);`,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

async function screenAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page
    .locator("svg.plan-svg")
    .first()
    .evaluate(
      (el, [x, y]) => {
        const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
        const ox = Number(el.getAttribute("data-origin-x") ?? 0);
        const oy = Number(el.getAttribute("data-origin-y") ?? 0);
        const r = el.getBoundingClientRect();
        const s = Math.min(r.width / vw, r.height / vh);
        return { x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s, y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s };
      },
      [x, y],
    );
}

async function importMorphs(page: Page, mode: RegExp) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await page.locator('input[type=file][accept=".ifc"]').setInputFiles({ name: "morph.ifc", mimeType: "application/octet-stream", buffer: Buffer.from(morphIfc(), "utf8") });
  const dialog = page.getByRole("dialog", { name: "IFC importieren" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByText(mode).first().click();
  await dialog.getByRole("button", { name: "Importieren", exact: true }).click();
  await discardIfAsked(page);
  await expect
    .poll(() => page.evaluate(() => window.__dossierTest!.context().filter((c) => c.type === "importedMesh").length), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

/** Klick auf die Mitte jedes Morphs (Grundriss, Modell-m); liefert, was danach ausgewählt ist. */
async function clickMorphs(page: Page): Promise<string[]> {
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const out: string[] = [];
  for (const x of [1, 4, 7]) {
    await blurFocus(page);
    await page.keyboard.press("Escape");
    const s = await screenAt(page, x, 0.3); // neben der Schnittlinie A des neuen Projekts (y = 0.75)
    await page.mouse.click(s.x, s.y);
    let sel: Record<string, string[]> = {};
    for (let i = 0; i < 15; i++) {
      sel = await page.evaluate(() => JSON.parse(window.__dossierTest!.selected().all) as Record<string, string[]>);
      if (Object.values(sel).some((v) => v.length)) break;
      await page.waitForTimeout(100);
    }
    out.push(JSON.stringify(Object.fromEntries(Object.entries(sel).filter(([, v]) => v.length))));
    await page.waitForTimeout(450);
  }
  return out;
}

for (const [label, mode] of [
  ["Kontext-Meshes", /Als Kontext-Meshes/],
  ["Bauteile", /^Als Bauteile$/],
] as const) {
  test(`Archicad-Morphs (IFC, ${label}): im Grundriss per Klick anwählbar`, async ({ page }) => {
    test.setTimeout(180_000);
    await importMorphs(page, mode);
    const meshes = await page.evaluate(() => window.__dossierTest!.context().filter((c) => c.type === "importedMesh").map((c) => c.id));
    // Als Bauteile wird der Morph mit IfcSlab eine Decke, die Proxys bleiben Netze.
    expect(meshes.length).toBe(label === "Bauteile" ? 2 : 3);
    const picked = await clickMorphs(page);
    for (const [i, s] of picked.entries()) {
      if (meshes[i]) expect(s, `Morph ${i + 1}`).toContain(meshes[i]);
      else expect(s, `Morph ${i + 1} (Decke)`).toContain("ceilings");
    }
  });
}
