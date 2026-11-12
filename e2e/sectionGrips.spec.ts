// [187] Höhen-Griffe im Schnitt: angewählte Decken, Wände und Fenster haben im Schnitt Fasspunkte (Archicad-Art).
// Musterhaus komplex, Schnitt A-A (x = 3): Decke EG → OK-Griff (Höhenlage) und UK-Griff (Dicke), Fenster eg-f1 →
// Brüstung und Sturz, Wand eg-aw-s → Ober-/Unterkante; je Zug ein Undo-Schritt; Tab tippt die Kote.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, showSnapshot, test } from "./app";
import type {} from "../src/state/testHooks";

test.use({ viewport: { width: 1600, height: 1000 } });

const heights = (page: Page) => page.evaluate(() => window.__dossierTest!.heights());
const ceiling = async (page: Page, id: string) => (await heights(page)).ceilings.find((c) => c.id === id)!;
const opening = async (page: Page, id: string) => (await heights(page)).openings.find((o) => o.id === id)!;
const wall = async (page: Page, id: string) => (await heights(page)).walls.find((w) => w.id === id)!;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Griffe lesen, sobald sie ruhen: nach Undo rechnet der Schnitt asynchron neu, bis dahin stehen sie an alter Stelle. */
async function gripCentres(page: Page): Promise<{ x: number; y: number }[]> {
  const read = async () =>
    (
      await page.locator(".plan-grip").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }),
      )
    ).sort((a, b) => a.x - b.x || a.y - b.y);
  let prev = JSON.stringify(await read());
  let same = 0;
  for (let i = 0; i < 60 && same < 6; i++) {
    await page.waitForTimeout(300);
    const cur = JSON.stringify(await read());
    same = cur === prev ? same + 1 : 0;
    prev = cur;
  }
  return JSON.parse(prev);
}

/** Griff ziehen: er bleibt nach dem Loslassen bewaffnet und folgt dem Zeiger, bis ein Klick ihn setzt. */
async function dragGrip(page: Page, from: { x: number; y: number }, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.mouse.click(from.x, from.y + dy);
}

/** Rückgängig; der Schnitt rechnet danach asynchron neu, bis dahin stehen die Griffe an alter Stelle. */
async function undo(page: Page) {
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(4000);
}

async function select(page: Page, patch: Record<string, string[]>) {
  await blurFocus(page);
  // setSelection mischt: die anderen Arten leeren, sonst bleibt z. B. das Fenster gewählt
  await page.evaluate((p) => window.__dossierTest!.select({ walls: [], openings: [], ceilings: [], roofs: [], stairs: [], contextObjects: [], ...p }), patch);
}

test("Schnitt A-A: Decke, Fenster und Wand haben Höhen-Griffe, Zug = ein Undo-Schritt", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, "Schnitt A-A");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);

  // Decke EG: zwei Griffe nebeneinander (OK links, UK rechts).
  const c0 = await ceiling(page, "c-eg");
  await select(page, { ceilings: ["c-eg"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [ok, uk] = await gripCentres(page);
  expect(ok.x).toBeLessThan(uk.x);

  // OK nach oben: Höhenlage ändert sich, die Dicke bleibt (ohne UK-Bindung wandert die Platte).
  await dragGrip(page, ok, -30);
  const c1 = await ceiling(page, "c-eg");
  expect(c1.zTop).toBeGreaterThan(c0.zTop + 0.05);
  expect(r3(c1.thickness)).toBe(r3(c0.thickness));
  await undo(page);
  await expect.poll(async () => (await ceiling(page, "c-eg")).zTop).toBe(c0.zTop);

  // UK nach unten: die Decke wird dicker, die OK bleibt; ein Undo-Schritt stellt alles her.
  await select(page, { ceilings: ["c-eg"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [, uk2] = await gripCentres(page);
  await dragGrip(page, uk2, 25);
  const c2 = await ceiling(page, "c-eg");
  expect(c2.thickness).toBeGreaterThan(c0.thickness + 0.03);
  expect(c2.zTop).toBe(c0.zTop);
  await undo(page);
  await expect.poll(async () => r3((await ceiling(page, "c-eg")).thickness)).toBe(r3(c0.thickness));
  expect((await ceiling(page, "c-eg")).zTop).toBe(c0.zTop);

  // Fenster eg-f1 (x 1.6–3.4, vom Schnitt getroffen): Sturz und Brüstung.
  const f0 = await opening(page, "eg-f1");
  await select(page, { openings: ["eg-f1"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [top, bottom] = (await gripCentres(page)).sort((a, b) => a.y - b.y);
  await dragGrip(page, top, -20);
  expect((await opening(page, "eg-f1")).height).toBeGreaterThan(f0.height + 0.05);
  await undo(page);
  await expect.poll(async () => (await opening(page, "eg-f1")).height).toBe(f0.height);
  await select(page, { openings: ["eg-f1"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [, bottom2] = (await gripCentres(page)).sort((a, b) => a.y - b.y);
  await dragGrip(page, bottom2, 20);
  const f1 = await opening(page, "eg-f1");
  expect(f1.sillHeight).toBeLessThan(f0.sillHeight - 0.05);
  // Oberkante bleibt: Brüstung + Höhe unverändert.
  expect(r3(f1.sillHeight + f1.height)).toBe(r3(f0.sillHeight + f0.height));
  await undo(page);
  await expect.poll(async () => (await opening(page, "eg-f1")).sillHeight).toBe(f0.sillHeight);
  void bottom;

  // Wand eg-aw-s: Oberkante und Unterkante.
  const w0 = await wall(page, "eg-aw-s");
  await select(page, { walls: ["eg-aw-s"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [wt, wb] = (await gripCentres(page)).sort((a, b) => a.y - b.y);
  await dragGrip(page, wt, -45);
  expect((await wall(page, "eg-aw-s")).zTop).toBeGreaterThan(w0.zTop + 0.05);
  await undo(page);
  await expect.poll(async () => (await wall(page, "eg-aw-s")).zTop).toBe(w0.zTop);
  await select(page, { walls: ["eg-aw-s"] });
  const [, wb2] = (await gripCentres(page)).sort((a, b) => a.y - b.y);
  await dragGrip(page, wb2, 20);
  const w1 = await wall(page, "eg-aw-s");
  expect(w1.zBottom).toBeLessThan(w0.zBottom - 0.05);
  expect(r3(w1.zTop)).toBe(r3(w0.zTop)); // Oberkante bleibt
  await undo(page);
  await expect.poll(async () => (await wall(page, "eg-aw-s")).zBottom).toBe(w0.zBottom);
  void wb;
});

test("Schnitt A-A: Tab tippt die Kote der Decken-Oberkante", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, "Schnitt A-A");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);

  const c0 = await ceiling(page, "c-eg");
  await select(page, { ceilings: ["c-eg"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [ok] = await gripCentres(page);
  await page.mouse.move(ok.x, ok.y);
  await page.mouse.down();
  await page.mouse.move(ok.x, ok.y - 15, { steps: 5 });
  await page.mouse.up();
  // Tab friert die Kote ein und öffnet das Feld „Kote“; die getippte Zahl setzt die Oberkante exakt.
  await page.keyboard.press("Tab");
  const target = r3(c0.zTop + 0.4);
  await page.keyboard.type(String(target));
  await page.keyboard.press("Enter");
  await page.mouse.click(ok.x, ok.y - 15);
  await expect.poll(async () => r3((await ceiling(page, "c-eg")).zTop)).toBe(target);
  await undo(page);
  await expect.poll(async () => (await ceiling(page, "c-eg")).zTop).toBe(c0.zTop);
});

// [187] Teil 2: Dach (Traufe, First), Treppe (Austritt) und Gelände (Sohle der Baugrube) im Schnitt.
async function openSheet(page: Page, name: string) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, name);
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
}
const roofOf = async (page: Page, id: string) => (await heights(page)).roofs.find((r) => r.id === id)!;

test("Schnitt A-A: Dach-Traufe und First ziehen, Zug = ein Undo-Schritt", async ({ page }) => {
  test.setTimeout(180_000);
  await openSheet(page, "Schnitt A-A");
  const r0 = await roofOf(page, "dach-haupt");
  await select(page, { roofs: ["dach-haupt"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [eave, ridge] = await gripCentres(page);
  expect(eave.x).toBeLessThan(ridge.x);

  // Traufe nach oben: das ganze Dach wandert, die Neigung bleibt.
  await dragGrip(page, eave, -30);
  const r1 = await roofOf(page, "dach-haupt");
  expect(r1.eave).toBeGreaterThan(r0.eave + 0.05);
  expect(r1.pitchDeg).toBe(r0.pitchDeg);
  await undo(page);
  await expect.poll(async () => (await roofOf(page, "dach-haupt")).eave).toBe(r0.eave);

  // First nach oben: die Neigung wächst, die Traufe bleibt.
  await select(page, { roofs: ["dach-haupt"] });
  await expect(page.locator(".plan-grip")).toHaveCount(2);
  const [, ridge2] = await gripCentres(page);
  await dragGrip(page, ridge2, -30);
  const r2 = await roofOf(page, "dach-haupt");
  expect(r2.pitchDeg).toBeGreaterThan(r0.pitchDeg + 0.5);
  expect(r2.eave).toBe(r0.eave);
  await undo(page);
  await expect.poll(async () => (await roofOf(page, "dach-haupt")).pitchDeg).toBe(r0.pitchDeg);
});

test("Schnitt B-B: Treppen-Austritt ziehen", async ({ page }) => {
  test.setTimeout(180_000);
  await openSheet(page, "Schnitt B-B");
  const stair = async () => (await heights(page)).stairs.find((s) => s.id === "tr-kern")!;
  const s0 = await stair();
  await select(page, { stairs: ["tr-kern"] });
  await expect(page.locator(".plan-grip")).toHaveCount(1);
  const [g] = await gripCentres(page);
  await dragGrip(page, g, -30);
  expect((await stair()).totalRise).toBeGreaterThan(s0.totalRise + 0.02);
  await undo(page);
  await expect.poll(async () => (await stair()).totalRise).toBe(s0.totalRise);
});

test("Schnitt A-A: Sohle der Baugrube ziehen", async ({ page }) => {
  test.setTimeout(180_000);
  await openSheet(page, "Schnitt A-A");
  const pit = async () => (await heights(page)).excavations.find((e) => e.id === "baugrube")!;
  const b0 = await pit();
  await select(page, { contextObjects: ["baugrube"] });
  await expect(page.locator(".plan-grip")).toHaveCount(1);
  const [g] = await gripCentres(page);
  await dragGrip(page, g, 30);
  expect((await pit()).bottom).toBeLessThan(b0.bottom - 0.05);
  await undo(page);
  await expect.poll(async () => (await pit()).bottom).toBe(b0.bottom);
});
