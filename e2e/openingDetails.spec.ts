// Fenster/Türen ([105]): Einstellungsdialog (Rahmen-Detail) und Ressourcen-Tab Fenstertypen mit den
// Detail-Feldern. Mit DOSSIER_SHOTS=<ordner> entstehen Screenshots für die Abnahme.
import { expect, elementRows, openSample, openTab, startNewProject, test } from "./app";

test("Fenster-Einstellungen: Rahmen-Detail im Dialog und im Ressourcen-Tab ([105])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: /Fenster/ }).first().click();
  await openTab(page, "Objekt-Info");
  await page.getByRole("button", { name: "Einstellungen …" }).first().click();
  const dialog = page.locator(".oed-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Rahmen-Detail" }).click();
  await expect(dialog.getByText("Pfosten-Breite (m)")).toBeVisible();
  // Dialog passt ins Fenster (kein Überlauf nach rechts/unten).
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  expect(box && vp && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1).toBe(true);
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/fenster-dialog-rahmendetail.png` });
  await dialog.getByRole("button", { name: "Schließen", exact: true }).last().click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Fenstertypen" }).click();
  await page.locator(".rm-detail-group summary").first().click();
  await expect(page.locator(".rm-detail-group").first().getByText("Pfosten-Breite (m)")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/ressourcen-fenstertyp-detail.png` });
});
