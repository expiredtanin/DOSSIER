// [144] Türen/Fenster verschieben: allein gewählt gleitet eine Öffnung beim Verschieben (Befehl,
// getippte Distanz) entlang ihrer Wand; Objekt-Info setzt die Lage exakt (ab Wandanfang/-ende);
// Griff-Zug mit getippter Länge (Tab) schiebt um genau diese Strecke entlang der Wand.
// Musterhaus: Tür D1 in W1 (0,0)–(5,0), position 0.8, Breite 0.9.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, openSample, openTab, test, typeCommand } from "./app";
import type {} from "../src/state/testHooks";

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const door = async (page: Page) =>
  (await page.evaluate(() => window.__dossierTest!.openings())).find((o) => o.id === "D1")!;
const pos = async (page: Page) => Math.round((await door(page)).position * 1000) / 1000;

/** Modellpunkt (m) → Client-Pixel (wie `transform.spec.ts::screenOf`). */
async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [mx, my]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (mx * 90 - ox - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-my * 90 - oy - vy) * s,
      };
    },
    [x, y],
  );
}

async function selectDoor(page: Page) {
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["D1"] }));
}

test("Tür verschieben: Befehl mit getippter Distanz, Rückgängig, Objekt-Info", async ({ page }) => {
  await page.goto("/?dossierTest");
  await openSample(page);
  expect(await door(page)).toMatchObject({ hostWallId: "W1", position: 0.8 });

  // Verschieben (Knopf) mit getippter relativer Koordinate: 0.5 m entlang der Wand.
  await selectDoor(page);
  await page.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  await typeCommand(page, "1.25,0");
  await expect(prompt(page)).toHaveText("Zielpunkt klicken");
  await typeCommand(page, "@0.5,0");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await pos(page)).toBe(1.3);
  expect((await door(page)).hostWallId).toBe("W1");

  // Rückgängig stellt die Lage wieder her.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => pos(page)).toBe(0.8);

  // Taste „m" + Zielpunkt per Klick: die Tür folgt dem Klick entlang der Wand (quer egal).
  await selectDoor(page);
  await page.keyboard.press("m");
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  const a = await screenOf(page, 1.25, 0);
  const b = await screenOf(page, 1.75, 0.05);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.click(b.x, b.y);
  await expect(prompt(page)).toHaveText("Befehl:");
  await expect.poll(async () => Math.abs((await pos(page)) - 1.3) < 0.05).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => pos(page)).toBe(0.8);

  // Objekt-Info: Lage ab Wandanfang und ab Wandende exakt setzen (geklemmt in der Wand).
  await selectDoor(page);
  await openTab(page, "Objekt-Info");
  const field = (label: string) =>
    page.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: label }) }).locator("input");
  await expect(field("Abstand ab Wandende")).toHaveValue("3.30");
  await field("Abstand ab Wandende").fill("1");
  await field("Abstand ab Wandende").press("Enter");
  await expect.poll(() => pos(page)).toBe(3.1);
  await field("Position (ab Wandanfang)").fill("2");
  await field("Position (ab Wandanfang)").press("Enter");
  await expect.poll(() => pos(page)).toBe(2);
  await field("Position (ab Wandanfang)").fill("99");
  await field("Position (ab Wandanfang)").press("Enter");
  await expect.poll(() => pos(page)).toBe(4.1);
  await expect(commandInput(page)).toBeVisible();
});

test("Tür: Griff ziehen mit getippter Länge entlang der Wand", async ({ page }) => {
  await page.goto("/?dossierTest");
  await openSample(page);
  await selectDoor(page);
  await expect(page.locator(".plan-grip")).toHaveCount(1);
  // Griff (Mitte 1.25) greifen, nach rechts ziehen, Tab → Längenfeld, 0.5 tippen, Enter bestätigen.
  const from = await screenOf(page, 1.25, 0);
  const to = await screenOf(page, 1.6, 0.3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Tab");
  await typeCommand(page, "0.5");
  await commandInput(page).press("Enter");
  await expect.poll(() => pos(page)).toBe(1.3);
});
