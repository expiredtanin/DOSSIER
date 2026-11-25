// [329] Reiter „+“ (Rest aus [287] (8)): Auswahl statt immer einer Kopie — ein Geschoss öffnet einen neuen Grundriss-
// Reiter mit diesem Geschoss, „Kopie dieses Reiters“ verdoppelt wie bisher.
import { expect, startNewProject, test } from "./app";

const tabs = (page: import("@playwright/test").Page) => page.locator(".drawing-tab-label");

test("Reiter +: Geschoss im neuen Reiter, Kopie auf Wunsch", async ({ page }) => {
  await startNewProject(page);
  await expect(tabs(page)).toHaveText(["Erdgeschoss"]);
  await page.locator(".drawing-tab-add").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Obergeschoss" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Schnitt A" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Obergeschoss" }).click();
  await expect(tabs(page)).toHaveText(["Erdgeschoss", "Obergeschoss"]);
  await expect(page.locator(".drawing-tab.active .drawing-tab-label")).toHaveText("Obergeschoss");
  // Der erste Reiter zeigt weiter das Erdgeschoss.
  await tabs(page).first().click();
  await expect(page.locator(".drawing-tab.active .drawing-tab-label")).toHaveText("Erdgeschoss");
  await page.locator(".drawing-tab-add").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Kopie dieses Reiters" }).click();
  // Die Kopie kommt neben den aktiven Reiter.
  await expect.poll(async () => (await tabs(page).allTextContents()).sort()).toEqual(["Erdgeschoss", "Erdgeschoss", "Obergeschoss"]);
});
