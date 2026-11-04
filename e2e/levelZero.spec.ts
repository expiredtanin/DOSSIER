// [131] Bezugsgeschoss ±0.00: im Geschoss-Editor ein anderes Geschoss auf ±0.00 legen — die Geschosse darunter
// erhalten negative Höhen (Navigator), ein Undo-Schritt stellt den alten Stapel wieder her.
import { blurFocus, expect, openSample, openTab, startNewProject, test } from "./app";

test("Geschoss als ±0.00 wählen: Erdgeschoss liegt danach negativ", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Zeichnungsebenen");
  const egElev = page.getByTestId("level-elev-eg");
  const ogElev = page.getByTestId("level-elev-og");
  await expect(egElev).toHaveText("±0.00");
  await expect(ogElev).toHaveText("+2.60");

  await page.locator(".nav-row", { hasText: "Obergeschoss" }).first().click({ button: "right" });
  await page.getByText("Einstellungen…", { exact: true }).click();
  const zero = page.getByTestId("level-zero");
  await expect(zero).not.toBeChecked();
  await zero.check();
  await expect(egElev).toHaveText("−2.60");
  await expect(ogElev).toHaveText("±0.00");
  await expect(page.getByTestId("level-elevation")).toHaveText("±0.00");
  await expect(zero).toBeChecked();

  // Geschosshöhe des EG ändert sich → ±0.00 bleibt beim OG, das EG wandert nach unten.
  await page.keyboard.press("Escape");
  await page.locator(".nav-row", { hasText: "Erdgeschoss" }).first().click({ button: "right" });
  await page.getByText("Einstellungen…", { exact: true }).click();
  const h = page.locator(".editor-num input[type=number]").first();
  await h.fill("2.8");
  await expect(egElev).toHaveText("−2.80");
  await expect(ogElev).toHaveText("±0.00");
  await page.keyboard.press("Escape");

  // Undo: Höhe zurück, dann Bezug zurück (ein Schritt) → EG wieder ±0.00.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(egElev).toHaveText("−2.60");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(egElev).toHaveText("±0.00");
  await expect(ogElev).toHaveText("+2.60");
});
