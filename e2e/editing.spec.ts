import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";
import type { Page } from "@playwright/test";

/** Wand W1 (Erdgeschoss, 5 m lang) über den Elemente-Baum wählen. */
async function selectW1(page: Page): Promise<void> {
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
}

test("Auswahl und Eigenschaft ändern: Wand-Oberkante, danach Rückgängig", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await selectW1(page);

  // Attribute-Panel: Wand-Abschnitt mit Volumen; Höhe = OK − UK (Geschosshöhe 2.60 m).
  const volume = page.getByText("Volumen").locator("..");
  await expect(volume).toContainText("3.42 m³");

  // Oberkante auf „Eigene" stellen und 3.2 m eintragen.
  const top = page.locator(".objinfo-wall-anchor").first();
  await top.getByRole("button", { name: "Eigene" }).click();
  const topField = top.getByLabel("Eigene Höhe");
  await expect(topField).toHaveValue("2.600");
  await topField.fill("3.2");
  await topField.press("Enter");
  await expect(volume).not.toContainText("3.42 m³");
  await expect(page.getByText("Höhe").locator("..").filter({ hasText: "3.20 m" })).toBeVisible();

  // Fokus ins Plan-Feld, dann Rückgängig: Eigene-Modus und Volumen sind zurück.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(volume).toContainText("3.42 m³");
});

test("Geschoss wechseln", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Zeichnungsebenen");
  const statusFloor = page.locator("footer.statusbar");
  await expect(statusFloor).toContainText("Erdgeschoss");

  await page.getByText("Obergeschoss", { exact: true }).click();
  await expect(statusFloor).toContainText("Obergeschoss");

  await page.getByText("Erdgeschoss", { exact: true }).first().click();
  await expect(statusFloor).toContainText("Erdgeschoss");
});
