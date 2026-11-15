// [260] Fenster/Türen im Grundriss symbolisch oder geschnitten: Fenster wählen, T, Brüstung über die Schnitthöhe,
// Darstellung „geschnitten“ → Wand geschlossen, Linie über Schnitt; Rückgängig → wieder symbolisch.
// Musterhaus: Fenster O1 in W1, Schnitthöhe EG 1.0 m.
import type { Page } from "@playwright/test";
import { blurFocus, expect, openSample, test } from "./app";
import type {} from "../src/state/testHooks";

const aboveCut = (page: Page) => page.evaluate(() => window.__dossierTest!.planLines("view-range"));

test("Fenster über der Schnitthöhe: symbolisch (Vorgabe) ↔ geschnitten über Taste T, ein Undo-Schritt", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["O1"] }));
  await blurFocus(page);
  await page.keyboard.press("t");
  const panel = page.locator(".objset-panel");
  await expect(panel).toBeVisible();
  const group = panel.locator('[data-group="opening"]');

  // Badfenster: Brüstung 1.10 m, Höhe 0.60 m — ganz über der Schnittebene.
  const sill = group.locator("label.objinfo-field", { hasText: "Brüstung" }).first().locator("input");
  await sill.fill("1.1");
  await sill.press("Enter");
  const height = group.locator("label.objinfo-field", { has: page.locator(".objinfo-flabel", { hasText: /^Höhe$/ }) }).first().locator("input");
  await height.fill("0.6");
  await height.press("Enter");
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.heights().openings.find((o) => o.id === "O1")))?.sillHeight).toBe(1.1);
  // Vorgabe symbolisch: Symbol in der Wandlücke, keine Linie über Schnitt.
  expect(await aboveCut(page)).toBe(0);

  // Darstellung „geschnitten“: Wand geschlossen, Öffnung als Linie über Schnitt.
  const mode = group.locator('.tb-dd-trigger[aria-label^="Darstellung im Grundriss"]');
  await expect(mode).toContainText("Wie Typ");
  // Erst in Sicht bringen: das Aufklappmenü schliesst bei jedem Scrollen.
  await mode.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await mode.click();
  await page.getByRole("option", { name: "geschnitten", exact: true }).click();
  await expect(mode).toContainText("geschnitten");
  await expect.poll(() => aboveCut(page)).toBeGreaterThan(0);

  // Rückgängig: ein Schritt zurück zur Vorgabe.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => aboveCut(page)).toBe(0);
  await expect(mode).toContainText("Wie Typ");
  expect((await page.evaluate(() => window.__dossierTest!.heights().openings.find((o) => o.id === "O1")))?.sillHeight).toBe(1.1);
});
