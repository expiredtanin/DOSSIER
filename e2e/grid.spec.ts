// [112]/[38] Achsraster: anlegen (Ursprung + Feldweiten), zwischen zwei Achsen bemassen, Achse am Griff
// verschieben → die Bemassung folgt; Rückgängig stellt beides her.
import { blurFocus, commandInput, expect, openTab, startNewProject, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

/** Modellpunkt (m) → Client-Pixel (wie `dimAssoc.spec.ts::screenOf`). */
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

const numbers = (page: Page) =>
  page.locator("svg.plan-svg text").evaluateAll((els) => els.map((e) => e.textContent ?? "").filter((s) => /^\d+\.\d\d$/.test(s)));

const labels = (page: Page) => page.locator("svg.plan-svg text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

test("Achsraster anlegen, zwischen zwei Achsen bemassen, Achse verschieben → Mass folgt", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await commandInput(page).focus();
  await typeCommand(page, "achsraster");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Ursprung des Achsrasters/);
  await typeCommand(page, "0,0");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Feldweiten Achsen 1, 2, 3/);
  await typeCommand(page, "6 6");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Feldweiten Achsen A, B, C/);
  await typeCommand(page, "5");
  await blurFocus(page);
  await page.getByTitle("Auf Plan einpassen").click();
  // Beschriftungen in den Blasen: 1, 2, 3 und A, B (je an beiden Enden).
  await expect.poll(() => labels(page)).toEqual(expect.arrayContaining(["1", "2", "3", "A", "B"]));

  // Bemassung der Achsen 1 und 2 (Achsschnittpunkte A/1 und A/2), Abstand 1 m unter dem Raster.
  await commandInput(page).focus();
  await typeCommand(page, "dim");
  await clickModel(page, 0, 0);
  await clickModel(page, 6, 0);
  await commandInput(page).press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Lage der Masslinie/);
  await typeCommand(page, "-1");
  await expect.poll(() => numbers(page)).toContain("6.00");

  // Raster wählen (Klick auf Achse 2), Achsgriff am Achsende nach rechts ziehen: Achse 2 von x = 6 auf 7.5.
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await clickModel(page, 6, 2.5);
  await expect.poll(() => page.locator(".plan-grip").count()).toBeGreaterThan(2);
  const from = await screenOf(page, 6, 6.5);
  const to = await screenOf(page, 7.5, 6.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);

  await expect.poll(async () => (await numbers(page)).some((v) => Math.abs(Number(v) - 7.5) < 0.1)).toBe(true);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => numbers(page)).toContain("6.00");
});
