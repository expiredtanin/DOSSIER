// Ansichtsvorlagen ([34]): Vorlage mit ausgeblendeter Kategorie anlegen, mit der aktiven Ansicht
// verknüpfen (Kategorie verschwindet), die Vorlage ändern (Ansicht folgt), duplizieren und löschen.
// Geprüft über sichtbare UI (Ebenen-Panel, Ressourcen-Tab) — nicht über Pixel.
import { expect, openSample, openTab, startNewProject, test } from "./app";

test("Ansichtsvorlage: Kategorie ausblenden, anwenden, Vorlage ändern, Ansicht folgt ([34])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  // Ressourcen-Fenster → Tab „Ansichtsvorlagen" (schliesst über dem Dock liegend, daher je Mal öffnen/schliessen).
  const openResources = async () => {
    await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
    await page.getByRole("option", { name: /Ressourcen/ }).click();
    await page.getByRole("tab", { name: "Ansichtsvorlagen" }).click();
  };
  const closeResources = () => page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();
  await openResources();
  await page.getByTestId("view-template-add").click();
  await expect(page.getByTestId("view-template-row")).toHaveCount(1);

  // Kategorie „Wände" (20) in der Vorlage ausblenden, dann mit der aktiven Ansicht verknüpfen.
  const wallsCat = page.getByTestId("view-template-categories").getByRole("combobox", { name: /^20 / });
  await wallsCat.selectOption("hide");
  await page.getByTestId("view-template-apply-linked").click();
  await expect(page.getByTestId("view-template-row")).toContainText("1 verknüpft");

  // Ebenen-Panel: Wände sind ausgeblendet (Schalter bietet „Einblenden").
  await closeResources();
  await openTab(page, "Ebenen");
  const walls = page.getByRole("button", { name: /^Wände sichtbar$/ });
  await expect(walls).toHaveAttribute("title", "Einblenden");

  // Vorlage ändern: Wände wieder sichtbar → die verknüpfte Ansicht folgt.
  await openResources();
  await wallsCat.selectOption("show");
  await closeResources();
  await expect(walls).toHaveAttribute("title", "Ausblenden");

  // Duplizieren und Löschen.
  await openResources();
  await page.getByTitle("Vorlage duplizieren").click();
  await expect(page.getByTestId("view-template-row")).toHaveCount(2);
  await page.getByTitle("Vorlage löschen").last().click();
  await expect(page.getByTestId("view-template-row")).toHaveCount(1);
});
