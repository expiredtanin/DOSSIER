// [193] Mac-Befund (Musterhaus komplex): Cmd+A nahm Gelände/Höhenlinien/Baugrube nicht mit, nach Cmd+A + Entf blieb eine
// Fläche im Grundriss stehen, die Baugrube liess sich nicht anwählen/verschieben, das Gelände nicht anpassen.
// Geprüft wie ein Nutzer: Cmd+A → Entf (ein Undo-Schritt, im Grundriss bleibt keine gefüllte Fläche), Baugrube anklicken
// (Objekt-Info), Baugrube mit „Verschieben" versetzen und rückgängig machen, Gelände-Höhenversatz.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, showSnapshot, test, typeCommand } from "./app";
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

const ctx = (page: Page) => page.evaluate(() => window.__dossierTest!.context());
const fills = (page: Page) => page.evaluate(() => window.__dossierTest!.planFills());
const objInfo = (page: Page) => page.locator(".objinfo-panel").first();

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

test("Musterhaus komplex: Cmd+A + Entf nimmt Gelände und Baugrube mit, nichts Gefülltes bleibt, ein Undo-Schritt", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await showSnapshot(page, "EG 1:100");
  // Die Klasse „02 Gelände" ist in diesem Ausschnitt ausgeblendet: Cmd+A nimmt nur Sichtbares mit — erst einblenden.
  await openTab(page, "Ebenen");
  await page.getByRole("button", { name: /^Gelände sichtbar$/ }).click();
  await openTab(page, "Objekt-Info");
  const before = await ctx(page);
  expect(before.map((c) => c.type)).toEqual(expect.arrayContaining(["terrainMesh", "contourSet", "excavation"]));
  expect(await fills(page)).toBeGreaterThan(0);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // Gelände, Baugrube weg; die Höhenlinien (Klasse „14", im Ausschnitt ausgeblendet) bleiben — Cmd+A nimmt nur Sichtbares mit.
  expect((await ctx(page)).map((c) => c.type)).toEqual(["contourSet"]);
  await expect.poll(() => fills(page)).toBe(0);

  // Ein Undo-Schritt bringt alles zurück.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  expect((await ctx(page)).length).toBe(before.length);
  await expect.poll(() => fills(page)).toBeGreaterThan(0);
});

test("Musterhaus komplex: Baugrube anklicken, mit Verschieben versetzen, Rückgängig; Höhenversatz am Gelände", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await showSnapshot(page, "EG 1:100");
  await openTab(page, "Objekt-Info");

  // Klick in die Südwest-Böschung der Baugrube (ausserhalb der Sohle, weg von Wänden).
  await expect(async () => {
    await page.keyboard.press("Escape");
    await clickModel(page, -1.6, 4);
    await expect(objInfo(page)).toContainText("Baugrube", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  const first = async () => (await ctx(page)).find((c) => c.type === "excavation")!.first!;
  const p0 = await first();
  await blurFocus(page);
  await page.keyboard.press("m");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Basispunkt klicken");
  await typeCommand(page, "0,0");
  await typeCommand(page, "2,3");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  const p1 = await first();
  expect(Math.round((p1.x - p0.x) * 1000) / 1000).toBe(2);
  expect(Math.round((p1.y - p0.y) * 1000) / 1000).toBe(3);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await first()).toEqual(p0);
});

test("Musterhaus komplex: Gelände anwählen und Höhenversatz mit Undo", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await showSnapshot(page, "Situation 1:500");
  await openTab(page, "Objekt-Info");
  const offset = objInfo(page).getByTestId("context-height-offset");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await clickModel(page, -12, -10);
    await expect(offset).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const zOf = () => page.evaluate(() => window.__dossierTest!.terrainZ());
  const z0 = await zOf();
  await offset.fill("0.5");
  await offset.press("Enter");
  await expect.poll(async () => Math.round(((await zOf()) - z0) * 1000) / 1000).toBe(0.5);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.round(((await zOf()) - z0) * 1000) / 1000).toBe(0);
});
