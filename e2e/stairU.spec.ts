// [151] U-Treppe: mit dem Befehl setzen (Grundform-Zyklus), Treppenauge am Griff „Ende letzter Lauf“
// quer aufziehen, Rückgängig stellt das Auge wieder her. Geprüft über das Objekt-Info (Feld Treppenauge).
import { blurFocus, commandInput, expect, openTab, startNewProject, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

/** Modellpunkt (m) → Client-Pixel (wie `grid.spec.ts::screenOf`). */
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

/** Wert eines Objekt-Info-Felds (Beschriftung exakt). */
function field(page: Page, label: string) {
  return page.locator(".objinfo-field").filter({ has: page.getByText(label, { exact: true }) }).locator("input");
}

test("U-Treppe setzen, Auge per Griff ändern, Rückgängig ([151])", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await commandInput(page).focus();
  await typeCommand(page, "treppe");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Startpunkt der Treppe/);
  // Grundform: gerade → L → U
  const shape = page.locator(".cmdline-option").filter({ hasText: "Grundform" });
  await shape.dispatchEvent("mousedown");
  await shape.dispatchEvent("mousedown");
  await expect(shape).toContainText("=U");
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  // Lauf 1 nach +y, 3 m; Gegenlauf links daneben (Auge 0.1, Breite 1.0 → Achse bei x = −1.1)
  await typeCommand(page, "0,3");
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await page.getByTitle("Auf Plan einpassen").click();

  // Treppe wählen (Klick auf Lauf 1) → Objekt-Info zeigt U-Treppe mit Auge 0.100
  const onRun = await screenOf(page, 0, 1.5);
  await page.mouse.click(onRun.x, onRun.y);
  await openTab(page, "Objekt-Info");
  const gap = field(page, "Treppenauge");
  await expect(gap).toHaveValue("0.100");

  // Griff „Ende letzter Lauf“ (Mitte der Austrittskante, x = −1.1, y = 0) quer nach x = −1.4 ziehen: Auge ≈ 0.4
  await expect.poll(() => page.locator(".plan-grip").count()).toBeGreaterThan(2);
  const from = await screenOf(page, -1.1, 0);
  const to = await screenOf(page, -1.4, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);
  // (Fang kann den Zielpunkt um einige cm verschieben: Auge deutlich grösser, um 0.4)
  await expect.poll(async () => Number(await gap.inputValue())).toBeGreaterThan(0.25);
  expect(Number(await gap.inputValue())).toBeLessThan(0.5);

  // Rückgängig (der Griff-Zug kann je nach Last in zwei Schritten ankommen): bis das alte Auge wieder steht.
  await blurFocus(page);
  for (let i = 0; i < 3 && (await gap.inputValue()) !== "0.100"; i++) {
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(300);
  }
  await expect(gap).toHaveValue("0.100");
});
