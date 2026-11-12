// [190] Verbinden über den Menü-Weg: auf macOS fängt das native Menü „Bearbeiten > Verbinden" Cmd+J ab, das
// Fenster bekommt die Taste nie. Der Test löst deshalb dieselbe Aktion wie der Menüpunkt aus
// (`runSelectionAction("join")` über den Test-Haken `selectionAction`), ohne Tastendruck — die Auswahl wird
// vorher gesetzt, danach sofort verbunden (keine veraltete Render-Closure). Prüft auch den T-Stoss an der
// Fläche und den Hinweis mit Grund.
import { blurFocus, commandInput, expect, finishCommand, openTab, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

type W = { id: string; start: { x: number; y: number }; end: { x: number; y: number } };

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

const walls = (page: Page) => page.evaluate(() => window.__dossierTest!.walls());
const menuJoin = async (page: Page) => {
  const all = await walls(page);
  await page.evaluate((ids) => {
    window.__dossierTest!.select({ walls: ids });
    window.__dossierTest!.selectionAction("join");
  }, all.map((w) => w.id));
};

async function start(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openTab(page, "Elemente");
}

test("Menü Bearbeiten > Verbinden: Lücke an der Ecke schliessen, Auswahl wird aufgeräumt", async ({ page }) => {
  await start(page);
  await drawWalls(page, [
    ["0,0", "5.7,0"],
    ["6,0.3", "6,4"],
  ]);
  await blurFocus(page);
  await menuJoin(page);
  await expect
    .poll(async () => {
      const ws = await walls(page);
      return ws.some((w) => Math.abs(w.end.x - 6) < 1e-6 && Math.abs(w.end.y) < 1e-6) && ws.some((w) => Math.abs(w.start.x - 6) < 1e-6 && Math.abs(w.start.y) < 1e-6);
    })
    .toBe(true);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await walls(page)).some((w) => Math.abs(w.end.x - 5.7) < 1e-6)).toBe(true);
});

test("Menü Verbinden: T-Stoss endet an der Fläche der Querwand", async ({ page }) => {
  await start(page);
  await drawWalls(page, [
    ["0,0", "5.7,0"],
    ["6,-3", "6,3"],
  ]);
  await blurFocus(page);
  await menuJoin(page);
  // Der Abzweig endet an der zugewandten Fläche (Wandtyp-Dicke/2 vor der Achse x = 6), die Querwand bleibt.
  await expect.poll(async () => (await walls(page)).find((w) => Math.abs(w.start.x) < 1e-6 && Math.abs(w.start.y) < 1e-6)!.end.x).toBeGreaterThan(5.7 + 1e-6);
  const ws = await walls(page);
  const branch = ws.find((w) => Math.abs(w.start.x) < 1e-6 && Math.abs(w.start.y) < 1e-6)!;
  expect(branch.end.x).toBeLessThan(6 - 1e-6);
  const through = ws.find((w) => Math.abs(w.start.x - 6) < 1e-6)!;
  expect(through.end).toEqual({ x: 6, y: 3 });
});

test("Menü Verbinden: Hinweis nennt den Grund (zu weit, parallel)", async ({ page }) => {
  await start(page);
  await drawWalls(page, [
    ["0,0", "4,0"],
    ["6,0", "6,4"],
  ]);
  await blurFocus(page);
  await menuJoin(page);
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.notices())).toContainEqual(expect.stringMatching(/Abstand zu gross \(2\.00 m, höchstens 0\.\d+ m\)/));
});
