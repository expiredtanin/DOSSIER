// [113] Wände bearbeiten: zwei Wände zeichnen, die eine an der anderen stutzen (T-Stoss), eine teilen,
// rückgängig machen. Geprüft am gespeicherten Projekt (Wand-Achsen).
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

type W = { start: { x: number; y: number }; end: { x: number; y: number } };

/** Wände des gespeicherten Projekts (Download über „Projekt speichern"). */
async function savedWalls(page: Page): Promise<W[]> {
  await blurFocus(page);
  const pending = page.waitForEvent("download");
  await fileMenu(page, "Projekt speichern");
  const dl = await pending;
  return JSON.parse((await readFile(await dl.path())).toString("utf8")).walls as W[];
}

async function drawWall(page: Page, a: string, b: string): Promise<void> {
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, a);
  await typeCommand(page, b);
  await finishCommand(page);
}

test("Wand an Querwand stutzen, teilen, rückgängig", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await drawWall(page, "0,0", "10,0");
  await drawWall(page, "6,-3", "6,3");
  await blurFocus(page);
  await page.getByTitle("Auf Plan einpassen").click();

  // Stutzen: Klick auf den Überstand rechts der Querwand.
  await commandInput(page).focus();
  await typeCommand(page, "trim");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/wegschneiden/);
  await clickModel(page, 8.5, 0);
  await commandInput(page).press("Enter");
  await expect.poll(async () => (await savedWalls(page)).some((w) => Math.abs(w.end.x - 6) < 1e-6 && Math.abs(w.start.x) < 1e-6)).toBe(true);

  // Teilen am Punkt x = 3.
  await commandInput(page).focus();
  await typeCommand(page, "split");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Teilstelle/);
  await clickModel(page, 3, 0);
  await commandInput(page).press("Enter");
  await expect.poll(async () => (await savedWalls(page)).length).toBe(3);

  // Rückgängig: ein Schritt je Befehl.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedWalls(page)).length).toBe(2);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedWalls(page)).some((w) => Math.abs(w.end.x - 10) < 1e-6)).toBe(true);
});
