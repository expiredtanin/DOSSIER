// [287] UX beim Zeichnen: Buchstaben auf der Fläche öffnen die Befehlszeile („w“ + Enter = Wand),
// Esc beendet einen offenen Wandzug und behält die Wände, Länge + Enter legt das Segment sofort an.
import { blurFocus, commandInput, expect, startNewProject, test } from "./app";
import type { Page } from "@playwright/test";

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const walls = (page: Page) => page.evaluate(() => window.__dossierTest!.counts().walls);

async function moveTo(page: Page, dx: number, dy: number) {
  const box = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.move(box.x + dx - 6, box.y + dy - 6);
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 3 });
}
async function clickAt(page: Page, dx: number, dy: number) {
  await moveTo(page, dx, dy);
  await page.mouse.down();
  await page.mouse.up();
}

test("Tippen „w“ auf der Zeichenfläche + Enter startet die Wand", async ({ page }) => {
  await startNewProject(page, "?dossierTest");
  await blurFocus(page);
  await page.keyboard.press("w");
  await expect(commandInput(page)).toBeFocused();
  await expect(commandInput(page)).toHaveValue("w");
  await page.keyboard.press("Enter");
  await expect(prompt(page)).not.toHaveText("Befehl:");
});

test("Wandzug: Esc beendet und behält die Wände", async ({ page }) => {
  await startNewProject(page, "?dossierTest");
  const before = await walls(page);
  await blurFocus(page);
  await page.keyboard.press("w");
  await page.keyboard.press("Enter");
  await clickAt(page, 200, 220);
  await clickAt(page, 400, 220);
  await clickAt(page, 400, 380);
  await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await walls(page)).toBe(before + 2);
});

test("Länge tippen + Enter legt das Segment sofort an (zweites Enter beendet den Zug)", async ({ page }) => {
  await startNewProject(page, "?dossierTest");
  const before = await walls(page);
  await blurFocus(page);
  await page.keyboard.press("w");
  await page.keyboard.press("Enter");
  await clickAt(page, 200, 220);
  await moveTo(page, 420, 220);
  await page.keyboard.press("4");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cmdline")).toHaveAttribute("data-steps", "2");
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await walls(page)).toBe(before + 1);
});
