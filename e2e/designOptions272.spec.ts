// [272] Varianten: Beispiel Varianten öffnen, Panel „Varianten“ über den Chip der Statusleiste, Satz anlegen, Auswahl einer
// Variante zuweisen (Undo), Kombination der Ansicht umschalten (Grundriss zeigt das Bandfenster statt des Lochfensters),
// Vergleichstabelle, Variante übernehmen und Undo. Geprüft über die UI und den Plan (Test-Nähte), nicht über Pixel.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, test } from "./app";

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
  // Die Hauptvarianten entsprechen der gespeicherten Kombination „Studie 1“: ihr Name steht im Chip.
  await expect(chip).toContainText("Studie 1 Flachdach/Lochfenster");
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

  // Vergleich: je gespeicherte Kombination eine Zeile (Name als Titel), „alle“ zeigt das Kreuzprodukt (2 × 2 × 2).
  await panel.getByTestId("design-option-compare-open").click();
  const rows = panel.getByTestId("design-option-compare-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Studie 1 Flachdach/Lochfenster");
  await panel.getByTestId("design-option-compare-all").check();
  await expect(rows).toHaveCount(8);
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

test("Variantenkombinationen: speichern, zuweisen, umschalten, Vergleich, Löschen, Undo ([272])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Varianten$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Beispiel Varianten");
  const dopt = () => page.evaluate(() => window.__dossierTest!.designOptions());
  const openings = () => page.evaluate(() => window.__dossierTest!.planOpeningIds());
  const chip = page.getByTestId("design-option-toggle");
  await chip.click();
  const panel = page.getByTestId("design-options-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("design-option-combination")).toHaveCount(2);
  await expect(panel.getByTestId("design-option-current-name")).toHaveText("Studie 1 Flachdach/Lochfenster");

  // Eine Wahl, die zu keiner Kombination passt, heisst „Eigene“ und wird unter neuem Namen gespeichert.
  await panel.getByTestId("design-option-combo-dachform").selectOption("b");
  await expect(panel.getByTestId("design-option-current-name")).toHaveText("Eigene");
  await expect(chip).toContainText("Eigene");
  await panel.getByTestId("design-option-combo-save").click();
  const dialog = page.getByRole("dialog", { name: /Als Kombination speichern/ });
  await dialog.getByLabel("Name der Kombination").fill("Studie 3 Satteldach/Lochfenster");
  await dialog.getByRole("button", { name: "Exportieren" }).click();
  await expect.poll(async () => (await dopt()).combinations).toEqual(["Studie 1 Flachdach/Lochfenster", "Studie 2 Satteldach/Bandfenster", "Studie 3 Satteldach/Lochfenster"]);
  await expect(panel.getByTestId("design-option-current-name")).toHaveText("Studie 3 Satteldach/Lochfenster");

  // Zuweisen: Studie 2 ⇒ Bandfenster; Chip nennt den Namen; Studie 1 ⇒ wieder das Lochfenster.
  const comb = (n: number) => panel.getByTestId("design-option-combination").nth(n);
  await comb(1).getByTestId("design-option-combination-assign").click();
  await expect.poll(async () => (await dopt()).combination).toBe("studie-2");
  await expect.poll(openings).toContain("O-band");
  expect(await openings()).not.toContain("O2");
  await expect(chip).toContainText("Studie 2 Satteldach/Bandfenster");
  await comb(0).getByTestId("design-option-combination-assign").click();
  await expect.poll(async () => (await dopt()).combination).toBe("studie-1");
  await expect.poll(openings).toContain("O2");
  // Undo schaltet zurück auf Studie 2.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await dopt()).combination).toBe("studie-2");
  await expect.poll(openings).toContain("O-band");

  // Abnahmebild (1280 × 800): Panel mit den Kombinationen, Studie 2 der Ansicht zugewiesen.
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await panel.getByText("Kombinationen", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/04-kombinationen.png` });
  }

  // Wahl je Satz in einer Kombination ändern: Studie 2 mit Fassade A ⇒ Lochfenster.
  await comb(1).getByTestId("design-option-combination-studie-2-fassade").selectOption("a");
  await expect.poll(openings).toContain("O2");

  // Vergleich je Kombination.
  await panel.getByTestId("design-option-compare-open").click();
  const rows = panel.getByTestId("design-option-compare-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("Studie 3 Satteldach/Lochfenster");
  await panel.screenshot({ path: "test-results/designOptions272-kombinationen.png" });

  // Löschen: Overlay-Dialog, danach Undo (ein Schritt, Verweis der Ansicht kommt mit zurück).
  await comb(1).getByTestId("design-option-combination-delete").click();
  await page.getByTestId("confirm-dialog-ok").click();
  await expect.poll(async () => (await dopt()).combinations.length).toBe(2);
  await expect.poll(async () => (await dopt()).combination).toBe(null);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await dopt()).combinations.length).toBe(3);
  await expect.poll(async () => (await dopt()).combination).toBe("studie-2");
});

test("Variantenvergleich als Blatt-Tabelle ([272])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Varianten$/);
  await discardIfAsked(page);
  await openNewLayoutInFolder(page);
  await page.locator("[data-table-add]").selectOption({ label: "Variantenvergleich" });
  await expect(page.locator("[data-table-id]")).toHaveCount(1);
  const texts = await page.locator("[data-table-id] text").allTextContents();
  expect(texts).toContain("Studie 1 Flachdach/Lochfenster");
  expect(texts).toContain("Studie 2 Satteldach/Bandfenster");
  expect(texts).toContain("Kombination");
});

/** Layout in einem neuen Ordner anlegen und öffnen (wie `sheetTable.spec.ts`). */
async function openNewLayoutInFolder(page: Page) {
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Ordner erstellen" }).first().click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-label", { hasText: "Neuer Ordner" }).click();
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
}

test("Panel Varianten im Dock: Reiter, Namen inline umbenennen, Löschen mit Rückfrage ([272])", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Varianten$/);
  await discardIfAsked(page);
  const dopt = () => page.evaluate(() => window.__dossierTest!.designOptions());
  // Standardmässig ein Reiter der rechten oberen Dock-Gruppe (neben Umbau), nicht schwebend.
  const tab = page.getByRole("tab", { name: "Varianten", exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  const panel = page.getByTestId("design-options-panel");
  await expect(panel).toBeVisible();
  const dock = page.getByRole("complementary").filter({ has: page.getByRole("tab", { name: "Umbau", exact: true }) });
  await expect(dock.getByTestId("design-options-panel")).toBeVisible();

  // Kombination per Doppelklick umbenennen: Esc verwirft, Enter übernimmt.
  const name = panel.getByTestId("design-option-combination-name").first();
  await name.dblclick();
  const field = panel.getByTestId("design-option-combination-name-input");
  await field.fill("Verworfen");
  await field.press("Escape");
  expect((await dopt()).combinations[0]).toBe("Studie 1 Flachdach/Lochfenster");
  await panel.getByTestId("design-option-combination-name-edit").first().click();
  await panel.getByTestId("design-option-combination-name-input").fill("Studie A");
  await panel.getByTestId("design-option-combination-name-input").press("Enter");
  await expect.poll(async () => (await dopt()).combinations[0]).toBe("Studie A");

  // Satz löschen: erst Rückfrage, Abbrechen ändert nichts, Bestätigen löscht.
  await panel.getByTestId("rm-design-option-set-delete").first().click();
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect((await dopt()).sets).toEqual(["dachform", "fassade"]);
  await panel.getByTestId("rm-design-option-set-delete").first().click();
  await page.getByTestId("confirm-dialog-ok").click();
  await expect.poll(async () => (await dopt()).sets).toEqual(["fassade"]);
});
