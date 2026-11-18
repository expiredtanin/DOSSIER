// [288] Kantenauswahl (Vectorworks-Arbeitsweise): der Anfasser zum Parallelverschieben erscheint erst, wenn eine Kante
// des gewählten Elements mit einem zweiten Klick gewählt ist; Esc hebt nur die Kantenauswahl auf. Anfasser ziehen
// verschiebt die Kante, Rückgängig stellt sie her. Bildschirm-Punkte wie in kataster.spec.ts (`screenOf`).
import type { Page } from "@playwright/test";
import { blurFocus, expect, startNewProject, test, typeCommand } from "./app";

async function screenOf(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [x, y]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s,
      };
    },
    [dx, dy],
  );
}

const widthField = (page: Page) => page.locator(".objinfo-field").filter({ hasText: "Breite" }).locator("input");

test("Kante wählen → parallel verschieben → Rückgängig ([288])", async ({ page }) => {
  await startNewProject(page);
  // Rechteck 4 × 3 m unterhalb der Schnittlinie des leeren Projekts.
  await page.locator(".cmdline-input").focus();
  await typeCommand(page, "rect");
  await typeCommand(page, "0,-4");
  await typeCommand(page, "4,-1");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  await blurFocus(page);

  // Erster Klick auf die rechte Kante wählt das Rechteck: Eckgriffe, aber kein Kanten-Anfasser.
  const onEdge = await screenOf(page, 4, -2.2);
  await page.mouse.click(onEdge.x, onEdge.y);
  await expect(widthField(page)).toHaveValue("4.000");
  await expect(page.locator(".plan-grip").first()).toBeVisible();
  await expect(page.locator(".plan-edge-grip")).toHaveCount(0);

  // Zweiter Klick auf dieselbe Kante: Kante hervorgehoben, genau ein Anfasser.
  await page.waitForTimeout(450); // kein Doppelklick
  await page.mouse.click(onEdge.x, onEdge.y);
  await expect(page.locator(".plan-edge-selected")).toHaveCount(1);
  await expect(page.locator(".plan-edge-grip")).toHaveCount(1);

  // Esc hebt nur die Kantenauswahl auf, das Rechteck bleibt gewählt.
  await page.keyboard.press("Escape");
  await expect(page.locator(".plan-edge-grip")).toHaveCount(0);
  await expect(widthField(page)).toHaveValue("4.000");

  // Erneut wählen und den Anfasser 1 m nach rechts ziehen (bleibt nach dem Loslassen bewaffnet, Klick setzt).
  await page.waitForTimeout(450);
  await page.mouse.click(onEdge.x, onEdge.y);
  const grip = page.locator(".plan-edge-grip");
  await expect(grip).toHaveCount(1);
  const box = (await grip.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const a = await screenOf(page, 4, -2.5);
  const b = await screenOf(page, 5, -2.5);
  const to = { x: from.x + (b.x - a.x), y: from.y };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);
  await expect.poll(async () => Number(await widthField(page).inputValue())).toBeCloseTo(5, 1);

  // Ein Undo-Schritt stellt die Breite her.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(widthField(page)).toHaveValue("4.000");
});
