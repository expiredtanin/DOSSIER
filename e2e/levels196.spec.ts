// [196] Musterhaus komplex (Mac-Befund): (1) der Bodenbelag im EG-Grundriss gehört der Decke über dem UG — nach Cmd+A + Entf
// bleibt er stehen, muss aber anwählbar (Pick liefert die Decke des anderen Geschosses) und mit Entf löschbar sein;
// (2) das Auge einer Ansicht in „Nur aktive" blendet nicht alle Geschosse ein; (3) Auge eines Geschosses aus → fehlt im 3D.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, showSnapshot, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

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

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

const finish = (page: Page) => page.evaluate(() => window.__dossierTest!.planLines("floor-finish-pattern"));
const v3d = (page: Page) => page.evaluate(() => window.__dossierTest!.view3d());
const nav = (page: Page, name: string) => page.locator(".nav-row").filter({ hasText: name }).first();
const eye = (page: Page, name: string) => nav(page, name).getByRole("button", { name: "Sichtbarkeit" });

test("EG-Bodenbelag der UG-Decke: nach Cmd+A + Entf anwählbar (Decke eines anderen Geschosses) und löschbar", async ({ page }) => {
  test.setTimeout(150_000);
  await openComplex(page);
  await showSnapshot(page, "EG 1:50 Ausschnitt Wohnen");
  expect(await finish(page)).toBeGreaterThan(0);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // Der Belag gehört der Decke des UG (nicht im Geschoss gewählt): bleibt stehen.
  expect(await finish(page)).toBeGreaterThan(0);

  // Klick in die Fläche: Pick liefert die Decke des anderen Geschosses, Entf löscht sie samt Belag.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await clickModel(page, 4, 2);
    const sel = JSON.parse((await page.evaluate(() => window.__dossierTest!.selected())).all);
    expect(sel.ceilings).toContain("c-ug");
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Delete");
  await expect.poll(() => finish(page)).toBe(0);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => finish(page)).toBeGreaterThan(0);
});

test("Zeichnungsebenen: Auge einer Ansicht in „Nur aktive“ schaltet nur sie; Auge eines Geschosses aus → fehlt im 3D", async ({ page }) => {
  test.setTimeout(150_000);
  await openComplex(page);
  await openTab(page, "Zeichnungsebenen");
  await nav(page, "Erdgeschoss").click();
  const all = await v3d(page);
  expect(all.floors).toEqual(expect.arrayContaining(["eg", "og", "dg"]));

  // „Nur aktive": 3D zeigt nur das aktive Geschoss; Klick aufs Auge einer Ansicht darf nichts einblenden.
  await page.locator(".panel-vis .display-mode").first().click();
  await page.getByRole("option", { name: "Nur aktive" }).click();
  await expect.poll(async () => (await v3d(page)).floors).toEqual(["eg"]);
  await eye(page, "Ansicht Süd").click();
  await page.waitForTimeout(300);
  expect((await v3d(page)).floors).toEqual(["eg"]);

  // Modus „Ausgewählte" (Flags gelten): Obergeschoss einblenden, dann Auge aus → OG fehlt im 3D, Pick ebenso.
  await eye(page, "Obergeschoss").click();
  await expect.poll(async () => (await v3d(page)).floors).toEqual(["eg", "og"]);
  await eye(page, "Obergeschoss").click();
  await expect.poll(async () => (await v3d(page)).floors).toEqual(["eg"]);
  const off = await v3d(page);
  expect(off.walls.length).toBeGreaterThan(3);
  expect(off.pickWalls).toEqual(off.walls);
});
