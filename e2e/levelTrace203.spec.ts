// [203] Musterhaus komplex, Ausschnitt „EG 1:100“: der Geschoss-Grundriss zeigt nur sein Geschoss (wie Archicad) —
// keine Raumstempel anderer Geschosse (U./O./D.) und das Achsraster nur einmal. Andere Geschosse erscheinen nur als
// bewusst gewählte Pausfolie ([205]), nie über den Zeichnungsebenen-Modus.
import type { Page } from "@playwright/test";
import { discardIfAsked, expect, fileMenu, openTab, showSnapshot, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

/** Raumstempel je Geschoss und Blasen der Achse „A“ im Grundriss der aktiven Ebene (wie angezeigt). */
const stamps = (page: Page) => page.evaluate(() => window.__dossierTest!.planStamps("A"));
const level = (page: Page) => page.evaluate(() => window.__dossierTest!.viewCamera().levelId);

test("Ausschnitt EG 1:100 zeigt nur das Erdgeschoss; andere Geschosse nur als graue Pausfolie", async ({ page }) => {
  test.setTimeout(150_000);
  await openComplex(page);
  await showSnapshot(page, "EG 1:100");
  await expect.poll(() => level(page)).toBe("eg");
  await page.waitForTimeout(1500);
  const shot = process.env.SHOT_DIR;
  if (shot) await page.screenshot({ path: `${shot}/eg-1-100.png` });
  const s = await stamps(page);
  expect(s.floors.eg?.n ?? 0).toBeGreaterThan(3);
  expect(Object.keys(s.floors)).toEqual(["eg"]);
  // Achsraster einmal: Achse „A“ hat zwei Blasen (beide Enden), nicht je Geschoss weitere.
  expect(s.axis).toBe(2);

  // [205] Auch der Modus „Andere grau“ legt keine anderen Geschosse mehr darunter (er dimmt nur im 3D); ein anderes
  // Geschoss kommt nur als bewusst gewählte Pausfolie (e2e `trace205`).
  await openTab(page, "Zeichnungsebenen");
  await page.locator(".panel-vis .display-mode").first().click();
  await page.getByRole("option", { name: "Andere grau", exact: true }).click();
  await page.waitForTimeout(1500);
  const g = await stamps(page);
  expect(Object.keys(g.floors)).toEqual(["eg"]);
  expect(g.floors.eg.greyed).toBe(0);
  expect(g.axis).toBe(2);
});
