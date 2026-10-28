import {
  blurFocus,
  commandInput,
  elementRows,
  finishCommand,
  expect,
  openTab,
  startNewProject,
  test,
  typeCommand,
} from "./app";
import type { Page } from "@playwright/test";

/** Wandwerkzeug aus der Werkzeugliste wählen; die Befehlszeile fragt dann nach dem Startpunkt. */
async function pickWallTool(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
}

test("Wand per Klicks im Grundriss zeichnen", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);

  const box = (await page.locator("canvas").first().boundingBox())!;
  const at = (dx: number, dy: number) => ({ x: box.x + dx, y: box.y + dy });
  const a = at(150, 300);
  const b = at(450, 300);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator(".cmdline-prompt")).toHaveText("Nächster Punkt:");
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  await finishCommand(page);

  await expect(elementRows(page)).toHaveCount(1);
  await expect(elementRows(page).first()).toContainText("Aussenwand 34.5 cm");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
});

test("Wand über die Befehlszeile (Koordinaten tippen)", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Nächster Punkt:");
  await typeCommand(page, "5,0");
  await typeCommand(page, "5,4");
  // Der Zug (Kette) wird erst mit leerem Enter übernommen: drei Punkte = zwei Wände.
  await finishCommand(page);
  await expect(elementRows(page)).toHaveCount(2);
});

test("Rückgängig/Wiederholen per Tastatur und Menü", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await expect(elementRows(page)).toHaveCount(1);

  // Fokus aus der Befehlszeile nehmen, damit die Kürzel nicht ins Textfeld gehen.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(elementRows(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(elementRows(page)).toHaveCount(1);

  // Dasselbe über das Bearbeiten-Menü.
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Rückgängig" }).click();
  await expect(elementRows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Wiederholen" }).click();
  await expect(elementRows(page)).toHaveCount(1);
});
