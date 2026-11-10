// [173] Modelldarstellung: eigene Stufe im Ressourcen-Tab anlegen, Sturzlinie „keine" wählen, in der
// Werkzeugleiste (Detailgrad-Wahl) für die aktive Ansicht wählen → die Sturzlinien der Türen verschwinden
// aus dem Grundriss; zurück auf „mittel" sind sie wieder da. Geprüft über die sichtbare UI und den Plan
// (Test-Naht `planLines`), nicht über Pixel.
import { expect, openSample, test } from "./app";

test("Modelldarstellung: eigene Stufe mit Sturzlinie „keine“ ändert den Grundriss ([173])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);
  const lintels = () => page.evaluate(() => window.__dossierTest!.planLines("door-lintel"));
  const before = await lintels();
  expect(before).toBeGreaterThan(0);

  // Ressourcen → „Modelldarstellung": eingebaute Stufen + neue eigene.
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Modelldarstellung" }).click();
  const rows = page.getByTestId("model-view-row");
  await expect(rows).toHaveCount(3);
  await page.getByTestId("model-view-add").click();
  await expect(rows).toHaveCount(4);
  const detail = page.getByTestId("model-view-detail");
  await detail.getByRole("textbox", { name: "Name" }).fill("Werkplan ohne Sturz");
  await page.getByTestId("model-view-opt-doors-lintelLineStyle").selectOption("keine");
  await expect(page.getByTestId("model-view-opt-doors-lintelLineStyle")).toHaveValue("keine");
  await page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();

  // Werkzeugleiste: Detailgrad-Wahl listet die eigene Stufe.
  const dd = page.getByRole("button", { name: "Detailgrad der Plandarstellung (Symbole, Schraffuren, Linien)" });
  await dd.click();
  await page.getByRole("option", { name: "Werkplan ohne Sturz" }).click();
  await expect(dd).toContainText("Werkplan ohne Sturz");
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.modelView())).toMatch(/^mv-/);
  await expect.poll(lintels).toBe(0);

  // Zurück auf die eingebaute Stufe „mittel": Sturzlinien wie vorher.
  await dd.click();
  await page.getByRole("option", { name: "mittel" }).click();
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.modelView())).toBeUndefined();
  await expect.poll(lintels).toBe(before);
});
