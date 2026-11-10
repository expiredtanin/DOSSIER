// [173] Modelldarstellung: eigene Stufe im Ressourcen-Tab anlegen, Sturzlinie „keine" wählen, in der
// Werkzeugleiste (Detailgrad-Wahl) für die aktive Ansicht wählen → die Sturzlinien der Türen verschwinden
// aus dem Grundriss; zurück auf „mittel" sind sie wieder da. Geprüft über die sichtbare UI und den Plan
// (Test-Naht `planLines`), nicht über Pixel.
import { expect, openSample, openTab, test } from "./app";

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
  // 3 eingebaute + die mitgelieferten Standard-Stufen ([173] Etappe 3): Zahl nicht fest annehmen.
  await expect(rows.first()).toBeVisible();
  const n0 = await rows.count();
  expect(n0).toBeGreaterThanOrEqual(3);
  await page.getByTestId("model-view-add").click();
  await expect(rows).toHaveCount(n0 + 1);
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

test("Modelldarstellung im Schnitt: „nur Kern“ zeigt die Wände in Kerndicke ([173] Etappe 2)", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);

  // Eigene Stufe: Wände „nur Kern", Türen/Fenster ohne Schnitt-Detail.
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Modelldarstellung" }).click();
  await page.getByTestId("model-view-add").click();
  await page.getByTestId("model-view-detail").getByRole("textbox", { name: "Name" }).fill("Schnitt Rohbau");
  await expect(page.getByTestId("model-view-section-elevation")).toBeVisible();
  await page.getByTestId("model-view-opt-walls-layers").selectOption("core");
  await page.getByTestId("model-view-opt-windows-sectionDetail").selectOption("false");
  await page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();

  // In den Schnitt wechseln und die Stufe für ihn wählen.
  await openTab(page, "Zeichnungsebenen");
  await page.getByText("Schnitt A", { exact: true }).first().click();
  const walls = () => page.evaluate(() => window.__dossierTest!.sectionWalls());
  const before = await walls();
  expect(before.n).toBeGreaterThan(0);
  const dd = page.getByRole("button", { name: "Detailgrad der Plandarstellung (Symbole, Schraffuren, Linien)" });
  await dd.click();
  await page.getByRole("option", { name: "Schnitt Rohbau" }).click();
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.modelView())).toMatch(/^mv-/);
  await expect.poll(async () => (await walls()).n).toBeLessThan(before.n);
  const after = await walls();
  expect(after.area).toBeLessThan(before.area);
  await page.screenshot({ path: "test-results/modelview-schnitt-kern.png" });

  // Zurück auf „mittel": wie vorher.
  await dd.click();
  await page.getByRole("option", { name: "mittel" }).click();
  await expect.poll(async () => (await walls()).n).toBe(before.n);
});
