// [280] Träger/Unterzug: Musterhaus (komplex) öffnen, der Unterzug im EG ist über „Alles wählen“-Kanal der Stützen
// wählbar, die Objekt-Info zeigt den Abschnitt „Träger“ (Profil, Breite, Höhe, OK-Versatz), Höhe ändern und Undo;
// ein neuer Träger über die Befehlszeile („traeger“, zwei Punkte, Zahl = Höhe). Screenshots in `test-results/`.
import { blurFocus, commandInput, discardIfAsked, expect, fileMenu, openTab, test, typeCommand } from "./app";

test("Unterzug: Objekt-Info, Höhe ändern mit Undo, Träger zeichnen ([280])", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Musterhaus \(komplex\)$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText("Musterhaus");

  await openTab(page, "Objekt-Info");
  await page.evaluate(() => window.__dossierTest!.select({ columns: ["tg-eg-1"] }));
  const info = page.locator(".objinfo-panel").first();
  await expect(info).toContainText("Träger");
  // Felder des Abschnitts „Träger“ (andere Abschnitte haben ebenfalls „Breite“/„Höhe“).
  const field = (name: string) =>
    info
      .locator(".objinfo-section-label", { hasText: /^Träger$/ })
      .locator("xpath=following-sibling::label[contains(@class,'objinfo-field')]")
      .filter({ has: page.locator(".objinfo-flabel", { hasText: new RegExp(`^${name}$`) }) })
      .locator("input");
  await expect(field("Profil")).toHaveValue("Unterzug 30/45");
  await expect(field("Breite")).toHaveValue("0.300");
  await expect(field("Höhe")).toHaveValue("0.450");
  await expect(info.locator(".objinfo-field").filter({ hasText: "Länge" })).toContainText("5.7");
  await field("Höhe").fill("0.5");
  await field("Höhe").press("Enter");
  await expect(field("Höhe")).toHaveValue("0.500");
  await page.screenshot({ path: "test-results/beam280-objektinfo.png" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(field("Höhe")).toHaveValue("0.450");

  // Neuer Träger: Befehl „traeger“, Anfang, Ende (getippte Koordinaten), Beenden; danach wählbar über die Auswahl.
  await commandInput(page).focus();
  await typeCommand(page, "traeger");
  await expect(page.locator(".cmdline-prompt")).toContainText("Anfang des Trägers");
  await typeCommand(page, "1,7");
  await expect(page.locator(".cmdline-prompt")).toContainText("Ende des Trägers");
  await typeCommand(page, "5,7");
  // Der Träger entsteht mit dem zweiten Punkt, der Befehl endet von selbst.
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  await blurFocus(page);
  expect((await page.evaluate(() => window.__dossierTest!.counts())).beams).toBe(2);
  await page.keyboard.press("ControlOrMeta+z");
  expect((await page.evaluate(() => window.__dossierTest!.counts())).beams).toBe(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect((await page.evaluate(() => window.__dossierTest!.counts())).beams).toBe(2);
  await page.screenshot({ path: "test-results/beam280-gezeichnet.png" });
});
