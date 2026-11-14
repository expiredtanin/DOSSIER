// [123] Bewegen/Drehen/Spiegeln laufen als gewöhnliche Befehle der Engine — Werkzeug-Knopf,
// getippter Befehl und Taste (m/s/d) münden in denselben Befehl. Geprüft: Prompts, Kopiermodus
// (U/I/O/P, kein Schritt für Esc), Esc = ein Punkt zurück, Esc-Esc = Abbruch, Enter = Punkt an der
// letzten Mausposition, getippter Winkel, ohne Auswahl kein Start.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, finishCommand, openTab, test, typeCommand } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const lines = (page: Page) => page.evaluate(() => window.__dossierTest!.lines());
const round = (v: number) => Math.round(v * 1000) / 1000;
const ends = async (page: Page) =>
  (await lines(page)).map((l) => [round(l.a.x), round(l.a.y), round(l.b.x), round(l.b.y)]);

/** Modellpunkt (m) → Client-Pixel (wie `grid.spec.ts::screenOf`). */
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

async function selectAll(page: Page) {
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+a");
}

test("Bewegen, Drehen, Spiegeln über Knopf, getippten Befehl und Taste; Esc/Enter", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openTab(page, "Elemente");

  // Eine Linie (0,0)–(2,0).
  await commandInput(page).focus();
  await typeCommand(page, "line");
  await typeCommand(page, "0,0");
  await typeCommand(page, "2,0");
  await finishCommand(page);
  expect(await ends(page)).toEqual([[0, 0, 2, 0]]);

  // Ohne Auswahl: kein Start, Hinweis.
  await page.getByRole("button", { name: "Drehen", exact: true }).click();
  await expect(page.getByText("Erst Objekte wählen, dann drehen.")).toBeVisible();
  await expect(prompt(page)).toHaveText("Befehl:");

  // Bewegen über den Werkzeug-Knopf: Basis (0,0) → Ziel (1,1).
  await selectAll(page);
  await page.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  await expect(page.locator(".cmdline-option.active")).toHaveText(/Bewegen/);
  await typeCommand(page, "0,0");
  await expect(prompt(page)).toHaveText("Zielpunkt klicken");
  await typeCommand(page, "1,1");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await ends(page)).toEqual([[1, 1, 3, 1]]);

  // Drehen als getippter Befehl: Zentrum (1,1), Bezug (2,1), getippter Winkel 90°.
  await typeCommand(page, "drehen");
  await expect(prompt(page)).toHaveText("Drehzentrum klicken");
  await typeCommand(page, "1,1");
  await expect(prompt(page)).toHaveText("Bezugspunkt (Startwinkel) klicken");
  await typeCommand(page, "2,1");
  await expect(prompt(page)).toHaveText("Zielwinkel klicken");
  await typeCommand(page, "90");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await ends(page)).toEqual([[1, 1, 1, 3]]);

  // Spiegeln über die Taste „s": Kopie ist Vorgabe (wie AutoCAD/Rhino); Esc nimmt nur den Punkt zurück, der Modus bleibt.
  await blurFocus(page);
  await page.keyboard.press("s");
  await expect(prompt(page)).toHaveText("Erster Punkt der Spiegelachse");
  await expect(page.locator(".cmdline-option.active")).toHaveText(/Kopie/);
  await expect(page.locator(".cmdline-option.active")).toHaveText(/Kopie/);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await expect(prompt(page)).toHaveText("Zweiter Punkt der Spiegelachse");
  await commandInput(page).press("Escape");
  await expect(prompt(page)).toHaveText("Erster Punkt der Spiegelachse");
  await expect(page.locator(".cmdline-option.active")).toHaveText(/Kopie/);
  await typeCommand(page, "0,0");
  await typeCommand(page, "0,1");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect((await ends(page)).sort()).toEqual([[-1, 1, -1, 3], [1, 1, 1, 3]]);

  // Esc-Esc schnell (Fokus auf der Zeichenfläche) bricht ab: nichts geändert.
  await selectAll(page);
  await page.keyboard.press("m");
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  await typeCommand(page, "0,0");
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await lines(page)).toHaveLength(2);

  // Enter = Punkt an der letzten Mausposition: Kopie (Taste I im Befehlsfeld) nach rechts.
  // Neu wählen: je nach Timing beendet schon das erste Esc den Befehl, dann hebt das zweite die Auswahl auf — und
  // zwar verzögert (setTimeout, [204]). Erst warten, bis das geschehen ist, sonst leert es die neue Auswahl wieder.
  await page.waitForTimeout(50);
  await selectAll(page);
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.selected().drawings)).length).toBe(2);
  await page.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(prompt(page)).toHaveText("Basispunkt klicken");
  await commandInput(page).press("i");
  await typeCommand(page, "0,0");
  const p = await screenOf(page, 4, 0);
  await page.mouse.move(p.x - 2, p.y);
  await page.mouse.move(p.x, p.y);
  await blurFocus(page);
  // Mausposition muss beim Befehl angekommen sein (Zeigerereignis läuft über rAF), sonst nimmt Enter den alten Punkt.
  // Unter Last reichen feste 200 ms nicht: zwei Animationsbilder abwarten, damit der rAF-Zeigerpfad gelaufen ist.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toHaveText("Befehl:");
  expect(await lines(page)).toHaveLength(4);
});
