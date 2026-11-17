// [276] Darstellung der Schnitt-/Ansichtslinie: in der Objekt-Info Linie (durchgehend / nur Enden / keine), Marke
// (Pfeil / L / Dreieck / keine) wählen; Mehrfachauswahl ändert alle gewählten Linien in einem Undo-Schritt.
// Eigener Port: E2E_PORT=5197 npx playwright test e2e/sectionLook276.spec.ts
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, finishCommand, startNewProject, test, typeCommand } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [mx, my]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return { x: r.left + (r.width - vw * s) / 2 + (mx * 90 - ox - vx) * s, y: r.top + (r.height - vh * s) / 2 + (-my * 90 - oy - vy) * s };
    },
    [x, y],
  );
}

async function drawSection(page: Page, a: string, b: string): Promise<void> {
  await commandInput(page).focus();
  await typeCommand(page, "schnittlinie");
  await typeCommand(page, a);
  await typeCommand(page, b);
  await finishCommand(page);
  await blurFocus(page);
}

const name = (page: Page) => page.getByTitle("Name", { exact: true }).first();
const isOn = (page: Page, id: string) => expect(page.getByTestId(`look-${id}`).first()).toHaveAttribute("aria-pressed", "true");

test("Schnittlinie: Linie und Marke wählen, Mehrfachauswahl ändert beide, ein Undo", async ({ page }) => {
  await startNewProject(page);
  await drawSection(page, "0,0", "10,0");
  await drawSection(page, "0,6", "10,6");
  await page.locator('[title="Auf Plan einpassen"]').first().click();

  // Erste Linie wählen (kräftiges Endstück am Anfang): Basis = durchgehend + Pfeil.
  const p1 = await screenOf(page, 0.9, 0);
  await page.mouse.click(p1.x, p1.y);
  await expect(page.getByTestId("look-ends")).toBeVisible();
  await isOn(page, "full");
  await isOn(page, "arrow");

  // Nur Enden + L.
  await page.getByTestId("look-ends").click();
  await page.getByTestId("look-lAngle").click();
  await isOn(page, "ends");
  await isOn(page, "lAngle");
  // Marke an: nur Anfang.
  await page.getByTestId("look-start").click();
  await isOn(page, "start");
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/objektinfo-schnittlinie.png` });

  // Beide Linien wählen (Umschalt): eine Änderung trifft beide.
  const p2 = await screenOf(page, 0.9, 6);
  await page.keyboard.down("Shift");
  await page.mouse.click(p2.x, p2.y);
  await page.keyboard.up("Shift");
  await page.getByTestId("look-triangle").click();

  // Einzeln prüfen: beide zeigen Dreieck.
  await blurFocus(page);
  await page.mouse.click(p2.x, p2.y);
  await expect(name(page)).toHaveValue(/C$/);
  await isOn(page, "triangle");
  await page.waitForTimeout(600);
  await page.mouse.click(p1.x, p1.y);
  await expect(name(page)).toHaveValue(/B$/);
  await isOn(page, "triangle");

  // Ein Undo nimmt die Mehrfachänderung für beide zurück (Linie 1 wieder L, Linie 2 wieder Pfeil).
  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await page.mouse.click(p1.x, p1.y);
  await expect(name(page)).toHaveValue(/B$/);
  await isOn(page, "lAngle");
  await page.waitForTimeout(600);
  await page.mouse.click(p2.x, p2.y);
  await expect(name(page)).toHaveValue(/C$/);
  await isOn(page, "arrow");
});
