// [264] Sprachumschalter: Einstellungen → Allgemein → Sprache wirkt sofort (Menü, Panel, Dialog), bleibt nach dem
// Neuladen erhalten, und ein NEUES Projekt legt Name, Geschosse, Schnitt/Ansicht und Ebenen in der UI-Sprache an.
// Eigener Port: E2E_PORT=5196 npx playwright test e2e/language264.spec.ts
import { expect, startNewProject, test } from "./app";
import type { Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

async function openSettings(page: Page, windowMenu: string, item: string, dialog: string) {
  await page.getByRole("menubar").getByRole("button", { name: windowMenu, exact: true }).click();
  await page.getByRole("option", { name: item }).click();
  const dlg = page.getByRole("dialog", { name: dialog });
  await expect(dlg).toBeVisible();
  return dlg;
}

test("Sprache umschalten: sofort Englisch, bleibt nach Neuladen, neues Projekt mit englischen Namen", async ({ page }) => {
  test.setTimeout(90_000);
  await startNewProject(page);
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");
  await expect(page.getByRole("button", { name: "Datei", exact: true })).toBeVisible();

  let dlg = await openSettings(page, "Fenster", "Einstellungen", "Einstellungen");
  const select = dlg.getByLabel("Sprache");
  // Vorgabe „Automatisch“: der Test-Browser (de-CH) ergibt Deutsch.
  await expect(select).toHaveValue("auto");
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/lang-de-settings.png`, type: "png" });
  await select.selectOption("en");

  // Sofort wirksam: der geöffnete Dialog selbst und die Menüleiste sind englisch.
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Settings" }).getByLabel("Language")).toHaveValue("en");
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/lang-en-settings.png` : undefined, type: "png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Datei", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menubar").getByRole("button", { name: "Window", exact: true })).toBeVisible();
  // Der Neuaufbau der App löst keinen „unsauber beendet“-Hinweis aus.
  await expect(page.getByText(/did not shut down cleanly/)).toHaveCount(0);
  // Das bestehende Projekt bleibt unverändert (Daten werden nie übersetzt).
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");

  // Neues Projekt über das Datei-Menü: Name, Geschosse und Ebenen englisch.
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("option", { name: /^New Project$/ }).click();
  const discard = page.getByRole("button", { name: "Don't save" });
  if (await discard.waitFor({ timeout: 1500 }).then(() => true, () => false)) await discard.click();
  await expect(page.locator(".project-name")).toHaveText("Empty project");
  await page.getByRole("tab", { name: "Layers", exact: true }).click();
  await expect(page.getByText("Walls", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/lang-en-newproject.png` : undefined, type: "png" });

  // Nach dem Neuladen bleibt die Wahl erhalten.
  await page.reload();
  await expect(page.getByRole("button", { name: "New project" }).first()).toBeVisible();

  // Zurück auf Deutsch.
  await page.getByRole("button", { name: "New project" }).first().click();
  await expect(page.locator(".project-name")).toHaveText("Empty project");
  dlg = await openSettings(page, "Window", "Settings", "Settings");
  await dlg.getByLabel("Language").selectOption("de");
  await expect(page.getByRole("dialog", { name: "Einstellungen" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Datei", exact: true })).toBeVisible();
});
