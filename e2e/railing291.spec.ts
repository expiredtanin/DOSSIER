// [291] Geländer an der Treppe: im Musterhaus mit „gelaender“ und der Option „an Treppe/Kante“ auf die Treppe ST1 klicken
// (Kern bindet an die nächste Wange), das Geländer im Plan wählen, Bindung und Felder in der Objekt-Info sehen,
// Pfostenabstand ändern, rückgängig machen und lösen.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, openSample, openTab, startNewProject, test, typeCommand } from "./app";

async function clickModel(page: Page, x: number, y: number): Promise<void> {
  const p = await page.locator("svg.plan-svg").first().evaluate(
    (el, [x, y]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return { x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s, y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s };
    },
    [x, y],
  );
  await page.mouse.click(p.x, p.y);
}

test("Geländer an Treppe binden, Felder ändern, lösen", async ({ page }) => {
  test.setTimeout(90_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");

  await commandInput(page).focus();
  await typeCommand(page, "gelaender");
  const bind = page.locator(".cmdline-option").filter({ hasText: "an Treppe/Kante" });
  await bind.click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Treppe (Wange) oder Deckenkante anklicken:");
  await commandInput(page).focus();
  // Treppe ST1: x 3.2–4.2, Lauf in +y; der Klick nahe x = 3.3 trifft die linke Wange.
  await typeCommand(page, "3.3,1.2");
  await blurFocus(page);
  // Option zurücksetzen (gilt über Aufrufe hinweg), damit spätere Befehle frei zeichnen.
  await commandInput(page).focus();
  await typeCommand(page, "gelaender");
  await page.locator(".cmdline-option").filter({ hasText: "an Treppe/Kante" }).click();
  await page.keyboard.press("Escape");
  await blurFocus(page);

  const objInfo = page.locator(".objinfo-panel").first();
  await expect(async () => {
    await page.keyboard.press("Escape");
    // Achse auf der Wange unter der Schnitthöhe (Pick-Fläche um die Achse).
    await clickModel(page, 3.24, 1.0);
    await expect(page.getByTestId("railing-bound")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("railing-bound")).toHaveText("ST1");
  const fields = page.getByTestId("railing-fields");
  const before = Number(await fields.textContent());
  expect(before).toBeGreaterThan(0);
  const spacing = objInfo.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: /^Pfostenabstand \(max\.\)$/ }) }).locator("input");
  await spacing.fill("0.5");
  await spacing.press("Enter");
  await expect(async () => expect(Number(await fields.textContent())).toBeGreaterThan(before)).toPass({ timeout: 10_000 });
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(fields).toHaveText(String(before));
  // Lösen: die Achse bleibt als freie Polylinie, die Bindung ist weg.
  await page.getByTestId("railing-unbind").click();
  await expect(page.getByTestId("railing-bound")).toBeHidden();
  await expect(page.getByTestId("railing-length")).toBeVisible();
});
