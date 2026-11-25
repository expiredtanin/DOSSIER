// [332] Eigenes Gelände aus gezeichneten Höhenlinien (Wunsch Maintainer 25.11.): Splines zeichnen, im Panel „Gelände"
// „Höhenlinien zeichnen", Linien anklicken und ihre Höhe tippen (die dritte per Enter mit dem Vorschlag), dann
// „Gelände erzeugen". Eigener Port: E2E_PORT=5193 npx playwright test e2e/contourLine332.spec.ts
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, openTab, startNewProject, test, typeCommand } from "./app";
import type {} from "../src/state/testHooks";

test.use({ viewport: { width: 1600, height: 1000 } });

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

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const contours = (page: Page) =>
  page.evaluate(() => window.__dossierTest!.context().filter((c) => c.type === "contourSet").length);

test("Höhenlinien zeichnen: Splines anklicken, Höhe tippen, Gelände erzeugen", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page, "?dossierTest");
  // Drei Splines (Hang nach Süden), abseits des neuen Projekts (Schnittlinien beim Ursprung).
  for (const y of [0, 6, 12]) {
    await commandInput(page).focus();
    await typeCommand(page, "sp");
    for (const p of [`30,${y}`, `40,${y + 1}`, `50,${y}`]) await typeCommand(page, p);
    await commandInput(page).press("Enter");
    await expect(prompt(page)).toHaveText("Befehl:");
  }
  await blurFocus(page);
  await page.locator('[title="Auf Plan einpassen"]').first().click();
  await page.waitForTimeout(600);

  await openTab(page, "Gelände");
  await page.getByRole("button", { name: "Höhenlinien zeichnen" }).click();
  await expect(prompt(page)).toHaveText("Linie für die Höhenlinie wählen (Enter: fertig):");
  await clickModel(page, 40, 1);
  await expect(prompt(page)).toHaveText(/^Höhe/);
  await commandInput(page).focus();
  await typeCommand(page, "500");
  await expect(prompt(page)).toHaveText(/^Linie für die Höhenlinie/);
  await expect.poll(() => contours(page)).toBe(1);
  await clickModel(page, 40, 7);
  await commandInput(page).focus();
  await typeCommand(page, "501");
  await clickModel(page, 40, 13);
  await expect(prompt(page)).toHaveText(/^Höhe/);
  // Enter: Vorschlag 502 (letzte Höhe + Äquidistanz); nochmals Enter: fertig.
  await commandInput(page).press("Enter");
  await expect(prompt(page)).toHaveText(/^Linie für die Höhenlinie/);
  await commandInput(page).press("Enter");
  await expect(prompt(page)).toHaveText("Befehl:");
  await expect(page.locator(".toast-message").filter({ hasText: "Höhenlinien übernommen" })).toBeVisible();

  // Gelände erzeugen (Panel) → Geländenetz in der Kontext-Schicht.
  await page.getByRole("button", { name: "Gelände erzeugen" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__dossierTest!.context().map((c) => c.type)))
    .toEqual(expect.arrayContaining(["contourSet", "terrainMesh"]));
  await page.screenshot({ path: "test-results/contourLine332.png" });
});
