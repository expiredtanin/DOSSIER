// [113] Wände bearbeiten, offene Teile: eine Bogenwand mit einer Geraden verrunden (Radius getippt → tangentiale
// Bogenwand dazwischen) und zwei gerade Wände fasen (gerade Wand dazwischen); je Befehl ein Undo-Schritt.
// Geprüft am gespeicherten Projekt (Wand-Achsen).
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, fileMenu, finishCommand, openTab, startNewProject, test, typeCommand } from "./app";

/** Modellpunkt (m) → Client-Pixel (wie `dimAssoc.spec.ts`). */
async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [mx, my]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (mx * 90 - ox - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-my * 90 - oy - vy) * s,
      };
    },
    [x, y],
  );
}

async function clickModel(page: Page, x: number, y: number): Promise<void> {
  const p = await screenOf(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

type W = { start: { x: number; y: number }; end: { x: number; y: number }; bulge?: number };

/** Wände des gespeicherten Projekts (Download über „Projekt speichern"). */
async function savedWalls(page: Page): Promise<W[]> {
  await blurFocus(page);
  const pending = page.waitForEvent("download");
  await fileMenu(page, "Projekt speichern");
  const dl = await pending;
  return JSON.parse((await readFile(await dl.path())).toString("utf8")).walls as W[];
}

/** Einzelne Wände zeichnen (Muster `drawing.spec.ts`); drei Punkte = Bogenwand (Option „Bogen", Drei-Punkt). */
async function drawWalls(page: Page, walls: string[][]): Promise<void> {
  for (const pts of walls) {
    await page.getByRole("button", { name: "Wand", exact: true }).click();
    if (!(await page.locator(".cmdline-prompt").textContent())?.includes("Startpunkt")) {
      await page.getByRole("button", { name: "Wand", exact: true }).click();
    }
    await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
    await commandInput(page).focus();
    await typeCommand(page, pts[0]);
    if (pts.length === 3) await typeCommand(page, "arc");
    for (const p of pts.slice(1)) await typeCommand(page, p);
    await finishCommand(page);
  }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

test("Bogenwand mit Gerader verrunden (Radius), rückgängig", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  // Halbkreis R 5 um (0,0) oben herum, Gerade x = 3 nach oben; Schnitt (3,4).
  await drawWalls(page, [
    ["-5,0", "0,5", "5,0"],
    ["3,-2", "3,8"],
  ]);
  await expect.poll(async () => (await savedWalls(page)).filter((w) => w.bulge).length).toBe(1);
  await blurFocus(page);
  await page.getByTitle("Auf Plan einpassen").click();

  await commandInput(page).focus();
  await typeCommand(page, "fillet");
  await clickModel(page, -4, 3);
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Zweite Wand/);
  await commandInput(page).focus();
  await typeCommand(page, "1");
  await clickModel(page, 3, 7);
  const cy = Math.sqrt(32);
  await expect
    .poll(async () => {
      const ws = await savedWalls(page);
      return ws.length === 3 && ws.some((w) => near(w.start.x, 10 / 6) && near(w.start.y, (5 * cy) / 6) && near(w.end.x, 3) && near(w.end.y, cy) && !!w.bulge);
    })
    .toBe(true);

  // Ein Undo-Schritt stellt beide Wände wieder her.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedWalls(page)).map((w) => [w.end.x, w.end.y])).toEqual([
    [5, 0],
    [3, 8],
  ]);
});

test("Zwei Wände fasen (Distanz getippt), rückgängig", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await drawWalls(page, [
    ["0,0", "4,0"],
    ["6,5", "6,-2"],
  ]);
  await blurFocus(page);
  await page.getByTitle("Auf Plan einpassen").click();

  await commandInput(page).focus();
  await typeCommand(page, "chamfer");
  await clickModel(page, 2, 0);
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Zweite Wand/);
  await commandInput(page).focus();
  await typeCommand(page, "1");
  await clickModel(page, 6, 3);
  await expect
    .poll(async () => (await savedWalls(page)).map((w) => [w.start.x, w.start.y, w.end.x, w.end.y]))
    .toEqual([
      [0, 0, 5, 0],
      [6, 5, 6, 1],
      [5, 0, 6, 1],
    ]);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedWalls(page)).map((w) => [w.start.x, w.start.y, w.end.x, w.end.y])).toEqual([
    [0, 0, 4, 0],
    [6, 5, 6, -2],
  ]);
});
