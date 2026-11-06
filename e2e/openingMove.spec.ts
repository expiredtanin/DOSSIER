// [144] Türen/Fenster verschieben: allein gewählt gleitet eine Öffnung beim Verschieben (Befehl,
// getippte Distanz) entlang ihrer Wand; Objekt-Info setzt die Lage exakt (ab Wandanfang/-ende);
// Griff-Zug mit getippter Länge (Tab) schiebt um genau diese Strecke entlang der Wand.
// Musterhaus: Tür D1 in W1 (0,0)–(5,0), position 0.8, Breite 0.9; Fenster O1 in W1 bei 3.0–4.0.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, discardIfAsked, expect, fileMenu, openSample, openTab, test, typeCommand } from "./app";
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

async function open(page: Page) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);
}

async function selectDoor(page: Page) {
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["D1"] }));
}

test("Tür verschieben: Befehl mit getippter Distanz, Rückgängig, Objekt-Info", async ({ page }) => {
  await open(page);
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

  // Taste „m" + Zielpunkt per Klick (0.5 m zurück, leicht quer): die Tür folgt entlang der Wand.
  // (0.25 m fing beim eingepassten Zoom der Fang am Basispunkt.)
  await selectDoor(page);
  await page.keyboard.press("m");
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  const a = await screenOf(page, 1.25, 0);
  const b = await screenOf(page, 0.75, 0.05);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.click(b.x, b.y);
  await expect(prompt(page)).toHaveText("Befehl:");
  await expect.poll(async () => Math.abs((await pos(page)) - 0.3) < 0.05).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => pos(page)).toBe(0.8);

  // Objekt-Info: Lage ab Wandanfang und ab Wandende exakt setzen (geklemmt in der Wand und 5 cm vor
  // dem Fenster O1: 3.0 − 0.05 − 0.9 = 2.05, mit Hinweis).
  await selectDoor(page);
  await openTab(page, "Objekt-Info");
  const field = (label: string) =>
    page.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: label }) }).locator("input");
  await expect(field("Abstand ab Wandende")).toHaveValue("3.300");
  await field("Abstand ab Wandende").fill("1");
  await field("Abstand ab Wandende").press("Enter");
  await expect.poll(() => pos(page)).toBe(2.05);
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.notices())).some((n) => n.includes("Nachbaröffnung"))).toBe(true);
  await field("Position (ab Wandanfang)").fill("2");
  await field("Position (ab Wandanfang)").press("Enter");
  await expect.poll(() => pos(page)).toBe(2);
  // Bezugspunkt X (Mitte der Tür, 2.45) um −1 m: Verschieben entlang der Wand.
  await expect(field("X")).toHaveValue("2.450");
  await field("X").fill("1.45");
  await field("X").press("Enter");
  await expect.poll(() => pos(page)).toBe(1);
  await expect(commandInput(page)).toBeVisible();
});

test("Tür: Griff ziehen mit getippter Länge entlang der Wand", async ({ page }) => {
  await open(page);
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

// [144] Musterhaus komplex: Bemassung „mass-fenster-eg" hängt an den Leibungen von eg-f1 (Wand eg-aw-s,
// Lage 1.6, Breite 1.8) und folgt; Erker-Bogenwand eg-aw-erker (Halbkreis r = 2, Länge 2π) mit f5 bei 1.2 und
// f6 bei 3.6 (je 1 m): Abstand ab Wandende = Bogenlänge, Anschlag an der Nachbaröffnung mit Hinweis.
test("Musterhaus komplex: Bemassung folgt, Bogenwand, Nachbaröffnung", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  const posOf = async (id: string) =>
    Math.round((await page.evaluate(() => window.__dossierTest!.openings())).find((o) => o.id === id)!.position * 1000) / 1000;
  const dimX = async () => Math.round((await page.evaluate(() => window.__dossierTest!.dimPts("mass-fenster-eg")))[0].x * 1000) / 1000;
  const x0 = await dimX();

  // Befehl: eg-f1 um 0.5 m entlang der Wand → erste Leibung der Kette ebenso.
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["eg-f1"] }));
  await page.getByRole("button", { name: "Verschieben", exact: true }).click();
  await typeCommand(page, "0,0");
  await typeCommand(page, "@0.5,0");
  await expect(prompt(page)).toHaveText("Befehl:");
  await expect.poll(() => posOf("eg-f1")).toBe(2.1);
  await expect.poll(dimX).toBe(Math.round((x0 + 0.5) * 1000) / 1000);
  // Objekt-Info-Position: Kette folgt ebenfalls.
  await openTab(page, "Objekt-Info");
  const field = (label: string) =>
    page.locator("label.objinfo-field").filter({ has: page.locator(".objinfo-flabel", { hasText: label }) }).locator("input");
  await field("Position (ab Wandanfang)").fill("1");
  await field("Position (ab Wandanfang)").press("Enter");
  await expect.poll(() => posOf("eg-f1")).toBe(1);
  await expect.poll(dimX).toBe(Math.round((x0 - 0.6) * 1000) / 1000);

  // Bogenwand: Abstand ab Wandende aus der Bogenlänge, Anschlag vor f6 (3.6 − 0.05 − 1 = 2.55) mit Hinweis.
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["eg-f5"] }));
  await expect(field("Abstand ab Wandende")).toHaveValue((2 * Math.PI - 2.2).toFixed(3));
  await field("Position (ab Wandanfang)").fill("3");
  await field("Position (ab Wandanfang)").press("Enter");
  await expect.poll(() => posOf("eg-f5")).toBe(2.55);
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.notices())).some((n) => n.includes("Nachbaröffnung"))).toBe(true);
  // Verschieben-Befehl an einer Bogenwand: f6 (Mitte bei Bogenlänge 4.1, Winkel ≈ 27.5°) um 0.5 m entlang
  // der Tangente → Lotfuss auf dem Bogen, Lage ≈ 4.1.
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["eg-f6"] }));
  await page.getByRole("button", { name: "Verschieben", exact: true }).click();
  await typeCommand(page, "17,5");
  await typeCommand(page, "@-0.231,0.443");
  await expect(prompt(page)).toHaveText("Befehl:");
  await expect.poll(async () => Math.abs((await posOf("eg-f6")) - 4.1) < 0.03).toBe(true);
  expect((await page.evaluate(() => window.__dossierTest!.openings())).find((o) => o.id === "eg-f6")!.hostWallId).toBe("eg-aw-erker");
});
