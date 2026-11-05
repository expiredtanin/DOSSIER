// [66] Präsentationsplan mit einem Klick: Musterhaus komplex → Knopf im Layouts-Panel → Dialog → Blatt mit je
// einem Viewport für die gewählten Geschosse, alle Ansichten und einen Schnitt; ein Undo-Schritt entfernt es.
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, startNewProject, test, typeCommand } from "./app";

test.use({ viewport: { width: 1600, height: 1000 } });

test("Präsentationsplan: Dialog erstellt Blatt mit N Viewports, Undo entfernt es", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  // Über die Befehlszeile (Alias) öffnen, Dialog schliessen, dann über den Knopf im Layouts-Panel.
  await typeCommand(page, "praesentationsplan");
  const dialog = page.getByRole("dialog", { name: "Präsentationsplan" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toBeHidden();
  await openTab(page, "Mappe");
  await page.locator("[data-testid=presentation-open]").click();
  await expect(dialog).toBeVisible();

  const floors = dialog.locator("input[data-floor]");
  const nFloors = await floors.count();
  expect(nFloors).toBeGreaterThanOrEqual(4);
  // Erstes Geschoss abwählen, Ansichten + Schnitt bleiben.
  await floors.first().uncheck();
  await expect(dialog.locator("[data-testid=presentation-elevations]")).toBeChecked();
  expect(await dialog.locator("[data-testid=presentation-section]").inputValue()).not.toBe("");
  await dialog.locator("[data-testid=presentation-create]").click();
  await expect(dialog).toBeHidden();

  // Blatt ist offen: Grundrisse (ohne das abgewählte) + 4 Ansichten + 1 Schnitt.
  const vps = page.locator("[data-viewport-id]");
  await expect(vps).toHaveCount(nFloors - 1 + 4 + 1, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/presentation-sheet.png` });

  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect(vps).toHaveCount(0, { timeout: 10_000 });
});
