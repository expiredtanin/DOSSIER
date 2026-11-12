// Fenster/Türen ([105]): Öffnungs-Editor (Rahmen-Detail) und Ressourcen-Tab Fenstertypen mit den
// Detail-Feldern. Mit DOSSIER_SHOTS=<ordner> entstehen Screenshots für die Abnahme.
import { expect, elementRows, openSample, openTab, startNewProject, test } from "./app";

test("Fenster-Einstellungen: Rahmen-Detail im Editor und im Ressourcen-Tab ([105])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: /Fenster/ }).first().click();
  await openTab(page, "Objekt-Info");
  await page.getByRole("button", { name: "Einstellungen …" }).first().click();
  // Der Öffnungs-Editor ist seit [195b] ein Abschnitt der Objekt-Info (kein Overlay-Dialog mehr).
  const dialog = page.getByTestId("opening-editor").first();
  await dialog.scrollIntoViewIfNeeded();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Rahmen-Detail" }).click();
  await expect(dialog.getByText("Pfosten-Breite (m)")).toBeVisible();
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/fenster-editor-rahmendetail.png` });

  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Fenstertypen" }).click();
  await page.locator(".rm-detail-group summary").first().click();
  await expect(page.locator(".rm-detail-group").first().getByText("Pfosten-Breite (m)")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ressourcen-fenstertyp-detail.png` });
});
