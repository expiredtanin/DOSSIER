// [278] Nutzungseinheiten und Wohnungsspiegel: Beispiel Wettbewerb öffnen, Liste und Spiegel im Panel Flächenbilanz,
// Räume einer Einheit zuordnen (Objekt-Info, Mehrfachauswahl = ein Undo), Spiegel als Tabelle auf dem Layout.
// Geprüft über UI-Text und Zahlen, nicht über Pixel; Screenshots für die Sichtprüfung in `test-results/`.
import { discardIfAsked, expect, fileMenu, openTab, test } from "./app";

test("Wohnungsspiegel: Liste, Zuordnen mit Undo, Objekt-Info, Tabelle auf dem Layout ([278])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText("Wettbewerb");

  // Panel Flächenbilanz: sechs Einheiten, Spiegel mit Typen und Summen.
  await openTab(page, "Flächenbilanz");
  const units = page.getByTestId("units-section");
  await expect(units).toBeVisible();
  await expect(units.getByTestId("unit-row")).toHaveCount(6);
  await expect(units.locator(".area-table").first()).toContainText("2.5-Zi-Whg");
  await expect(units.locator(".area-table").first()).toContainText("1. Obergeschoss");
  await units.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "test-results/units278-spiegel.png" });
  await units.locator(".area-block").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "test-results/units278-spiegel-tabelle.png" });

  // Zwei Räume wählen → „Neue Einheit aus Auswahl“: eine Einheit mehr, ein Undo-Schritt.
  await page.evaluate(() => window.__dossierTest!.select({ rooms: ["raum-E.09", "raum-1.09"] }));
  await units.getByRole("button", { name: "Neue Einheit aus Auswahl" }).click();
  await expect(units.getByTestId("unit-row")).toHaveCount(7);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(units.getByTestId("unit-row")).toHaveCount(6);

  // Objekt-Info eines Raums: Feld „Einheit“ zeigt die Wohnung, Wechsel auf „Neue Einheit …“.
  await page.evaluate(() => window.__dossierTest!.select({ rooms: ["raum-E.01"] }));
  await openTab(page, "Objekt-Info");
  const info = page.locator(".objinfo-panel");
  await expect(info.getByText("Nutzungseinheiten und Wohnungsspiegel")).toBeVisible();
  const field = info.locator(".objinfo-field").filter({ hasText: /^Einheit/ });
  await expect(field).toContainText("0.1");
  await field.scrollIntoViewIfNeeded();
  await info.screenshot({ path: "test-results/units278-objektinfo.png" });
  await field.getByRole("button").first().click();
  await page.getByRole("option", { name: "Neue Einheit …" }).click();
  await expect(field).toContainText("Whg 7");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(field).toContainText("0.1");

  // Layout „Wohnungsspiegel“ (Mappe): Tabelle folgt dem Modell.
  await openTab(page, "Mappe");
  await page.locator(".nav-row", { hasText: "Wohnungsspiegel" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
  await expect(page.locator(".layout-sheet-pane")).toContainText("2.5-Zi-Whg");
  await page.screenshot({ path: "test-results/units278-layout.png" });
});
