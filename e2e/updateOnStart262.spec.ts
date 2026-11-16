// [262] Einstellungen → Update: „Beim Start nach Updates suchen“ ist standardmässig aus, bleibt nach dem Neuladen
// erhalten; die Pausen-Auswahl erscheint erst, wenn die Start-Prüfung an ist. Der Knopf „Nach Updates suchen“ bleibt.
// Eigener Port: E2E_PORT=5196 npx playwright test e2e/updateOnStart262.spec.ts
import { expect, startNewProject, test } from "./app";

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

test("Start-Prüfung: Vorgabe aus, einschaltbar, bleibt gespeichert", async ({ page }) => {
  await startNewProject(page);
  const open = async () => {
    await page.getByRole("menubar").getByRole("button", { name: "Fenster", exact: true }).click();
    await page.getByRole("option", { name: "Einstellungen" }).click();
    const dlg = page.getByRole("dialog", { name: "Einstellungen" });
    await dlg.getByRole("tab", { name: "Update" }).click();
    return dlg;
  };
  let dlg = await open();
  const box = dlg.getByRole("checkbox", { name: "Beim Start nach Updates suchen" });
  await expect(box).not.toBeChecked();
  await expect(dlg.getByRole("button", { name: /Nach Updates suchen/ })).toBeVisible();
  await expect(dlg.getByLabel("Prüfung beim Start")).toHaveCount(0);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/update-de-off.png`, type: "png" });
  await box.check();
  await expect(dlg.getByLabel("Prüfung beim Start")).toBeVisible();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/update-de-on.png`, type: "png" });

  await page.reload();
  await page.getByRole("button", { name: "Neues Projekt" }).first().click();
  dlg = await open();
  await expect(dlg.getByRole("checkbox", { name: "Beim Start nach Updates suchen" })).toBeChecked();
  await dlg.getByRole("checkbox", { name: "Beim Start nach Updates suchen" }).uncheck();
  await expect(dlg.getByLabel("Prüfung beim Start")).toHaveCount(0);
});

test("Start-Prüfung auf Englisch", async ({ page }) => {
  await page.goto("/?dossierTest&lang=en");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("menubar").getByRole("button", { name: "Window", exact: true }).click();
  await page.getByRole("option", { name: "Settings" }).click();
  const dlg = page.getByRole("dialog", { name: "Settings" });
  await dlg.getByRole("tab", { name: "Update" }).click();
  await expect(dlg.getByRole("checkbox", { name: "Check for updates on startup" })).not.toBeChecked();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/update-en-off.png`, type: "png" });
});
