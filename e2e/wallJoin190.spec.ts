// [190] Cmd/Ctrl+J verbindet gewählte Wände an Ecken: zwei Wände mit 0.3 m Lücke, beide wählen, Ctrl+J →
// die Achsen treffen sich im Schnittpunkt (ein Undo-Schritt). Geprüft am gespeicherten Projekt.
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, fileMenu, finishCommand, openTab, startNewProject, test, typeCommand } from "./app";

type W = { start: { x: number; y: number }; end: { x: number; y: number } };

async function savedWalls(page: Page): Promise<W[]> {
  await blurFocus(page);
  const pending = page.waitForEvent("download");
  await fileMenu(page, "Projekt speichern");
  const dl = await pending;
  return JSON.parse((await readFile(await dl.path())).toString("utf8")).walls as W[];
}

async function drawWalls(page: Page, walls: [string, string][]): Promise<void> {
  for (const [a, b] of walls) {
    await page.getByRole("button", { name: "Wand", exact: true }).click();
    if (!(await page.locator(".cmdline-prompt").textContent())?.includes("Startpunkt")) {
      await page.getByRole("button", { name: "Wand", exact: true }).click();
    }
    await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
    await commandInput(page).focus();
    await typeCommand(page, a);
    await typeCommand(page, b);
    await finishCommand(page);
  }
}

test("Wände mit Lücke an der Ecke per Ctrl+J verbinden, rückgängig", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await drawWalls(page, [
    ["0,0", "5.7,0"],
    ["6,0.3", "6,4"],
  ]);
  await blurFocus(page);
  // Zurück ins Auswahl-Werkzeug, alles wählen.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+j");
  const meets = (ws: W[]) =>
    ws.some((w) => Math.abs(w.end.x - 6) < 1e-6 && Math.abs(w.end.y) < 1e-6) &&
    ws.some((w) => Math.abs(w.start.x - 6) < 1e-6 && Math.abs(w.start.y) < 1e-6);
  await expect.poll(async () => meets(await savedWalls(page))).toBe(true);

  // Ein Undo-Schritt stellt die Lücke wieder her.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedWalls(page)).some((w) => Math.abs(w.end.x - 5.7) < 1e-6)).toBe(true);
});
