// [193] Kontext-Elemente mit der Maus bearbeiten (Mac-Befund: Baugrube/Höhenlinien liessen sich nur über den Befehl
// „Verschieben" versetzen, Höhenlinien-Punkte gar nicht): Baugrube anklicken und im Plan ziehen → verschoben, ein Undo-Schritt;
// Höhenlinien-Satz wählen, einen Punkt per Griff ziehen → ein Undo-Schritt.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, elementRows, expect, fileMenu, openTab, showSnapshot, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

async function modelToClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").first().evaluate(
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
}

const ctx = (page: Page) => page.evaluate(() => window.__dossierTest!.context());
const objInfo = (page: Page) => page.locator(".objinfo-panel").first();
const firstOf = async (page: Page, type: string) => (await ctx(page)).find((c) => c.type === type)!.first!;

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

test("Musterhaus komplex: Baugrube anklicken und mit der Maus ziehen, Rückgängig", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await showSnapshot(page, "EG 1:100");
  await openTab(page, "Objekt-Info");
  // Klick in die Südwest-Böschung der Baugrube (ausserhalb der Sohle, weg von Wänden und Griffen).
  const at = await modelToClient(page, -1.6, 4);
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.mouse.click(at.x, at.y);
    await expect(objInfo(page)).toContainText("Baugrube", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  const p0 = await firstOf(page, "excavation");
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y - 20, { steps: 8 });
  await page.mouse.move(at.x + 60, at.y - 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await firstOf(page, "excavation")).x).toBeGreaterThan(p0.x + 0.2);
  const p1 = await firstOf(page, "excavation");
  expect(p1.y).toBeGreaterThan(p0.y + 0.1);
  // Es bleibt ein Element, nur verschoben.
  expect((await ctx(page)).filter((c) => c.type === "excavation")).toHaveLength(1);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await firstOf(page, "excavation")).toEqual(p0);
});

test("Musterhaus komplex: Höhenlinien-Punkt per Griff ziehen, ein Undo-Schritt", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await showSnapshot(page, "Situation 1:500");
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "Höhenlinien (Vermessung)" }).first().click();
  const grips = page.locator(".plan-grip:not(.plan-grip-insert)");
  await expect.poll(() => grips.count(), { timeout: 30_000 }).toBeGreaterThan(20);

  const p0 = await firstOf(page, "contourSet");
  const g = await modelToClient(page, p0.x, p0.y);
  // Ein Griff bleibt nach dem Loslassen „bewaffnet" und folgt dem Zeiger, bis ein Klick ihn setzt.
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + 10, g.y - 6, { steps: 6 });
  await page.mouse.up();
  await page.mouse.click(g.x + 10, g.y - 6);
  await expect.poll(async () => (await firstOf(page, "contourSet")).x).not.toBe(p0.x);
  const p1 = await firstOf(page, "contourSet");

  // Ein Undo-Schritt für den ganzen Zug.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await firstOf(page, "contourSet")).toEqual(p0);
  expect(p1).not.toEqual(p0);
});
