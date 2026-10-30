// [38] Assoziative Bemassung: Wand zeichnen, ihre Länge mit Fang bemassen, Wand am Anfangsgriff strecken →
// die Masszahl folgt.
import { blurFocus, commandInput, expect, finishCommand, openTab, startNewProject, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

/** Modellpunkt (m) → Client-Pixel (wie `kataster.spec.ts::screenOf`). */
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

/** Zahlen-Texte des Plans (Masszahlen). */
const numbers = (page: Page) =>
  page.locator("svg.plan-svg text").evaluateAll((els) => els.map((e) => e.textContent ?? "").filter((s) => /^\d+\.\d\d$/.test(s)));

test("Bemassung an Wandenden folgt dem Strecken der Wand per Griff", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await blurFocus(page);
  await page.getByTitle("Auf Plan einpassen").click();

  // Bemassung: beide Wandenden mit der Maus anklicken (Endpunkt-Fang), Abstand 1 m.
  await commandInput(page).focus();
  await typeCommand(page, "dim");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Erster Punkt/);
  await clickModel(page, 0, 0);
  await clickModel(page, 5, 0);
  await commandInput(page).press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Lage der Masslinie/);
  await typeCommand(page, "1");
  await expect.poll(() => numbers(page)).toContain("5.00");

  // Wand wählen, Anfangsgriff 0.5 m nach links ziehen (Griff folgt bis zum zweiten Klick).
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await clickModel(page, 2.5, 0);
  await expect.poll(() => page.locator(".plan-grip").count()).toBeGreaterThan(1);
  const from = await screenOf(page, 0, 0);
  const to = await screenOf(page, -0.5, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);

  await expect.poll(() => numbers(page)).not.toContain("5.00");
  const after = (await numbers(page)).map(Number);
  expect(after.some((v) => Math.abs(v - 5.5) < 0.05)).toBe(true);

  // Rückgängig: Wand und Masszahl zurück (ein Schritt).
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => numbers(page)).toContain("5.00");
});
