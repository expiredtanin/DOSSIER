// [272] Varianten: Beispiel Varianten öffnen, Panel „Varianten“ über den Chip der Statusleiste, Satz anlegen, Auswahl einer
// Variante zuweisen (Undo), Kombination der Ansicht umschalten (Grundriss zeigt das Bandfenster statt des Lochfensters),
// Vergleichstabelle, Variante übernehmen und Undo. Geprüft über die UI und den Plan (Test-Nähte), nicht über Pixel.
import { blurFocus, discardIfAsked, expect, fileMenu, test } from "./app";

test("Varianten: Satz, Zuweisen, Kombination, Vergleich, Übernehmen, Undo ([272])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Varianten$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Beispiel Varianten");
  const dopt = () => page.evaluate(() => window.__dossierTest!.designOptions());
  const openings = () => page.evaluate(() => window.__dossierTest!.planOpeningIds());
  // Hauptvarianten: Lochfenster O2, kein Bandfenster.
  await expect.poll(openings).toContain("O2");
  expect(await openings()).not.toContain("O-band");

  // Chip der Statusleiste öffnet das Panel.
  const chip = page.getByTestId("design-option-toggle");
  await expect(chip).toContainText("Hauptvarianten");
  await chip.click();
  const panel = page.getByTestId("design-options-panel");
  await expect(panel).toBeVisible();

  // Neuer Satz.
  await panel.getByTestId("rm-design-option-set-name").fill("Grundriss OG");
  await panel.getByTestId("rm-design-option-set-add").click();
  await expect.poll(async () => (await dopt()).sets).toEqual(["dachform", "fassade", "satz-3"]);

  // Wand W1 der Variante „Fassade: B Bandfenster“ zuweisen; Undo in einem Schritt.
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1"] }));
  await panel.getByTestId("design-option-target").selectOption("fassade/b");
  await panel.getByTestId("design-option-assign").click();
  await expect.poll(async () => (await dopt()).elements.W1).toBe("fassade/b");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await dopt()).elements.W1).toBe("");

  // Kombination der Ansicht: Fassade B → Bandfenster statt Lochfenster; der Chip nennt die Abweichung.
  await panel.getByTestId("design-option-combo-fassade").selectOption("b");
  await expect.poll(async () => (await dopt()).level).toEqual({ fassade: "b" });
  await expect.poll(openings).toContain("O-band");
  expect(await openings()).not.toContain("O2");
  await expect(chip).toContainText("Fassade B Bandfenster");

  // Vergleich: vier Kombinationen, Hauptkombination zuerst.
  await panel.getByTestId("design-option-compare-open").click();
  const rows = panel.getByTestId("design-option-compare-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("Dachform A Flachdach, Fassade A Lochfenster");
  await page.screenshot({ path: "test-results/designOptions272-panel.png" });
  await rows.last().scrollIntoViewIfNeeded();
  await panel.screenshot({ path: "test-results/designOptions272-compare.png" });

  // Variante übernehmen (Dachform B): Satz weg; Undo bringt ihn zurück.
  const dach = panel.getByTestId("rm-design-option-set").first();
  await dach.getByTestId("rm-design-option-accept").nth(1).click();
  await expect.poll(async () => (await dopt()).sets).toEqual(["fassade", "satz-3"]);
  expect((await dopt()).elements.RF1).toBe("");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await dopt()).sets).toEqual(["dachform", "fassade", "satz-3"]);
  expect((await dopt()).elements.RF1).toBe("dachform/b");
});
