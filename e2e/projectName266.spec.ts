// [266] Projektname im Panel Mappe änderbar (Enter übernimmt, Kopfzeile folgt, Undo stellt zurück);
// neues Projekt hat 2.90 m Geschosshöhe.
import { expect, openTab, startNewProject, test } from "./app";

test("[266] Projektname ändern: Kopfzeile folgt, Undo stellt ihn zurück", async ({ page }) => {
  await startNewProject(page);
  const header = page.locator(".project-name");
  const before = (await header.innerText()).trim();
  await openTab(page, "Mappe");
  const field = page.getByTestId("project-name");
  await expect(field).toHaveValue(before);
  await field.fill("Haus am See");
  await field.press("Enter");
  await expect(header).toHaveText("Haus am See");
  // Leer übernehmen bleibt wirkungslos.
  await field.fill("   ");
  await field.press("Enter");
  await expect(header).toHaveText("Haus am See");
  await expect(field).toHaveValue("Haus am See");
  await page.screenshot({ path: "test-results/projectName266.png" });
  await page.locator("body").press("Control+z");
  await expect(header).toHaveText(before);
});
