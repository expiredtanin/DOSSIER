// [195] Fenster „Objekteinstellungen" (Taste T): Bereiche Objekt/Darstellung, live mit Undo, Mehrfachauswahl.
// Mit DOSSIER_SHOTS=<ordner> entsteht ein Screenshot für die Abnahme.
import { blurFocus, elementRows, expect, openSample, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

test.use({ deviceScaleFactor: 2 });

test("Wand → T → Bereiche Objekt/Darstellung, Strichstärke live, Undo ([195])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
  await blurFocus(page);
  await page.keyboard.press("t");

  const win = page.locator(".objset-panel");
  await expect(win).toBeVisible();
  await expect(win.getByRole("tab", { name: "Objekt" })).toHaveAttribute("aria-selected", "true");
  await expect(win.locator('[data-group="wall"]')).toBeVisible();

  await win.getByRole("tab", { name: "Darstellung" }).click();
  await expect(win.getByText("Strichstärke (mm)", { exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.__dossierTest!.wallWeights());
  const weight = win.locator(".attr-num").first();
  await weight.fill("0.7");
  await expect.poll(() => page.evaluate(() => Object.values(window.__dossierTest!.wallWeights()))).toContain(0.7);

  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await win.screenshot({ path: `${shots}/objekteinstellungen-darstellung.png` });

  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.wallWeights())).toEqual(before);

  // Das Fenster bleibt offen und folgt der Auswahl: leer → „Keine Auswahl".
  await expect(win).toBeVisible();
  await page.evaluate(() => window.__dossierTest!.select({ walls: [], drawings: [] }));
  await expect(win.getByText("Keine Auswahl")).toBeVisible();
});

test("Mehrfachauswahl: eine Änderung gilt für alle, abweichende Werte erscheinen leer ([195])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);
  const ids = await page.evaluate(() => window.__dossierTest!.heights().walls.slice(0, 2).map((w) => w.id));
  await page.evaluate((w) => window.__dossierTest!.select({ walls: [w[0]] }), ids);
  await blurFocus(page);
  await page.keyboard.press("t");
  const win = page.locator(".objset-panel");
  await win.getByRole("tab", { name: "Darstellung" }).click();
  await win.locator(".attr-num").first().fill("0.5");
  await expect.poll(() => page.evaluate(() => Object.keys(window.__dossierTest!.wallWeights()).length)).toBe(1);

  // Beide Wände: 0.5 gegen Standard → gemischt, Feld leer.
  await page.evaluate((w) => window.__dossierTest!.select({ walls: w }), ids);
  const field = win.locator(".attr-num").first();
  await expect(field).toHaveValue("");
  await field.fill("0.35");
  await expect
    .poll(() => page.evaluate(() => Object.values(window.__dossierTest!.wallWeights())))
    .toEqual([0.35, 0.35]);
  await expect(field).toHaveValue("0.35");

  // Ein Undo-Schritt macht beide Wände zurück.
  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.evaluate(() => Object.values(window.__dossierTest!.wallWeights()))).toEqual([0.5]);
});
