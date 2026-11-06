// [149] Baum als eigenes Objekt: im Musterhaus mit dem Werkzeug „Baum" einen Baum setzen (Befehlszeile),
// im Plan anklicken (Kronenfläche, Pick im Kern), in der Objekt-Info die Höhe ändern und rückgängig machen.
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

test("Baum setzen, Höhe ändern, Undo", async ({ page }) => {
  test.setTimeout(90_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");

  await commandInput(page).focus();
  await typeCommand(page, "baum");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Baum setzen (Zahl = Kronendurchmesser):");
  await typeCommand(page, "6");
  await typeCommand(page, "4,-6");
  await finishCommand(page);
  await blurFocus(page);

  const objInfo = page.locator(".objinfo-panel").first();
  const field = (name: string) =>
    objInfo.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  const height = field("Höhe");
  await expect(async () => {
    await page.keyboard.press("Escape");
    // Neben der Stammmitte in die Krone klicken (Kronenradius 3 m).
    await clickModel(page, 5, -6);
    await expect(height).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(objInfo).toContainText("Baum");
  await expect(field("Kronen-Ø")).toHaveValue("6.000");
  await expect(height).toHaveValue("10.000");
  await height.fill("15");
  await height.press("Enter");
  await expect(height).toHaveValue("15.000");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(height).toHaveValue("10.000");
  // Löschen mit Entf: die Auswahl (und der Baum) ist weg.
  await page.keyboard.press("Delete");
  await expect(height).toBeHidden();
});
