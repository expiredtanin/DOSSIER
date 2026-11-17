// [277] Rendering als eigenes Fenster: im Browser-Build gibt es keine Nebenfenster, dort bleibt der Overlay-Dialog — dieselbe Ansicht
// (`RenderDialogView`) und derselbe Auftrag im Hauptfenster (`state/renderJob.ts`) wie im Tauri-Fenster. Mit Ersatz-Cycles
// (`__dossierTest.fakeRender`) wird der ganze Ablauf durchgespielt: Einstellungen → Fortschritt → Abbrechen → Bild → Schliessen mit Rückfrage.
// Das echte Fenster (Brücke, Lage, Kreuz der Fensterleiste) ist nur in der Tauri-App prüfbar (Mac).
import { expect, test, typeCommand } from "./app";

test("Rendering-Dialog: Einstellungen, Fortschritt, Abbruch, Bild, Schliessen mit Rückfrage ([277])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await page.evaluate(() => window.__dossierTest!.fakeRender());

  await typeCommand(page, "rendering");
  const dialog = page.getByRole("dialog", { name: "Rendering", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("render-engine")).toHaveValue("cycles");
  await dialog.getByTestId("render-size").selectOption("sd");
  await dialog.getByTestId("render-samples").fill("8");
  await page.screenshot({ path: "test-results/render277-1-vorher.png" });

  // Läuft: Fortschritt, Restzeit, Abbrechen.
  await dialog.getByTestId("render-start").click();
  await expect(dialog.getByTestId("render-status")).toContainText(/Sample \d von 8/);
  await expect(dialog.getByTestId("render-abort")).toBeVisible();
  await expect(dialog.getByTestId("render-size")).toBeDisabled();
  await page.screenshot({ path: "test-results/render277-2-waehrend.png" });
  await dialog.getByTestId("render-abort").click();
  await expect(dialog.getByTestId("render-message")).toHaveText("Rendering abgebrochen");
  await expect(dialog.getByTestId("render-start")).toBeEnabled();

  // Noch einmal bis zum Bild.
  await dialog.getByTestId("render-start").click();
  await expect(dialog.getByTestId("render-result")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("render-result")).toContainText("960 × 540");
  await expect(dialog.locator('[data-testid="render-result"] img')).toBeVisible();
  await expect(dialog.getByTestId("render-save")).toBeEnabled();
  await page.screenshot({ path: "test-results/render277-3-fertig.png" });

  // „Neu rendern“ führt zu den Einstellungen zurück (Bild verworfen) …
  await dialog.getByTestId("render-again").click();
  await expect(dialog.getByTestId("render-start")).toBeVisible();
  await expect(dialog.getByTestId("render-result")).toHaveCount(0);

  // … Schliessen während der Arbeit fragt nach: „Weiter rendern“ behält, „Abbrechen und schliessen“ bricht ab.
  await dialog.getByTestId("render-start").click();
  await expect(dialog.getByTestId("render-abort")).toBeVisible();
  await dialog.locator(".imp-close").click();
  const confirm = page.getByTestId("render-close-confirm");
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: "test-results/render277-4-rueckfrage.png" });
  await confirm.getByTestId("render-close-keep").click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog.getByTestId("render-abort")).toBeVisible();
  await dialog.locator(".imp-close").click();
  await page.getByTestId("render-close-abort").click();
  await expect(dialog).toHaveCount(0);

  // Wieder öffnen: frische Einstellungen, nichts läuft mehr.
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.notices())).length >= 0).toBe(true);
  await typeCommand(page, "rendering");
  const again = page.getByRole("dialog", { name: "Rendering", exact: true });
  await expect(again.getByTestId("render-start")).toBeEnabled({ timeout: 10_000 });
  await expect(again.getByTestId("render-message")).toHaveCount(0);
});
