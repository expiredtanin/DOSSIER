// [279] Geländer als eigenes Bauteil: im Musterhaus mit dem Befehl „gelaender" zwei Punkte setzen (Befehlszeile),
// im Plan anklicken (Pick-Fläche aus dem Kern), in der Objekt-Info Art und Höhe ändern, rückgängig machen, löschen.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, finishCommand, openSample, openTab, startNewProject, test, typeCommand } from "./app";

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

test("Geländer zeichnen, wählen, Höhe und Art ändern, Undo, Löschen", async ({ page }) => {
  test.setTimeout(90_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");

  await commandInput(page).focus();
  await typeCommand(page, "gelaender");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Erster Punkt des Geländers (Zahl = Höhe in m):");
  await typeCommand(page, "3,5");
  await typeCommand(page, "7,5");
  await finishCommand(page);
  await blurFocus(page);

  const objInfo = page.locator(".objinfo-panel").first();
  const field = (name: string) =>
    objInfo.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  const height = field("Höhe");
  await expect(async () => {
    await page.keyboard.press("Escape");
    // Auf die Mitte der Achse klicken (Pick-Fläche um die Achse, mindestens 4 mm Papier breit).
    await clickModel(page, 5, 5);
    await expect(height).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(objInfo).toContainText("Geländer");
  await expect(height).toHaveValue("1.000");
  // Länge aus dem Kern: 4.00 m.
  await expect(page.getByTestId("railing-length")).toHaveText("4.00 m");
  await height.fill("1.1");
  await height.press("Enter");
  await expect(height).toHaveValue("1.100");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(height).toHaveValue("1.000");
  // Löschen mit Entf: die Auswahl (und das Geländer) ist weg.
  await page.keyboard.press("Delete");
  await expect(height).toBeHidden();
});
