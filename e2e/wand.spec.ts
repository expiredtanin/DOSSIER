// [77] Zauberstab (Befehl `zauberstab`, Kürzel `zs`): Rechteck zeichnen, in die Mitte klicken → neue geschlossene
// Polylinie mit Schraffur (ein Verlaufsschritt), Rückgängig nimmt sie wieder weg. Geprüft über den Verlauf
// (Panel „Verlauf"), nicht über Pixel — die WebGPU-Engines zeichnen headless nichts Verlässliches.
import { blurFocus, expect, startNewProject, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

/** Bisherige Rückgängig-Schritte (Panel „Verlauf", ohne Ausgangsstand und wiederholbare). */
function doneSteps(page: Page) {
  return page.locator("[data-testid=history-panel] .history-row:not(.future)").filter({ hasNotText: "Ausgangsstand" });
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Verlauf" }).click();
  await expect(page.locator("[data-testid=history-panel]")).toBeVisible();
}

async function clickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x - 6, p.y - 6);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.click(p.x, p.y);
}

test("Zauberstab: Klick in ein Rechteck legt eine Fläche an, Rückgängig nimmt sie weg", async ({ page }) => {
  await startNewProject(page);
  await openHistory(page);
  await expect(doneSteps(page)).toHaveCount(0);

  const box = (await page.locator("canvas").first().boundingBox())!;
  const at = (u: number, v: number) => ({ x: box.x + u * box.width, y: box.y + v * box.height });

  // Rechteck aus zwei Klicks (Ecken), danach ist es EIN Verlaufsschritt.
  // (Das schwebende Verlaufs-Panel verdeckt die Werkzeugliste: Befehl über die Befehlszeile, Ecken rechts davon.)
  await page.locator(".cmdline-input").focus();
  await typeCommand(page, "rect");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Ecke|Startpunkt/);
  await clickAt(page, at(0.5, 0.45));
  await clickAt(page, at(0.8, 0.7));
  if ((await page.locator(".cmdline-prompt").textContent()) !== "Befehl:") await page.locator(".cmdline-input").press("Enter");
  await expect(doneSteps(page)).toHaveCount(1);

  // Zauberstab über die Befehlszeile; Klick in die Mitte des Rechtecks.
  await page.locator(".cmdline-input").focus();
  await typeCommand(page, "zauberstab");
  await expect(page.locator(".cmdline-prompt")).not.toHaveText("Befehl:");
  await clickAt(page, at(0.65, 0.57));
  await expect(doneSteps(page)).toHaveCount(2);

  // Rückgängig: nur die Fläche verschwindet, das Rechteck bleibt.
  await page.keyboard.press("Escape");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(doneSteps(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(doneSteps(page)).toHaveCount(2);
});

test("Zauberstab: Klick ausserhalb jeder Masche legt nichts an", async ({ page }) => {
  await startNewProject(page);
  await openHistory(page);
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.locator(".cmdline-input").focus();
  await typeCommand(page, "zauberstab");
  await clickAt(page, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 });
  await expect(doneSteps(page)).toHaveCount(0);
});
