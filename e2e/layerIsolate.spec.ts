// [192] Ebenen schnell schalten (Musterhaus komplex): Rechtsklick auf eine Ebene im Panel bzw. auf ein Objekt im
// Plan → isolieren; „Alle Ebenen einblenden" stellt den Zustand davor wieder her. Zahlen über die Test-Naht
// `?dossierTest` (`layerView`).
import { discardIfAsked, expect, fileMenu, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

test("Ebenen isolieren und wieder einblenden", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await openTab(page, "Ebenen");
  const view = () => page.evaluate(() => window.__dossierTest!.layerView());
  const before = await view();
  expect(before.visible.length).toBeGreaterThan(3);

  // Ebenen-Panel: Rechtsklick auf die Zeile → „Nur diese Ebene anzeigen".
  const row = page.locator(".cat-row").first();
  const code = (await row.locator(".cat-code").textContent())!.trim();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Nur diese Ebene anzeigen" }).click();
  await expect.poll(async () => (await view()).visible).toContain(code);
  expect((await view()).visible.length).toBeLessThan(before.visible.length);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Alle Ebenen einblenden" }).click();
  await expect.poll(async () => (await view()).visible).toEqual(before.visible);

  // Plan: Wand gewählt, Rechtsklick → Ebene des Objekts isolieren → nur noch deren Ebene.
  await page.evaluate((id) => window.__dossierTest!.select({ walls: [id] }), before.wallId);
  const plan = page.locator("svg.plan-svg").first();
  await plan.click({ button: "right", position: { x: 5, y: 5 } });
  await page.getByRole("menuitem", { name: /Ebene des Objekts isolieren/ }).click();
  const iso = await view();
  expect(iso.visible.length).toBeLessThan(before.visible.length);
  expect(iso.wallPrims).toBeGreaterThan(0);
  expect(iso.prims).toBeLessThan(before.prims);
  await plan.click({ button: "right", position: { x: 5, y: 5 } });
  await page.getByRole("menuitem", { name: "Alle Ebenen einblenden" }).click();
  await expect.poll(async () => (await view()).visible).toEqual(before.visible);
  expect((await view()).prims).toBe(before.prims);
});
