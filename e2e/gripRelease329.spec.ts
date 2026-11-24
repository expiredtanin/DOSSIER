// [329] Einstellung „Griffe beim Loslassen übernehmen“ (Wunsch Maintainer 24.11., Archicad/Vectorworks): ein gezogener
// Kanten-Anfasser gilt beim Loslassen; ohne Einstellung bleibt er bewaffnet bis zum nächsten Klick (wie bisher).
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


/** Rechteck 4 × 3 m, rechte Kante gewählt; liefert Anfasser-Mitte und das Ziel 1 m weiter rechts. */
async function edgeGrip(page: Page) {
  await startNewProject(page);
  await page.locator(".cmdline-input").focus();
  await typeCommand(page, "rect");
  await typeCommand(page, "0,-4");
  await typeCommand(page, "4,-1");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  await blurFocus(page);
  const onEdge = await screenOf(page, 4, -2.2);
  await page.mouse.click(onEdge.x, onEdge.y);
  await expect(widthField(page)).toHaveValue("4.000");
  await page.waitForTimeout(450);
  await page.mouse.click(onEdge.x, onEdge.y);
  const grip = page.locator(".plan-edge-grip");
  await expect(grip).toHaveCount(1);
  const box = (await grip.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const a = await screenOf(page, 4, -2.5);
  const b = await screenOf(page, 5, -2.5);
  return { from, to: { x: from.x + (b.x - a.x), y: from.y } };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("Einstellung an: gezogener Anfasser gilt beim Loslassen", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dossier.gripCommitOnRelease", "1"));
  const { from, to } = await edgeGrip(page);
  await drag(page, from, to);
  // Kein zweiter Klick: die Breite ist schon übernommen.
  await expect.poll(async () => Number(await widthField(page).inputValue())).toBeCloseTo(5, 1);
  // Die Maus weiter bewegen ändert nichts mehr (nicht bewaffnet).
  await page.mouse.move(to.x + 80, to.y, { steps: 4 });
  await page.waitForTimeout(300);
  expect(Number(await widthField(page).inputValue())).toBeCloseTo(5, 1);
});

test("Einstellung aus (Vorgabe): Anfasser bleibt nach dem Loslassen bewaffnet, Klick setzt", async ({ page }) => {
  const { from, to } = await edgeGrip(page);
  await drag(page, from, to);
  // Bewaffnet: der Anfasser folgt der Maus weiter (Objekt-Info zeigt den Live-Wert), erst der Klick setzt.
  const further = { x: to.x + (to.x - from.x), y: to.y };
  await page.mouse.move(further.x, further.y, { steps: 6 });
  await expect.poll(async () => Number(await widthField(page).inputValue())).toBeGreaterThan(5.5);
  await page.mouse.click(further.x, further.y);
  const set = Number(await widthField(page).inputValue());
  await page.mouse.move(further.x + 80, further.y, { steps: 4 });
  await page.waitForTimeout(300);
  expect(Number(await widthField(page).inputValue())).toBe(set);
});
