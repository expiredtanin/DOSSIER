// [293] Wand-Oberkante als EINE Auswahl (Objekt-Info): beide Felder in einer Op, ein Undo-Schritt.
// Prüfbild: doc/review-293/oberkante.png (Objekt-Info der Wand mit Auswahl „Oberkante“).
import { blurFocus, discardIfAsked, expect, fileMenu, test } from "./app";

test("Wand: Oberkante Auswahl setzt roofAttach/ceilingAttach zusammen, Undo in einem Schritt ([293])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText("Wettbewerb");
  const wallId = await page.evaluate(() => window.__dossierTest!.walls()[0].id);
  const tops = () => page.evaluate((id) => window.__dossierTest!.wallTops()[id], wallId);
  await page.evaluate((id) => window.__dossierTest!.select({ walls: [id] }), wallId);
  const field = page.locator(".objinfo-field").filter({ hasText: "Oberkante" }).first();
  await expect(field).toBeVisible();
  const pick = async (name: string) => {
    await field.getByRole("button").first().click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  expect(await tops()).toBeUndefined();
  await pick("Bis Decke/Dach (tiefere)");
  await expect.poll(tops).toEqual({ roofAttach: undefined, ceilingAttach: true });
  await pick("Bis Decke");
  await expect.poll(tops).toEqual({ roofAttach: false, ceilingAttach: true });
  await pick("Bis Dach");
  await expect.poll(tops).toEqual({ roofAttach: true, ceilingAttach: undefined });
  // Ein Undo-Schritt macht die letzte Auswahl rückgängig (beide Felder zusammen).
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(tops).toEqual({ roofAttach: false, ceilingAttach: true });
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.waitForTimeout(800);
  const box = (await field.boundingBox())!;
  const x = Math.max(0, box.x - 40);
  // Nicht ins Repo schreiben (sonst ändert jeder e2e-Lauf das Prüfbild): Kopie nach test-results.
  await page.screenshot({ path: "test-results/review-293-oberkante.png", clip: { x, y: Math.max(0, box.y - 240), width: 420, height: 460 } });
});
