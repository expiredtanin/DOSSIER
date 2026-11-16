// [263] Punkt 2: rechtes Dock bei 1280 × 800 — Panel einklappen gibt dem anderen den Platz.
// Eigener Port: E2E_PORT=5197 npx playwright test e2e/dockCollapse263.spec.ts
import type { Page } from "@playwright/test";
import { expect, openTab, startNewProject, test } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

const dock = (page: Page) => page.locator(".dock-right");
const groups = (page: Page) => dock(page).locator(".dock-group");
const toggle = (page: Page, i: number) => groups(page).nth(i).getByTestId("group-toggle");
const height = async (page: Page, i: number) => (await groups(page).nth(i).boundingBox())!.height;

test("rechtes Dock: Gruppe einklappen macht die andere hoch genug; Zustand bleibt nach Neuladen", async ({ page }) => {
  await startNewProject(page);
  await expect(groups(page)).toHaveCount(2);
  expect(await height(page, 1)).toBeLessThan(350); // untere Gruppe: ohne Einklappen nur scrollend lesbar
  await expect(toggle(page, 1)).toHaveAttribute("aria-expanded", "true");

  // Untere Gruppe einklappen: nur Kopf, obere bekommt den Platz.
  await toggle(page, 1).click();
  await expect(toggle(page, 1)).toHaveAttribute("aria-expanded", "false");
  expect(await height(page, 1)).toBeLessThan(60);
  expect(await height(page, 0)).toBeGreaterThan(550);

  // Zustand überlebt Neuladen.
  await page.waitForTimeout(500);
  await startNewProject(page); // lädt die Seite neu; das Layout liegt im localStorage
  await expect(groups(page)).toHaveCount(2);
  await expect(toggle(page, 1)).toHaveAttribute("aria-expanded", "false");
  expect(await height(page, 0)).toBeGreaterThan(550);

  // Tastatur: Leertaste klappt wieder aus; Enter klappt die obere ein.
  await toggle(page, 1).focus();
  await page.keyboard.press("Space");
  await expect(toggle(page, 1)).toHaveAttribute("aria-expanded", "true");
  await toggle(page, 0).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page, 0)).toHaveAttribute("aria-expanded", "false");
  expect(await height(page, 1)).toBeGreaterThan(550);

  // Klick auf einen Reiter der eingeklappten Gruppe klappt sie auf.
  await openTab(page, "Flächenbilanz");
  await expect(toggle(page, 0)).toHaveAttribute("aria-expanded", "true");
});

test("Gelände-Panel: Baurecht-Abschnitt ohne Scrollen sichtbar, wenn das obere Panel eingeklappt ist", async ({ page }) => {
  await startNewProject(page);
  await toggle(page, 0).click();
  await openTab(page, "Gelände");
  const panel = groups(page).nth(1);
  expect(await height(page, 1)).toBeGreaterThan(550);
  const heading = panel.getByText(/Baurecht/).first();
  await expect(heading).toBeVisible();
  const box = (await heading.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(800);
});
