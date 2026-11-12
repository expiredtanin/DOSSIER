// [204] Nachtrag: Objekt-Info Masse je Art (a), Wand mit Öffnungen führt (f), Objekteinstellungen:
// Esc schliesst, Kopf nur einmal (c). Musterhaus: Wand W2 (x=5), Tür D1 in W1.
import type { Page } from "@playwright/test";
import { blurFocus, expect, openSample, openTab, test } from "./app";
import type {} from "../src/state/testHooks";

async function startNewProject(page: Page) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
}

test("Objekt-Info: Wand zeigt Länge/Dicke/Höhe, Tür ihre Masse ([204a])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W2"] }));
  const info = page.locator(".objinfo-panel");
  await expect(info.getByTestId("objinfo-dim")).toHaveCount(3);
  await expect(info.getByTestId("objinfo-dim").nth(0)).toContainText("Länge");
  await expect(info.getByTestId("objinfo-dim").nth(1)).toContainText("Dicke");
  await expect(info.getByTestId("objinfo-dim").nth(0)).not.toContainText("0.000");
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["D1"] }));
  await expect(info.getByTestId("objinfo-dim").nth(2)).toContainText("Brüstung");
});

test("Wand samt Öffnung gewählt: Objekt-Info zeigt die Wand ([204f])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1"], openings: ["D1"] }));
  await expect(page.locator(".objinfo-kind")).toHaveText("Wand");
});

test("Objekteinstellungen (T): Esc schliesst, Titel nur einmal ([204c])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W2"] }));
  await page.keyboard.press("t");
  const pal = page.locator(".floating-panel");
  await expect(pal).toBeVisible();
  await expect(pal.getByText("Objekteinstellungen", { exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(pal).toHaveCount(0);
});
